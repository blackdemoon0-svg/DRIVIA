import { useAuth, useAuthActions } from '../lib/auth'
import { UserIcon, MailIcon, ShieldIcon, LogoutIcon, CheckIcon, ConversationsIcon } from './Icons'

// Profil utilisateur — identité et compte.
// VEYVRO est entièrement gratuit : aucun tarif, aucun abonnement, aucun bouton de
// paiement n'est présenté ici. Le backend Paddle reste déployé côté serveur, mais
// l'interface ne l'appelle pas.
export default function ProfileView({ onSignIn, conversationCount }) {
  const { user, status } = useAuth()
  const { busy, signOut } = useAuthActions()

  if (status === 'loading') {
    return <div className="page-view"><div className="empty-state"><p>Vérification de votre session…</p></div></div>
  }

  if (!user) {
    return (
      <div className="page-view">
        <header className="page-head">
          <p className="eyebrow"><span className="eyebrow-dot" /> Espace personnel</p>
          <h1>Votre <span>profil</span></h1>
        </header>
        <div className="empty-state">
          <UserIcon size={34} />
          <h2>Vous n'êtes pas connecté</h2>
          <p>Connectez-vous pour utiliser le chat et retrouver vos conversations.</p>
          <button type="button" className="primary-button" onClick={onSignIn}>Se connecter</button>
        </div>
      </div>
    )
  }

  const confirmed = Boolean(user.email_confirmed_at)
  const initial = (user.email?.[0] ?? '?').toUpperCase()

  return (
    <div className="page-view">
      <header className="page-head">
        <p className="eyebrow"><span className="eyebrow-dot" /> Espace personnel</p>
        <h1>Mon <span>profil</span></h1>
        <p className="page-subtitle">Votre identité VEYVRO.</p>
      </header>

      <div className="profile-card">
        <div className="profile-identity">
          <span className="profile-avatar">{initial}</span>
          <div>
            <h2>{user.email?.split('@')[0]}</h2>
            <p>{user.email}</p>
          </div>
        </div>
        <dl className="profile-rows">
          <div className="profile-row">
            <dt><MailIcon size={16} /> Adresse e-mail</dt>
            <dd>{user.email ?? 'Adresse inconnue'}</dd>
          </div>
          <div className="profile-row">
            <dt><ShieldIcon size={16} /> Adresse</dt>
            <dd className={confirmed ? 'is-ok' : 'is-pending'}>
              {confirmed ? <><CheckIcon size={14} /> Confirmée</> : 'En attente de confirmation'}
            </dd>
          </div>
          <div className="profile-row">
            <dt><ConversationsIcon size={16} /> Conversations</dt>
            <dd>{conversationCount} enregistrée{conversationCount > 1 ? 's' : ''} sur cet appareil</dd>
          </div>
          <div className="profile-row">
            <dt><CheckIcon size={16} /> Accès</dt>
            <dd className="is-ok"><CheckIcon size={14} /> Toutes les fonctionnalités, sans abonnement</dd>
          </div>
        </dl>
        <button type="button" className="secondary-button profile-signout" onClick={signOut} disabled={busy}>
          <LogoutIcon size={16} /> {busy ? 'Déconnexion…' : 'Se déconnecter'}
        </button>
      </div>
    </div>
  )
}
