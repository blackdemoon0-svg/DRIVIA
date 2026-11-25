import Logo from './scene/Logo'
import ChatComposer from './ChatComposer'
import { HOME_ACTIONS, QUICK_PROMPTS } from '../lib/cars'
import { QuoteIcon, AlertIcon, CarIcon, ArrowIcon } from './Icons'

const ACTION_ICONS = { quote: QuoteIcon, alert: AlertIcon, car: CarIcon }

// Écran d'accueil : logo central, accroche, trois points de départ (fonctionnalités
// gratuites existantes), suggestions, et la barre de chat centrale.
export default function HomeView({ value, onChange, onSubmit, onStop, isLoading, onOpenQuote, onAction, textareaRef, disabled, voiceSlot }) {
  return (
    <div className="home-view">
      <div className="home-intro">
        <div className="home-hero">
          <p className="eyebrow"><span className="eyebrow-dot" /> Votre intelligence artificielle automobile</p>
          <Logo />
          <p className="home-description">
            Un devis de garage, un voyant ou une voiture à vérifier ? Choisissez un point de départ
            ou échangez directement avec VEYVRO, votre IA dédiée à l'automobile.
          </p>
        </div>

        <section className="home-actions" aria-labelledby="home-actions-title">
          <div className="home-actions-head">
            <h2 id="home-actions-title">Que souhaitez-vous faire aujourd'hui ?</h2>
            <span className="home-actions-count">01—03</span>
          </div>
          <div className="home-actions-grid">
            {HOME_ACTIONS.map((action) => {
              const Icon = ACTION_ICONS[action.icon]
              return (
                <button
                  key={action.number}
                  type="button"
                  className="action-card"
                  onClick={() => (action.icon === 'quote' ? onOpenQuote() : onAction(action.prompt))}
                >
                  <span className="action-card-head">
                    <span className="action-card-icon"><Icon size={20} /></span>
                    <span className="action-card-number">{action.number}</span>
                  </span>
                  <span className="action-card-title">{action.title}</span>
                  <span className="action-card-description">{action.description}</span>
                  <ArrowIcon size={16} className="action-card-arrow" />
                </button>
              )
            })}
          </div>
        </section>
      </div>

      <div className="home-composer">
        <ChatComposer
          value={value}
          onChange={onChange}
          onSubmit={onSubmit}
          onStop={onStop}
          isLoading={isLoading}
          onOpenQuote={onOpenQuote}
          onQuickAction={(kind) => {
            const map = {
              alert: HOME_ACTIONS[1].prompt,
              car: HOME_ACTIONS[2].prompt,
              compare: QUICK_PROMPTS[0].prompt,
            }
            onAction(map[kind])
          }}
          textareaRef={textareaRef}
          disabled={disabled}
          voiceSlot={voiceSlot}
        />
      </div>

      <div className="quick-prompts">
        <span className="quick-prompts-label">Quelques idées pour commencer</span>
        <div className="quick-prompts-list">
          {QUICK_PROMPTS.map((q) => (
            <button key={q.label} type="button" className="quick-prompt" onClick={() => onAction(q.prompt)}>
              {q.label}
              <ArrowIcon size={13} />
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
