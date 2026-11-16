import { useState, useRef, useCallback, useEffect } from 'react'
import { useAuth } from './auth'
import { streamChat, chatErrorMessage, VeyvroApiError } from './chatApi'
import { demoStreamChat } from './demo'
import { detectImageIntent } from './smart/imageIntent'
import { generateImage, imageFence, sanitizeHistoryForApi } from './smart/imageService'
import {
  loadConversations,
  createConversation,
  upsertConversation,
  deleteConversation as removeConversation,
  renameConversation as renameStored,
} from './conversations'

// Hook central du chat. Conserve le fonctionnement existant (streaming SSE vers
// /api/chat) et ajoute la persistance locale « Mes conversations ».
export function useChat() {
  const { session, user, isDemo } = useAuth()
  const userId = user?.id ?? null
  const [messages, setMessages] = useState([])
  const [isLoading, setIsLoading] = useState(false)
  const [error, setError] = useState(null)
  const [conversations, setConversations] = useState([])
  const [activeId, setActiveId] = useState(null)
  const abortRef = useRef(null)
  const activeIdRef = useRef(null)
  const messagesRef = useRef([])

  useEffect(() => { messagesRef.current = messages }, [messages])
  useEffect(() => { activeIdRef.current = activeId }, [activeId])

  // Charge l'historique local quand l'utilisateur change.
  useEffect(() => {
    setConversations(loadConversations(userId))
  }, [userId])

  const persist = useCallback(
    (msgs, id) => {
      if (!userId || msgs.length === 0) return
      let convId = id
      if (!convId) {
        const conv = createConversation()
        convId = conv.id
        setActiveId(convId)
      }
      const stored = upsertConversation(userId, { id: convId, messages: msgs, createdAt: Date.now() })
      setConversations(loadConversations(userId))
      return convId
    },
    [userId]
  )

  const stop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // Remplace le contenu d'un message (utilisé par le rendu d'image :
  // régénération, nouvel essai). Persiste la conversation mise à jour.
  const updateMessage = useCallback(
    (index, newContent) => {
      setMessages((prev) => {
        if (index < 0 || index >= prev.length) return prev
        const next = prev.map((m, i) => (i === index ? { ...m, content: newContent } : m))
        messagesRef.current = next
        return next
      })
      setTimeout(() => persist(messagesRef.current, activeIdRef.current), 0)
    },
    [persist]
  )

  const send = useCallback(
    async (text, options = {}) => {
      const content = String(text ?? '').trim()
      if (!content || isLoading) return
      setError(null)
      const userMessage = { role: 'user', content }
      const nextMessages = [...messagesRef.current, userMessage]
      const controller = new AbortController()
      abortRef.current = controller
      const accessToken = session?.access_token ?? null

      // Demande de génération d'image : vraie génération via le service dédié,
      // sans passer par le chat textuel. Le résultat est persisté dans le
      // contenu sous forme de bloc ```veyvro-image.
      const imageRequest = detectImageIntent(content)
      if (imageRequest) {
        setMessages([
          ...nextMessages,
          { role: 'assistant', content: imageFence({ status: 'pending', ...imageRequest }) },
        ])
        setIsLoading(true)
        try {
          const result = await generateImage(imageRequest, {
            signal: controller.signal,
            getToken: () => accessToken,
          })
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role !== 'assistant') return prev
            return [
              ...prev.slice(0, -1),
              { ...last, content: imageFence({ status: 'ready', ...result, url: result.remoteUrl }) },
            ]
          })
        } catch (err) {
          if (err?.name === 'AbortError') {
            // Génération interrompue : on retire la bulle en attente.
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              return last?.role === 'assistant' && last.content.includes('veyvro-image') ? prev.slice(0, -1) : prev
            })
          } else {
            const message = err?.message ?? 'La génération de l\'image a échoué.'
            setMessages((prev) => {
              const last = prev[prev.length - 1]
              if (last?.role !== 'assistant') return prev
              return [
                ...prev.slice(0, -1),
                { ...last, content: imageFence({ status: 'error', ...imageRequest, message }) },
              ]
            })
          }
        } finally {
          setIsLoading(false)
          abortRef.current = null
          setTimeout(() => persist(messagesRef.current, activeIdRef.current), 0)
        }
        return
      }

      setMessages([...nextMessages, { role: 'assistant', content: '' }])
      setIsLoading(true)

      try {
        const onDelta = (delta) => {
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            if (last?.role === 'assistant') {
              return [...prev.slice(0, -1), { ...last, content: last.content + delta }]
            }
            return [...prev, { role: 'assistant', content: delta }]
          })
        }
        const opts = { signal: controller.signal, accessToken, attachments: options.attachments, task: options.task }
        // L'historique envoyé au modèle ne contient pas les blocs image bruts.
        const apiMessages = sanitizeHistoryForApi(nextMessages)
        if (isDemo) await demoStreamChat(apiMessages, onDelta, opts)
        else await streamChat(apiMessages, onDelta, opts)
      } catch (err) {
        if (err?.name === 'AbortError') {
          // Réponse interrompue par l'utilisateur : on garde le contenu partiel.
        } else {
          const message = chatErrorMessage(err)
          setError(message)
          // Retire la bulle assistant vide si rien n'a été reçu.
          setMessages((prev) => {
            const last = prev[prev.length - 1]
            return last?.role === 'assistant' && !last.content ? prev.slice(0, -1) : prev
          })
          if (err instanceof VeyvroApiError && err.status === 401) {
            // Laisse l'interface proposer la connexion.
          }
        }
      } finally {
        setIsLoading(false)
        abortRef.current = null
        // Persiste la conversation terminée.
        setTimeout(() => persist(messagesRef.current, activeIdRef.current), 0)
      }
    },
    [isLoading, session, isDemo, persist]
  )

  const newChat = useCallback(() => {
    stop()
    setMessages([])
    setActiveId(null)
    setError(null)
  }, [stop])

  const openConversation = useCallback(
    (id) => {
      const conv = loadConversations(userId).find((c) => c.id === id)
      if (!conv) return
      stop()
      setMessages(conv.messages)
      setActiveId(id)
      setError(null)
    },
    [userId, stop]
  )

  const deleteConversation = useCallback(
    (id) => {
      const list = removeConversation(userId, id)
      setConversations(list)
      if (activeIdRef.current === id) {
        setMessages([])
        setActiveId(null)
      }
    },
    [userId]
  )

  const renameConversation = useCallback(
    (id, title) => {
      const list = renameStored(userId, id, title)
      setConversations(list)
    },
    [userId]
  )

  return {
    messages,
    isLoading,
    error,
    conversations,
    activeId,
    send,
    updateMessage,
    stop,
    newChat,
    openConversation,
    deleteConversation,
    renameConversation,
    clearError: () => setError(null),
  }
}
