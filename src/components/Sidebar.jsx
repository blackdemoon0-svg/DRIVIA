import { BrandMark, ChatIcon, ConversationsIcon, SettingsIcon, HelpIcon, UserIcon, BattleIcon, PlusIcon, CloseIcon, SparklesIcon } from './Icons'
import { useAuth } from '../lib/auth'

// Barre latérale sombre et élégante. Navigation demandée : Chat, Mes conversations,
// Paramètres, Aide et Support, Profil. Aucun élément d'abonnement / offre commerciale.
const NAV = [
  { id: 'chat', label: 'Chat', Icon: ChatIcon },
  { id: 'conversations', label: 'Mes conversations', Icon: ConversationsIcon },
  { id: 'battle', label: 'VEYVRO Battle', Icon: BattleIcon },
  { id: 'settings', label: 'Paramètres', Icon: SettingsIcon },
  { id: 'help', label: 'Aide et Support', Icon: HelpIcon },
]

export default function Sidebar({ view, onNavigate, onNewChat, open, onClose }) {
  const { user } = useAuth()
  const initial = (user?.email?.[0] ?? '?').toUpperCase()

  return (
    <>
      <div className={`sidebar-scrim${open ? ' is-visible' : ''}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sidebar${open ? ' is-open' : ''}`} aria-label="Navigation principale">
        <div className="sidebar-head">
          <button className="sidebar-brand" type="button" onClick={() => onNavigate('chat')} aria-label="VEYVRO — accueil">
            <BrandMark size={30} />
            <span className="sidebar-brand-text">VEYVRO<span className="brand-dot">.</span></span>
          </button>
          <button className="sidebar-close" type="button" onClick={onClose} aria-label="Fermer le menu">
            <CloseIcon size={18} />
          </button>
        </div>

        <button className="new-chat-button" type="button" onClick={onNewChat}>
          <PlusIcon size={17} />
          <span>Nouvelle conversation</span>
        </button>

        <nav className="sidebar-nav" aria-label="Sections">
          <span className="sidebar-section-label">Navigation</span>
          {NAV.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`sidebar-link${view === id ? ' is-active' : ''}`}
              aria-current={view === id ? 'page' : undefined}
              onClick={() => onNavigate(id)}
            >
              <Icon size={19} />
              <span>{label}</span>
              {view === id && <span className="sidebar-link-glow" aria-hidden="true" />}
            </button>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-season" aria-hidden="true">
            <SparklesIcon size={15} />
            <span>Édition Hiver</span>
          </div>
          <button
            type="button"
            className={`sidebar-profile${view === 'profile' ? ' is-active' : ''}`}
            onClick={() => onNavigate('profile')}
            aria-current={view === 'profile' ? 'page' : undefined}
          >
            <span className="sidebar-avatar">{user ? initial : <UserIcon size={17} />}</span>
            <span className="sidebar-profile-meta">
              <span className="sidebar-profile-name">{user ? user.email?.split('@')[0] : 'Invité'}</span>
              <span className="sidebar-profile-sub">{user ? 'Profil utilisateur' : 'Se connecter'}</span>
            </span>
          </button>
        </div>
      </aside>
    </>
  )
}
