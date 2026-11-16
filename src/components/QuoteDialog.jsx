import { useEffect, useRef, useState } from 'react'
import { prepareAttachments, validateFile, formatBytes, isPdf } from '../lib/attachments'
import { CloseIcon, QuoteIcon, AttachIcon } from './Icons'

// Import de devis / facture — fonctionnalité existante conservée (PDF + images,
// 12 Mo max, rendu des pages PDF en images avant envoi).
export default function QuoteDialog({ onClose, onAnalyze }) {
  const [file, setFile] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && !busy && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const pick = (f) => {
    if (!f || busy) return
    const invalid = validateFile(f)
    if (invalid) {
      setFile(null)
      setError(invalid)
    } else {
      setFile(f)
      setError(null)
    }
  }

  const analyze = async () => {
    if (!file || busy) return
    setBusy(true)
    setError(null)
    try {
      const attachments = await prepareAttachments(file)
      onAnalyze(file, attachments)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Impossible de préparer ce document.')
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onMouseDown={() => !busy && onClose()}>
      <section className="dialog quote-dialog" role="dialog" aria-modal="true" aria-labelledby="quote-title" onMouseDown={(e) => e.stopPropagation()}>
        <button className="dialog-close" type="button" autoFocus aria-label="Fermer" onClick={onClose} disabled={busy}>
          <CloseIcon size={18} />
        </button>
        <p className="eyebrow"><span className="eyebrow-dot" /> Analyse de devis</p>
        <h2 id="quote-title">Importez votre devis ou votre facture.</h2>
        <p className="dialog-intro">Ajoutez une photo nette ou un PDF lisible pour obtenir une première lecture des lignes et des montants.</p>

        <input
          ref={inputRef}
          className="sr-only"
          id="quote-file"
          type="file"
          accept=".pdf,application/pdf,image/jpeg,image/png,image/webp,image/avif,image/heic,image/heif"
          onChange={(e) => { pick(e.currentTarget.files?.[0]); e.currentTarget.value = '' }}
          disabled={busy}
        />

        <div
          className={`quote-dropzone${dragging ? ' is-dragging' : ''}${file ? ' has-file' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget)) setDragging(false) }}
          onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files[0]) }}
        >
          {file ? (
            <div className="quote-file-summary">
              <span className="quote-file-badge">{isPdf(file) ? 'PDF' : 'IMG'}</span>
              <span className="quote-file-meta">
                <strong title={file.name}>{file.name}</strong>
                <small>{formatBytes(file.size)} · prêt à analyser</small>
              </span>
              <span className="quote-file-actions">
                <label className="text-button" htmlFor="quote-file">Remplacer</label>
                <button type="button" className="text-button" onClick={() => { setFile(null); setError(null) }} disabled={busy}>Retirer</button>
              </span>
            </div>
          ) : (
            <label className="quote-drop-prompt" htmlFor="quote-file">
              <span className="quote-upload-icon"><AttachIcon size={26} /></span>
              <span className="quote-drop-title">Glissez votre document ici</span>
              <span className="quote-drop-sub">ou cliquez pour parcourir — JPG, PNG, WebP, HEIC, AVIF ou PDF · 12 Mo max</span>
            </label>
          )}
        </div>

        {error && <div className="auth-notice is-error" role="alert">{error}</div>}

        <div className="dialog-actions">
          <button type="button" className="secondary-button" onClick={onClose} disabled={busy}>Annuler</button>
          <button type="button" className="primary-button" onClick={analyze} disabled={!file || busy}>
            <QuoteIcon size={16} /> {busy ? 'Préparation…' : 'Analyser le devis'}
          </button>
        </div>
      </section>
    </div>
  )
}
