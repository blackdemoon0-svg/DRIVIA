import { memo, useState, useEffect, useCallback, useRef } from 'react'
import { generateImage, imageFence } from '../../lib/smart/imageService'
import { nextSeed } from '../../lib/smart/imageIntent'
import { useScene } from '../../lib/scene'
import { ZoomIcon, DownloadIcon, RefreshIcon, CloseIcon, AlertIcon, ImageIcon } from '../Icons'

// Rendu d'une image générée par IA.
// États : génération en cours (squelette), image prête (zoom, téléchargement,
// régénération), erreur (message + nouvel essai). Le contenu persisté est le
// bloc ```veyvro-image ; les actions mettent à jour le message via onUpdate.

function Lightbox({ src, alt, onClose }) {
  const [zoomed, setZoomed] = useState(false)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose() }
    }
    // Capture : l'événement est traité avant les raccourcis globaux de l'app.
    window.addEventListener('keydown', onKey, true)
    // Mémorise l'état précédent plutôt que de forcer '' (le body peut avoir
    // un overflow légitime posé par l'application).
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey, true)
      document.body.style.overflow = previous
    }
  }, [onClose])

  return (
    <div className="sr-lightbox" role="dialog" aria-modal="true" aria-label="Image en plein écran" onClick={onClose}>
      <button type="button" className="sr-lightbox-close" onClick={onClose} aria-label="Fermer">
        <CloseIcon size={20} />
      </button>
      <img
        src={src}
        alt={alt}
        className={zoomed ? 'is-zoomed' : ''}
        onClick={(e) => { e.stopPropagation(); setZoomed((z) => !z) }}
      />
      <span className="sr-lightbox-hint">Cliquez l'image pour zoomer · Échap pour fermer</span>
    </div>
  )
}

