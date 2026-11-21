import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAvatar } from '../lib/useAvatar'
import { avatarExtensionFromMime, formatAvatarSize, validateAvatarFile } from '../lib/avatar'
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
//
// Camera : `capture` sur un input file est ignoré par la plupart des
// navigateurs de bureau (le sélecteur de fichiers s'ouvre à la place). On
// demande donc l'accès direct via getUserMedia et on affiche un aperçu vidéo.
// L'input `capture="user"` reste le repli explicite des téléphones.

function hasCoarsePointer() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(pointer: coarse)').matches
}

function cameraAccessMessage(error) {
  const name = error && typeof error === 'object' ? error.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return "L'accès à la caméra a été refusé. Autorisez la caméra dans les réglages du navigateur puis réessayez, ou importez une photo."
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return "Aucune caméra n'a été détectée sur cet appareil. Importez une photo depuis votre galerie."
  }
  if (name === 'NotReadableError' || name === 'TrackStartError') {
    return "La caméra est déjà utilisée par une autre application. Importez une photo depuis votre galerie."
  }
  return "L'accès direct à la caméra n'est pas disponible sur cet appareil. Importez une photo depuis votre galerie."
}

export default function ProfilePhotoDialog({ mode = 'pick', currentUrl, initial = '?', onClose, onDone }) {
  const { busy, error, clearError, saveAvatar, removeAvatar } = useAvatar()
  const [step, setStep] = useState(mode === 'remove' ? 'confirm' : 'source')
  const [file, setFile] = useState(null)
  const [previewUrl, setPreviewUrl] = useState(null)
  const [previewError, setPreviewError] = useState(null)
  const [localError, setLocalError] = useState(null)
  const [cameraStatus, setCameraStatus] = useState('idle') // idle | starting | live | error
  const [cameraError, setCameraError] = useState(null)
  const [mobileCamera] = useState(hasCoarsePointer)
  const galleryRef = useRef(null)
  const cameraRef = useRef(null)
  const videoRef = useRef(null)
  const streamRef = useRef(null)
  const cameraRequestRef = useRef(0)
  const mountedRef = useRef(true)

  const message = localError || error

  const stopCameraStream = useCallback(() => {
    // Invalide toute demande getUserMedia encore en cours.
    cameraRequestRef.current += 1
    const stream = streamRef.current
    streamRef.current = null
    if (stream) {
      for (const track of stream.getTracks()) {
        try {
          track.stop()
        } catch {
          /* piste déjà arrêtée */
        }
      }
    }
    if (videoRef.current) videoRef.current.srcObject = null
  }, [])

  useEffect(() => {
    const onKey = (event) => {
      if (event.key === 'Escape' && !busy) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  // Quitter l'étape caméra coupe immédiatement le flux : la caméra n'est
  // jamais laissée active derrière l'aperçu ou après la fermeture.
  useEffect(() => {
    if (step === 'camera') return undefined
    stopCameraStream()
    setCameraStatus('idle')
    setCameraError(null)
    return undefined
  }, [step, stopCameraStream])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      stopCameraStream()
    }
  }, [stopCameraStream])

  // Le flux ne peut être attaché à la vidéo qu'une fois le <video> monté.
  useEffect(() => {
    if (step !== 'camera' || cameraStatus !== 'live') return undefined
    const video = videoRef.current
    const stream = streamRef.current
    if (!video || !stream) return undefined
    video.srcObject = stream
    const play = () => {
      try {
        const promise = video.play()
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch {
        /* lecture refusée : le navigateur garde l'aperçu figé */
      }
    }
    if (video.readyState >= 1) play()
    else video.addEventListener('loadedmetadata', play, { once: true })
    return () => {
      video.removeEventListener('loadedmetadata', play)
    }
  }, [step, cameraStatus])

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

  // Ouvre réellement la caméra (permission navigateur + aperçu vidéo).
  // Sur ordinateur, c'est le seul chemin qui n'ouvre pas le sélecteur de
  // fichiers. Si getUserMedia est indisponible ou refusé, l'étape caméra
  // affiche un repli explicite (galerie, et capture native sur téléphone).
  const startCamera = async () => {
    if (busy) return
    clearError()
    setLocalError(null)
    setPreviewError(null)
    setCameraError(null)
    setCameraStatus('starting')
    setStep('camera')
    stopCameraStream()

    const mediaDevices = typeof navigator !== 'undefined' ? navigator.mediaDevices : null
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      setCameraStatus('error')
      setCameraError(
        mobileCamera
          ? "L'accès direct à la caméra n'est pas disponible ici. Utilisez l'appareil photo du téléphone ci-dessous, ou importez une photo."
          : "L'accès direct à la caméra n'est pas disponible sur cet appareil (navigateur ou connexion non sécurisée). Importez une photo depuis votre galerie ou vos fichiers."
      )
      return
    }

    const requestId = cameraRequestRef.current
    try {
      const stream = await mediaDevices.getUserMedia({
        audio: false,
        video: {
          // Caméra frontale pour une photo de profil, sans contrainte stricte :
          // un appareil qui n'a qu'une caméra arrière fonctionne quand même.
          facingMode: 'user',
          width: { ideal: 1280 },
          height: { ideal: 1280 },
        },
      })
      if (cameraRequestRef.current !== requestId) {
        for (const track of stream.getTracks()) track.stop()
        return
      }
      streamRef.current = stream
      setCameraStatus('live')
    } catch (err) {
      if (cameraRequestRef.current !== requestId) return
      setCameraStatus('error')
      setCameraError(cameraAccessMessage(err))
    }
  }

  const cancelCamera = () => {
    stopCameraStream()
    setCameraStatus('idle')
    setCameraError(null)
    setStep('source')
  }

  // Fige l'image de l'aperçu vidéo dans un fichier, puis réutilise le même
  // aperçu et le même bouton « Save photo » que pour la galerie.
  const capturePhoto = async () => {
    const video = videoRef.current
    if (!video || cameraStatus !== 'live') return
    setCameraError(null)
    try {
      const sourceWidth = video.videoWidth
      const sourceHeight = video.videoHeight
      if (!sourceWidth || !sourceHeight) {
        setCameraError("La caméra n'a pas encore fourni d'image. Patientez une seconde puis réessayez.")
        return
      }
      const maxDimension = 1280
      const ratio = Math.min(1, maxDimension / Math.max(sourceWidth, sourceHeight))
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(sourceWidth * ratio))
      canvas.height = Math.max(1, Math.round(sourceHeight * ratio))
      const context = canvas.getContext('2d')
      if (!context) throw new Error("La photo n'a pas pu être préparée.")
      context.drawImage(video, 0, 0, canvas.width, canvas.height)
      if (typeof canvas.toBlob !== 'function') throw new Error("La photo n'a pas pu être prise.")
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.9))
      if (!blob || blob.size === 0) throw new Error("La photo n'a pas pu être prise.")
      if (!mountedRef.current) return

      const extension = avatarExtensionFromMime(blob.type)
      const name = `camera-${Date.now()}.${extension}`
      const captured =
        typeof File === 'function'
          ? new File([blob], name, { type: blob.type || 'image/webp', lastModified: Date.now() })
          : Object.assign(blob, { name })
      stopCameraStream()
      setCameraStatus('idle')
      selectFile(captured)
    } catch (err) {
      setCameraError(err instanceof Error ? err.message : "La photo n'a pas pu être prise. Réessayez.")
    }
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

        {/* Toujours montés : le repli caméra et la galerie doivent pouvoir
            ouvrir leur sélecteur depuis n'importe quelle étape du dialogue. */}
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

        {step === 'source' && (
          <>
            <p className="eyebrow"><span className="eyebrow-dot" /> Photo de profil</p>
            <h2 id="avatar-dialog-title">Ajouter une photo</h2>
            <p className="dialog-intro">
              Choisissez une photo de votre galerie ou prenez-en une nouvelle. JPG, PNG ou WEBP · 5 Mo max.
            </p>

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
                onClick={startCamera}
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

        {step === 'camera' && (
          <>
            <p className="eyebrow"><span className="eyebrow-dot" /> Photo de profil</p>
            <h2 id="avatar-dialog-title">Prendre une photo</h2>
            <p className="dialog-intro">
              Cadrez votre visage. L'accès à la caméra est demandé par le navigateur ; aucune image n'est envoyée avant « Save photo ».
            </p>

            {cameraStatus === 'error' ? (
              <div className="avatar-camera-fallback">
                <span className="avatar-camera-fallback-icon"><CameraIcon size={26} /></span>
                <p className="avatar-camera-message" role="alert">{cameraError}</p>
                <div className="avatar-camera-fallback-actions">
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => galleryRef.current?.click()}
                  >
                    <GalleryIcon size={16} /> Choisir une photo
                  </button>
                  {mobileCamera && (
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => cameraRef.current?.click()}
                    >
                      <CameraIcon size={16} /> Appareil photo du téléphone
                    </button>
                  )}
                  <button type="button" className="text-button" onClick={startCamera}>
                    Réessayer
                  </button>
                </div>
              </div>
            ) : (
              <div className={`avatar-camera${cameraStatus === 'live' ? ' is-live' : ''}`}>
                <video
                  ref={videoRef}
                  className="avatar-camera-video"
                  autoPlay
                  playsInline
                  muted
                  aria-label="Aperçu en direct de la caméra"
                />
                {cameraStatus !== 'live' && (
                  <div className="avatar-camera-loading" role="status">
                    <span className="avatar-camera-spinner" aria-hidden="true" />
                    <span>Demande d'accès à la caméra…</span>
                  </div>
                )}
              </div>
            )}

            {cameraStatus !== 'error' && cameraError && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{cameraError}</span>
              </div>
            )}
            {message && (
              <div className="auth-notice is-error" role="alert">
                <AlertIcon size={15} />
                <span>{message}</span>
              </div>
            )}

            <div className="dialog-actions">
              <button type="button" className="secondary-button" onClick={cancelCamera} disabled={busy}>
                Annuler
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={capturePhoto}
                disabled={busy || cameraStatus !== 'live'}
              >
                <CameraIcon size={16} />{' '}
                {cameraStatus === 'live'
                  ? 'Prendre la photo'
                  : cameraStatus === 'error'
                    ? 'Caméra indisponible'
                    : 'Activation…'}
              </button>
            </div>
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
