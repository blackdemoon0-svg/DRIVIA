import { useEffect, useRef, useCallback, useMemo } from 'react'
import ChatMessage, { ThinkingIndicator } from './ChatMessage'
import ChatComposer from './ChatComposer'
import { HOME_ACTIONS, QUICK_PROMPTS } from '../lib/cars'
import { AlertIcon } from './Icons'

// Vue de conversation : fil de messages centré + barre de saisie toujours visible.
export default function ChatView({
  voiceSlot,
  messages,
  isLoading,
  error,
  onUpdateMessage,
  value,
  onChange,
  onSubmit,
  onStop,
  onOpenQuote,
  onAction,
  onDismissError,
  textareaRef,
  disabled,
}) {
  const scrollRef = useRef(null)
  const bottomRef = useRef(null)
  const stickToBottom = useRef(true)
  const lastContent = messages[messages.length - 1]?.content ?? ''

  // Question associée à chaque réponse : sert à la sélection du format.
  const questions = useMemo(() => {
    let current = ''
    return messages.map((m) => {
      if (m.role === 'user') current = m.content
      return current
    })
  }, [messages])

  // Ne suit le défilement que si l'utilisateur est déjà en bas : on ne lui
  // arrache pas la lecture pendant qu'il consulte un visuel plus haut.
  const onScroll = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120
  }, [])

  useEffect(() => {
    if (!stickToBottom.current) return
    bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages.length, lastContent])

  const showThinking = isLoading && messages[messages.length - 1]?.role === 'assistant' && !messages[messages.length - 1]?.content

  return (
    <div className="chat-view">
      <div
        className="conversation-scroll"
        ref={scrollRef}
        onScroll={onScroll}
        role="log"
        aria-label="Conversation avec VEYVRO"
        aria-live="polite"
      >
        <div className="conversation-inner">
          {messages.map((m, i) =>
            m.role === 'assistant' && !m.content ? null : (
              <ChatMessage
                key={`${m.role}-${i}`}
                message={m}
                question={questions[i]}
                isStreaming={isLoading && i === messages.length - 1}
                onUpdate={onUpdateMessage ? (content) => onUpdateMessage(i, content) : undefined}
              />
            )
          )}
          {showThinking && <ThinkingIndicator />}
          {error && (
            <div className="connection-note" role="alert">
              <AlertIcon size={16} />
              <span>{error}</span>
              <button type="button" onClick={onDismissError} aria-label="Fermer l'alerte">×</button>
            </div>
          )}
          <div ref={bottomRef} />
        </div>
      </div>
      <div className="chat-composer-wrap">
        <ChatComposer
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onStop={onStop}
          isLoading={isLoading}
          onOpenQuote={onOpenQuote}
          onQuickAction={(kind) => {
            const map = { alert: HOME_ACTIONS[1].prompt, car: HOME_ACTIONS[2].prompt, compare: QUICK_PROMPTS[0].prompt }
            onAction(map[kind])
          }}
          textareaRef={textareaRef}
          compact
          disabled={disabled}
          voiceSlot={voiceSlot}
        />
      </div>
    </div>
  )
}
