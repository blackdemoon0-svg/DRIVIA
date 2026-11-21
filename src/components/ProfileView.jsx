import { useState } from 'react'
import { useAuth, useAuthActions } from '../lib/auth'
import { useAvatar } from '../lib/useAvatar'
import {
  UserIcon,
  MailIcon,
  ShieldIcon,
  LogoutIcon,
  CheckIcon,
  ConversationsIcon,
  CameraIcon,
  UploadIcon,
  TrashIcon,
} from './Icons'
import Avatar from './Avatar'
import ProfilePhotoDialog from './ProfilePhotoDialog'

// Profil utilisateur — identité et compte.
// VEYVRO est entièrement gratuit : aucun tarif, aucun abonnement, aucun bouton de
// paiement n'est présenté ici. Le backend Paddle reste déployé côté serveur, mais
// l'interface ne l'appelle pas.
export default function ProfileView({ onSignIn, conversationCount }) {
  const { user, status } = useAuth()
  const { busy, signOut } = useAuthActions()
  const { hasAvatar, avatarUrl } = useAvatar()
  const [photoDialog, setPhotoDialog] = useState(null)
  const [notice, setNotice] = useState(null)

  const openPhotoDialog = (mode) => {
    setNotice(null)
    setPhotoDialog(mode)
  }

  const closePhotoDialog = () => setPhotoDialog(null)

  const handlePhotoDone = (message) => {
    setPhotoDialog(null)
    setNotice(message)
  }

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
          <div className="profile-photo">
            <button
              type="button"
              className="profile-avatar-button"
              onClick={() => openPhotoDialog('pick')}
              aria-label={hasAvatar ? 'Changer la photo de profil' : 'Ajouter une photo de profil'}
            >
              <Avatar
                url={avatarUrl}
                initial={initial}
                className="profile-avatar profile-avatar-lg"
                alt="Votre photo de profil"
              />
              <span className="profile-avatar-overlay" aria-hidden="true">
                <CameraIcon size={19} />
                <span>{hasAvatar ? 'Changer' : 'Ajouter'}</span>
              </span>
              <span className="profile-avatar-badge" aria-hidden="true">
                <CameraIcon size={14} />
              </span>
            </button>
          </div>

          <div className="profile-identity-copy">
            <h2>{user.email?.split('@')[0]}</h2>
            <p>{user.email}</p>

            {hasAvatar ? (
              <div className="profile-photo-actions">
                <button type="button" className="text-button" onClick={() => openPhotoDialog('pick')}>
                  <CameraIcon size={14} /> Changer la photo
                </button>
                <span className="profile-photo-sep" aria-hidden="true">·</span>
                <button
                  type="button"
                  className="text-button is-danger"
                  onClick={() => openPhotoDialog('remove')}
                >
                  <TrashIcon size={14} /> Supprimer
                </button>
              </div>
            ) : (
              <div className="profile-photo-empty">
                <strong>Add a profile pic</strong>
                <button type="button" className="profile-photo-upload" onClick={() => openPhotoDialog('pick')}>
                  <UploadIcon size={15} /> Upload your photo
                </button>
                <span className="profile-photo-hint">JPG, PNG ou WEBP · 5 Mo max</span>
              </div>
            )}
          </div>
        </div>

        {notice && (
          <div className="auth-notice is-success profile-photo-notice" role="status">
            <CheckIcon size={14} />
            <span>{notice}</span>
          </div>
        )}

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

      {photoDialog && (
        <ProfilePhotoDialog
          key={photoDialog}
          mode={photoDialog}
          currentUrl={avatarUrl}
          initial={initial}
          onClose={closePhotoDialog}
          onDone={handlePhotoDone}
        />
      )}
    </div>
  )
}
