import { useScene } from '../lib/scene'
import { useAuth } from '../lib/auth'
import { MenuIcon, MoonIcon, SnowIcon, ReplayIcon, InfoIcon, UserIcon, BrandMark } from './Icons'

// Barre supérieure : menu mobile, indicateur d'ambiance, rejouer, à propos, compte.
export default function Topbar({ onMenu, onAbout, onProfile, view }) {
  const { phase, replay, reducedMotion } = useScene()
  const { user, isDemo } = useAuth()
  const phaseLabel = phase === 'halloween' ? 'Halloween' : phase === 'noel' ? 'Noël' : 'Transition'

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button type="button" className="topbar-menu" onClick={onMenu} aria-label="Ouvrir le menu">
          <MenuIcon size={20} />
        </button>
        <button type="button" className="topbar-brand" onClick={() => onProfile()} aria-label="VEYVRO">
          <BrandMark size={24} />
          <span>VEYVRO</span>
        </button>
      </div>
      <div className="topbar-right">
        {isDemo && <span className="demo-badge" title="Mode démonstration local (backend injoignable)">Démo</span>}
        <span className="topbar-season" title="Ambiance actuelle">
          {phase === 'noel' ? <SnowIcon size={15} /> : <MoonIcon size={15} />}
          <span>{phaseLabel}</span>
        </span>
        <button type="button" className="topbar-icon" onClick={replay} disabled={reducedMotion} aria-label="Rejouer la transition" title="Rejouer la transition">
          <ReplayIcon size={17} />
        </button>
        <button type="button" className="topbar-icon" onClick={onAbout} aria-label="À propos de VEYVRO" title="À propos">
          <InfoIcon size={17} />
        </button>
        <button type="button" className="topbar-profile" onClick={onProfile} aria-label="Profil">
          {user ? <span className="topbar-avatar">{(user.email?.[0] ?? '?').toUpperCase()}</span> : <UserIcon size={18} />}
        </button>
      </div>
    </header>
  )
}
