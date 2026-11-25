import { useState, useRef, useCallback, useEffect, useMemo } from 'react'
import { useAuth } from './lib/auth'
import { useChat } from './lib/useChat'
import Scene from './components/scene/Scene'
import Sidebar from './components/Sidebar'
import Topbar from './components/Topbar'
import HomeView from './components/HomeView'
import ChatView from './components/ChatView'
import ConversationsView from './components/ConversationsView'
import BattleView from './components/BattleView'
import AuthView from './components/AuthView'
import ProfileView from './components/ProfileView'
import SettingsView from './components/SettingsView'
import HelpView from './components/HelpView'
import VoiceLiveButton from './components/VoiceLiveButton'
import QuoteDialog from './components/QuoteDialog'
import AboutDialog from './components/AboutDialog'

export default function App() {
  const { user, isDemo, status, session } = useAuth()
  const chat = useChat()
  const [view, setView] = useState('chat')
  const [authMode, setAuthMode] = useState('signin')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [quoteOpen, setQuoteOpen] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)
  const [input, setInput] = useState('')
  const textareaRef = useRef(null)
  const accessToken = session?.access_token ?? null
  const composerDisabled = status === 'loading'

  // Le bouton vocal vit dans la barre de saisie. Il n'est monté que pour une
  // session authentifiée : la clé OpenAI reste côté serveur, et les invités n'ont
  // pas de quota vocal. Une seule instance partagée entre les deux écrans, sinon
  // passer de l'accueil à la conversation couperait la session en cours.
  const voiceHistory = useMemo(
    () =>
      chat.messages
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => ({ role: m.role, content: m.content || '' }))
        .filter((m) => m.content.trim().length > 0),
    [chat.messages]
  )

  const voiceSlot = useMemo(
    () =>
      user ? (
        <VoiceLiveButton session={session} accessToken={accessToken} history={voiceHistory} disabled={composerDisabled} />
      ) : null,
    [user, session, accessToken, voiceHistory, composerDisabled]
  )

  const hasMessages = chat.messages.length > 0
  const isChatSurface = view === 'chat'

  const navigate = useCallback((next) => {
    setView(next)
    setSidebarOpen(false)
  }, [])

  const focusComposer = useCallback(() => {
    setTimeout(() => textareaRef.current?.focus(), 60)
  }, [])

  const goChat = useCallback(() => {
    navigate('chat')
    focusComposer()
  }, [navigate, focusComposer])

  const newChat = useCallback(() => {
    chat.newChat()
    setInput('')
    navigate('chat')
    focusComposer()
  }, [chat, navigate, focusComposer])

  const handleSubmit = useCallback(
    (e) => {
      e?.preventDefault?.()
      const text = input.trim()
      if (!text || chat.isLoading) return
      // En production, le chat nécessite une connexion. En démo locale, il est ouvert.
      if (!user && !isDemo) {
        setAuthMode('signin')
        navigate('auth')
        return
      }
      setInput('')
      if (textareaRef.current) textareaRef.current.style.height = 'auto'
      chat.send(text)
    },
    [input, chat, user, isDemo, navigate]
  )

  const handleAction = useCallback(
    (prompt) => {
      if (!prompt) return
      setInput(prompt)
      navigate('chat')
      focusComposer()
      if (textareaRef.current) {
        requestAnimationFrame(() => {
          const el = textareaRef.current
          if (el) {
            el.style.height = 'auto'
            el.style.height = `${Math.min(el.scrollHeight, 160)}px`
          }
        })
      }
    },
    [navigate, focusComposer]
  )

  const handleQuoteAnalyze = useCallback(
    (file, attachments) => {
      setQuoteOpen(false)
      if (!user && !isDemo) {
        setAuthMode('signin')
        navigate('auth')
        return
      }
      navigate('chat')
      chat.send(`Analyser mon devis de garage : ${file.name}`, { attachments, task: 'garage-quote' })
    },
    [chat, user, isDemo, navigate]
  )

  const openConversation = useCallback(
    (id) => {
      chat.openConversation(id)
      navigate('chat')
    },
    [chat, navigate]
  )

  // Raccourci : Cmd/Ctrl+K pour nouvelle conversation.
  useEffect(() => {
    const onKey = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        newChat()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [newChat])

  return (
    <div className={`app-shell${hasMessages && isChatSurface ? ' is-chatting' : ''}`}>
      <Scene />
      <Sidebar
        view={view}
        onNavigate={navigate}
        onNewChat={newChat}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
      />
      <div className="app-main">
        <Topbar
          onMenu={() => setSidebarOpen(true)}
          onAbout={() => setAboutOpen(true)}
          onProfile={() => navigate(user ? 'profile' : 'auth')}
          view={view}
        />
        <main className={`app-content${isChatSurface ? ' is-chat-surface' : ''}`} id="main">
          {isChatSurface && !hasMessages && (
            <HomeView
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onStop={chat.stop}
              isLoading={chat.isLoading}
              onOpenQuote={() => setQuoteOpen(true)}
              onAction={handleAction}
              textareaRef={textareaRef}
              disabled={composerDisabled}
              voiceSlot={voiceSlot}
            />
          )}
          {isChatSurface && hasMessages && (
            <ChatView
              messages={chat.messages}
              isLoading={chat.isLoading}
              error={chat.error}
              onUpdateMessage={chat.updateMessage}
              value={input}
              onChange={setInput}
              onSubmit={handleSubmit}
              onStop={chat.stop}
              onOpenQuote={() => setQuoteOpen(true)}
              onAction={handleAction}
              onDismissError={chat.clearError}
              textareaRef={textareaRef}
              disabled={composerDisabled}
              voiceSlot={voiceSlot}
            />
          )}
          {view === 'conversations' && (
            <ConversationsView
              conversations={chat.conversations}
              activeId={chat.activeId}
              onOpen={openConversation}
              onDelete={chat.deleteConversation}
              onRename={chat.renameConversation}
              onNew={newChat}
              user={user}
            />
          )}
          {view === 'battle' && <BattleView />}
          {view === 'settings' && <SettingsView />}
          {view === 'help' && <HelpView onStartChat={goChat} />}
          {view === 'profile' && <ProfileView onSignIn={() => { setAuthMode('signin'); navigate('auth') }} conversationCount={chat.conversations.length} />}
          {view === 'auth' && (
            <AuthView
              mode={authMode}
              onModeChange={setAuthMode}
              onSignedIn={() => navigate('chat')}
            />
          )}
        </main>
      </div>

      {quoteOpen && <QuoteDialog onClose={() => setQuoteOpen(false)} onAnalyze={handleQuoteAnalyze} />}
      {aboutOpen && <AboutDialog onClose={() => setAboutOpen(false)} />}
    </div>
  )
}
