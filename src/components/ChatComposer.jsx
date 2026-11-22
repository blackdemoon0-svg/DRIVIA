import { useRef, useState, useEffect } from 'react'
import { AttachIcon, ToolsIcon, SendIcon, StopIcon, QuoteIcon, AlertIcon, CarIcon, SparklesIcon } from './Icons'

// Barre de saisie centrale — glassmorphism, bordures violettes lumineuses,
// icône pièce jointe, icône outils, bouton d'envoi violet lumineux.
// Placeholder : « Posez votre question à VEYVRO... »
export default function ChatComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  isLoading,
  onOpenQuote,
  onQuickAction,
  textareaRef,
  compact = false,
  disabled = false,
  voiceSlot = null,
}) {
  const [toolsOpen, setToolsOpen] = useState(false)
  const toolsRef = useRef(null)
  const localRef = useRef(null)
  const ref = textareaRef ?? localRef

  useEffect(() => {
    if (!toolsOpen) return
    const onDoc = (e) => {
      if (toolsRef.current && !toolsRef.current.contains(e.target)) setToolsOpen(false)
    }
    const onKey = (e) => e.key === 'Escape' && setToolsOpen(false)
    document.addEventListener('mousedown', onDoc)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDoc)
      document.removeEventListener('keydown', onKey)
    }
  }, [toolsOpen])

  const autoGrow = () => {
    const el = ref.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, compact ? 120 : 160)}px`
  }

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      if (!isLoading && value.trim() && !disabled) onSubmit(e)
    }
  }

  const canSend = value.trim().length > 0 && !isLoading && !disabled

  return (
    <form
      className={`composer${compact ? ' is-compact' : ''}${isLoading ? ' is-loading' : ''}`}
      onSubmit={(e) => {
        e.preventDefault()
        if (canSend) onSubmit(e)
      }}
    >
      <div className="composer-glow" aria-hidden="true" />
      <div className="composer-inner">
        <textarea
          ref={ref}
          className="composer-input"
          rows={1}
          value={value}
          placeholder="Posez votre question à VEYVRO..."
          aria-label="Posez votre question à VEYVRO"
          onChange={(e) => {
            onChange(e.target.value)
            autoGrow()
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
        />
        <div className="composer-bar">
          <div className="composer-actions">
            <button
              type="button"
              className="composer-icon-button"
              onClick={onOpenQuote}
              aria-label="Joindre un devis ou une photo"
              title="Joindre un devis ou une photo"
              disabled={disabled || isLoading}
            >
              <AttachIcon size={19} />
            </button>
            <div className="composer-tools" ref={toolsRef}>
              <button
                type="button"
                className={`composer-icon-button${toolsOpen ? ' is-active' : ''}`}
                onClick={() => setToolsOpen((v) => !v)}
                aria-label="Outils disponibles"
                aria-expanded={toolsOpen}
                title="Outils disponibles"
                disabled={disabled || isLoading}
              >
                <ToolsIcon size={19} />
              </button>
              {toolsOpen && (
                <div className="tools-menu" role="menu">
                  <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); onOpenQuote?.() }}>
                    <QuoteIcon size={17} /><span>Analyser un devis</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); onQuickAction?.('alert') }}>
                    <AlertIcon size={17} /><span>Scanner un voyant / bruit</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); onQuickAction?.('car') }}>
                    <CarIcon size={17} /><span>Vérifier une occasion</span>
                  </button>
                  <button type="button" role="menuitem" onClick={() => { setToolsOpen(false); onQuickAction?.('compare') }}>
                    <SparklesIcon size={17} /><span>Comparer deux voitures</span>
                  </button>
                </div>
              )}
            </div>
            {voiceSlot}
          </div>
          <div className="composer-right">
            <span className="composer-hint">Entrée pour envoyer</span>
            {isLoading ? (
              <button type="button" className="composer-send is-stop" onClick={onStop} aria-label="Arrêter la réponse">
                <StopIcon size={18} />
              </button>
            ) : (
              <button type="submit" className="composer-send" disabled={!canSend} aria-label="Envoyer le message">
                <SendIcon size={19} />
              </button>
            )}
          </div>
        </div>
      </div>
    </form>
  )
}