export default memo(function GeneratedImage({ data, onUpdate }) {
  const { reducedMotion } = useScene()
  const [displayUrl, setDisplayUrl] = useState(data.url ?? null)
  const [imgLoaded, setImgLoaded] = useState(false)
  const [imgError, setImgError] = useState(false)
  const [busy, setBusy] = useState(false)
  const [slowHint, setSlowHint] = useState(false)
  const [localError, setLocalError] = useState(null)
  const [lightbox, setLightbox] = useState(false)
  const mounted = useRef(true)

  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])

  // Au-delà de 15 s, on explique pourquoi l'attente se prolonge (limite du
  // fournisseur gratuit) au lieu de laisser un squelette muet.
  useEffect(() => {
    const pending = (busy || data.status === 'pending')
    if (!pending) { setSlowHint(false); return undefined }
    const timer = setTimeout(() => setSlowHint(true), 15000)
    return () => clearTimeout(timer)
  }, [busy, data.status])

  useEffect(() => {
    setDisplayUrl(data.url ?? null)
    setImgLoaded(false)
    setImgError(false)
    setLocalError(null)
  }, [data.url, data.seed])

  // Régénération non destructive : l'image affichée reste visible pendant la
  // nouvelle génération. On ne remplace le contenu persisté qu'une fois la
  // nouvelle image prête (ou si l'échec laisse la place vide).
  const runGeneration = useCallback(
    async (request) => {
      if (busy) return
      setBusy(true)
      setLocalError(null)
      try {
        const result = await generateImage(request)
        if (!mounted.current) return
        setDisplayUrl(result.url)
        setImgLoaded(false)
        setImgError(false)
        onUpdate?.(imageFence({ status: 'ready', ...result, url: result.remoteUrl }))
      } catch (err) {
        if (!mounted.current) return
        const message = err?.message ?? 'La génération a échoué.'
        setLocalError(message)
        // Si une image valide est déjà affichée, on la conserve et l'erreur
        // reste locale (pas de perte du résultat précédent).
        if (!displayUrl && !data.url) {
          onUpdate?.(imageFence({ status: 'error', ...request, message }))
        }
      } finally {
        if (mounted.current) setBusy(false)
      }
    },
    [busy, onUpdate, displayUrl, data.url]
  )

  // Un bloc « pending » rechargé (fermeture pendant la génération) relance
  // automatiquement la génération : le bloc est auto-réparant.
  useEffect(() => {
    if (data.status === 'pending') {
      runGeneration({ prompt: data.prompt, seed: data.seed, width: data.width, height: data.height, model: data.model })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.status, data.seed])

  const regenerate = useCallback(() => {
    runGeneration({ prompt: data.prompt, seed: nextSeed(), width: data.width, height: data.height, model: data.model })
  }, [data, runGeneration])

  const download = useCallback(async () => {
    try {
      const res = await fetch(displayUrl ?? data.url)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `veyvro-image-${data.seed}.jpg`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 4000)
    } catch {
      window.open(displayUrl ?? data.url, '_blank', 'noopener')
    }
  }, [displayUrl, data])

  const status = data.status === 'pending' ? 'pending' : data.status
  const errorMessage = localError ?? data.message

  if (status === 'pending') {
    return (
      <figure className="sr-image is-pending">
        <div className={`sr-image-skeleton${reducedMotion ? ' is-static' : ''}`} aria-hidden="true">
          <ImageIcon size={28} />
        </div>
        <figcaption className="sr-image-caption">
          <span className="sr-image-status">
            {slowHint
              ? 'Génération en cours — le fournisseur limite le débit, nouvelle tentative automatique…'
              : "Génération de l'image en cours…"}
          </span>
          <span className="sr-image-prompt">« {data.prompt} »</span>
        </figcaption>
      </figure>
    )
  }

  if (status === 'error' || imgError) {
    return (
      <figure className="sr-image is-error">
        <div className="sr-image-errorbox" role="alert">
          <AlertIcon size={18} />
          <div>
            <strong>Image non générée</strong>
            <p>{errorMessage ?? 'Le service de génération est momentanément indisponible.'}</p>
          </div>
          <button type="button" className="sr-image-action" onClick={() => runGeneration({ prompt: data.prompt, seed: data.seed, width: data.width, height: data.height, model: data.model })}>
            <RefreshIcon size={14} /> Réessayer
          </button>
        </div>
        <figcaption className="sr-image-caption">
          <span className="sr-image-prompt">« {data.prompt} »</span>
        </figcaption>
      </figure>
    )
  }

  return (
    <figure className="sr-image">
      <div className={`sr-image-frame${busy ? ' is-refreshing' : ''}`}>
        {busy && (
          <div className="sr-image-refreshing" role="status">
            <span className="sr-image-status">Nouvelle génération…</span>
          </div>
        )}
        {!imgLoaded && (
          <div className={`sr-image-skeleton${reducedMotion ? ' is-static' : ''}`} aria-hidden="true">
            <ImageIcon size={28} />
          </div>
        )}
        <img
          src={displayUrl ?? data.url}
          alt={`Image générée : ${data.prompt}`}
          loading="lazy"
          className={imgLoaded ? 'is-loaded' : ''}
          onLoad={() => setImgLoaded(true)}
          onError={() => setImgError(true)}
        />
        <button type="button" className="sr-image-zoom" onClick={() => setLightbox(true)} aria-label="Agrandir l'image">
          <ZoomIcon size={16} />
        </button>
      </div>
      <figcaption className="sr-image-caption">
        <span className="sr-image-prompt">« {data.prompt} »</span>
        <span className="sr-image-actions">
          <button type="button" className="sr-image-action" onClick={download}>
            <DownloadIcon size={13} /> Télécharger
          </button>
          <button type="button" className="sr-image-action" onClick={regenerate} disabled={busy}>
            <RefreshIcon size={13} /> {busy ? 'Génération…' : 'Régénérer'}
          </button>
        </span>
      </figcaption>
      {localError && (
        <div className="sr-image-notice" role="status">
          <AlertIcon size={13} /> {localError} — image précédente conservée.
        </div>
      )}
      {lightbox && <Lightbox src={displayUrl ?? data.url} alt={`Image générée : ${data.prompt}`} onClose={() => setLightbox(false)} />}
    </figure>
  )
})
