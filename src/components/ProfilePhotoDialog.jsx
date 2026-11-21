import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAvatar } from '../lib/useAvatar'
import { formatAvatarSize, validateAvatarFile } from '../lib/avatar'
import {
  AlertIcon,
  CameraIcon,
  CheckIcon,
  CloseIcon,
  GalleryIcon,
  TrashIcon,
  UploadIcon,
} from './Icons'

// Dialogues de photo de profil :
//  - mode « pick »   : Gallery / Camera → aperçu → « Save photo »
//  - mode « remove » : confirmation de suppression
// Le composant est autonome : il utilise le même magasin d'avatar que la
// Topbar et la Sidebar, donc le changement est visible partout immédiatement.
export default function ProfilePhotoDialog({ mode = 'pick', currentUrl, initial = '?', onClose, onDone }) {
  const { busy, error, clearError, saveAvatar, removeAvatar } = useAvatar()
  const [step, setStep] = useState(mode === 'remove' ? 'confirm' : 'source')
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [localError, setLocalError] = useState(null)
  const galleryRef = useRef(null)
  const cameraRef = useRef(null)

  const message = localError || error

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Aperçu local avant tout envoi. L'URL d'objet est libérée à chaque
  // changement de fichier et au démontage.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null)
      return undefined
    }
    const url = URL.createObjectURL(file)
    setPreviewUrl(url)
    setPreviewError(null)
    return () => URL.revokeObjectURL(url)
  }, [file])

  const selectFile = (next) => {
    if (!next) return
    clearError()
    setLocalError(null)
    setPreviewError(null)
    const invalid = validateAvatarFile(next)
    if (invalid) {
      setFile(null)
      setStep('source')
      setLocalError(invalid)
      return
    }
    setFile(next)
    setStep('preview')
  }

  const onInputChange = (event) => {
    const next = event.currentTarget.files?.[0] ?? null
    // Remise à zéro : le même fichier peut être choisi deux fois de suite.
    event.currentTarget.value = ''
    selectFile(next)
  }

  const chooseAgain = () => {
    if (busy) return
    clearError()
    setLocalError(null)
    setPreviewError(null)
    setFile(null)
    setStep('source')
  }

  const save = async () => {
    if (!file || busy || previewError) return
    const result = await saveAvatar(file)
    if (result?.ok) onDone('Photo de profil mise à jour.')
  }

  const remove = async () => {
    if (busy) return
    const result = await removeAvatar()
    if (result?.ok) onDone('Photo de profil supprimée.')
  }

  const dialog = (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <section
        className="dialog avatar-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="avatar-dialog-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="dialog-close"
          type="button"
          autoFocus
          aria-label="Fermer"
          onClick={onClose}
          disabled={busy}
        >
          <CloseIcon size={18} />
        </button>

        {step === 'source' && (
          <>
            <p className="eyebrow"><span className="eyebrow-dot" /> Photo de profil</p>
            <h2 id="avatar-dialog-title">Ajouter une photo</h2>
            <p className="dialog-intro">
              Choisissez une photo de votre galerie ou prenez-en une nouvelle. JPG, PNG ou WEBP · 5 Mo max.
            </p>

            <input
              ref={galleryRef}
              className="sr-only"
              type="file"
              accept="image/jpeg,image/png,image/webp"
              aria-label="Choisir une photo dans la galerie"
              tabIndex={-1}
              onChange={onInputChange}
            />
            <input
              ref={cameraRef}
              className="sr-only"
              type="file"
              accept="image/*"
              capture="user"
              aria-label="Prendre une photo avec la caméra"
              tabIndex={-1}
              onChange={onInputChange}
            />

            <div className="avatar-source-grid">
              <button
                type="button"
                className="avatar-source-card"
                onClick={() => galleryRef.current?.click()}
                disabled={busy}
              >
                <span className="avatar-source-icon"><GalleryIcon size={24} /></span>
                <strong>Gallery</strong>
                <small>Sélectionner une photo existante</small>
              </button>
              <button
                type="button"
                className="avatar-source-card"
                onClick={() => cameraRef.current?.click()}
                disabled={busy}
              >
                <span className="avatar-source-icon"><CameraIcon size={24} /></span>
                <strong>Camera</strong>
                <small>Prendre une nouvelle photo</small>
              </button>
            </div>

            {message && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{message}</span>
              </div>
            )}

            <button type="button" className="text-button avatar-cancel" onClick={onClose} disabled={busy}>
              Annuler
            </button>
          </>
        )}

        {step === 'preview' && (
          <>
            <p className="eyebrow"><span className="eyebrow-dot" /> Photo de profil</p>
            <h2 id="avatar-dialog-title">Aperçu de votre photo</h2>
            <p className="dialog-intro">
              Vérifiez le cadrage. L'image sera automatiquement redimensionnée (512 px max) et compressée.
            </p>

            <div className={`avatar-preview${previewError ? ' is-broken' : ''}`}>
              {previewUrl && !previewError ? (
                <img
                  src={previewUrl}
                  alt="Aperçu de la photo de profil"
                  onError={() => setPreviewError("Cette image ne peut pas être affichée. Choisissez un autre fichier.")}
                />
              ) : (
                <span className="avatar-preview-fallback">{initial}</span>
              )}
            </div>

            {file && !previewError && (
              <p className="avatar-preview-meta">
                <span className="avatar-preview-name" title={file.name}>{file.name}</span>
                <span>{formatAvatarSize(file.size)}</span>
              </p>
            )}

            {previewError && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{previewError}</span>
              </div>
            )}
            {message && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{message}</span>
              </div>
            )}

            <div className="avatar-preview-actions">
              <button type="button" className="text-button" onClick={chooseAgain} disabled={busy}>
                <UploadIcon size={14} /> Choisir une autre photo
              </button>
            </div>

            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={save}
                disabled={busy || !file || Boolean(previewError)}
              >
                <CheckIcon size={16} /> {busy ? 'Enregistrement…' : 'Save photo'}
              </button>
            </div>
          </>
        )}

        {step === 'confirm' && (
          <>
            <p className="eyebrow"><span className="eyebrow-dot" /> Photo de profil</p>
            <h2 id="avatar-dialog-title">Supprimer la photo ?</h2>
            <p className="dialog-intro">
              Votre photo sera retirée de votre compte VEYVRO. Vous pourrez en ajouter une nouvelle à tout moment.
            </p>

            <div className="avatar-remove-preview">
              {currentUrl ? <img src={currentUrl} alt="Photo de profil actuelle" /> : <span>{initial}</span>}
            </div>

            {message && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{message}</span>
              </div>
            )}

            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>
                Annuler
              </button>
              <button
                type="button"
                className="primary-button avatar-danger-button"
                onClick={remove}
                disabled={busy}
              >
                <TrashIcon size={16} /> {busy ? 'Suppression…' : 'Supprimer la photo'}
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  )

  // Portail vers <body> : le dialogue doit passer au-dessus de la Sidebar et de
  // la Topbar, comme les autres dialogues de l'application.
  if (typeof document === 'undefined') return dialog
  return createPortal(dialog, document.body)
}
