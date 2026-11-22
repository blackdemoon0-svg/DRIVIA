import { useEffect, useRef, useState } from 'react'
import { CloseIcon } from './Icons'

// Sélecteur de voix VEYVRO.
//
// Règle d'honnêteté : un aperçu audio n'est joué QUE s'il correspond réellement à
// la voix. Le serveur fournit `previewUrl` (null tant que l'échantillon n'existe
// pas) ; dans ce cas l'interface l'annonce au lieu de jouer un autre son. Un TTS
// générique ne peut pas servir d'aperçu : ses voix ne sont pas celles de
// GPT-Live.

function VoiceRow({ voice, selected, onSelect, onPreview, playing }) {
  const initials = voice.label.slice(0, 1).toUpperCase()
  return (
    <li className={`voice-row${selected ? ' is-selected' : ''}`}>
      <button
        type="button"
        className="voice-row-main"
        onClick={() => onSelect(voice.id)}
        aria-pressed={selected}
        aria-label={`Choisir la voix ${voice.label}`}
      >
        <span className="voice-avatar" aria-hidden="true">{initials}</span>
        <span className="voice-meta">
          <span className="voice-name">{voice.label}</span>
          <span className="voice-tags">
            {voice.language !== '—' ? voice.language : 'Multilingue'}
            {voice.accent && voice.accent !== '—' ? ` · ${voice.accent}` : ''}
            {' · '}
            {voice.presentation === 'feminine' ? 'voix féminine' : 'voix masculine'}
          </span>
        </span>
      </button>
      {voice.previewUrl ? (
        <button
          type="button"
          className="voice-preview"
          onClick={() => onPreview(voice)}
          aria-label={`Écouter un aperçu de ${voice.label}`}
        >
          {playing ? '■' : '▶'}
        </button>
      ) : (
        <span className="voice-preview is-disabled" title="Aperçu pas encore disponible pour cette voix">
          —
        </span>
      )}
    </li>
  )
}

export default function VoicePicker({
  voices = [],
  selected,
  onSelect,
  onClose,
  loading = false,
  saving = false,
  error = null,
}) {
  const [playing, setPlaying] = useState(null)
  const [notice, setNotice] = useState(null)
  const audioRef = useRef(null)

  useEffect(() => {
    return () => {
      audioRef.current?.pause?.()
      audioRef.current = null
    }
  }, [])

  const preview = (voice) => {
    if (!voice.previewUrl) return
    const audio = audioRef.current ?? new Audio()
    audioRef.current = audio
    if (playing === voice.id) {
      audio.pause()
      setPlaying(null)
      return
    }
    audio.src = voice.previewUrl
    audio.currentTime = 0
    setPlaying(voice.id)
    audio.onended = () => setPlaying(null)
    audio.onerror = () => {
      setPlaying(null)
      setNotice("L'aperçu de cette voix n'a pas pu être chargé.")
    }
    audio.play().catch(() => {
      setPlaying(null)
      setNotice("L'aperçu n'a pas pu être lu par le navigateur.")
    })
  }

  const featured = voices.filter((voice) => voice.featured)
  const others = voices.filter((voice) => !voice.featured)
  const noPreviews = voices.length > 0 && voices.every((voice) => !voice.previewUrl)

  return (
    <div className="voice-picker" role="dialog" aria-modal="true" aria-label="Choisir la voix de VEYVRO">
      <header className="voice-picker-header">
        <div>
          <h2>Voix de VEYVRO</h2>
          <p>
            Votre choix est enregistré sur votre compte. La voix parle toutes les langues : changer de langue ne la
            change pas.
          </p>
        </div>
        <button type="button" className="voice-close" onClick={onClose} aria-label="Fermer">
          <CloseIcon size={18} />
        </button>
      </header>

      {error && <p className="voice-error" role="alert">Impossible de charger vos voix. Réessayez.</p>}
      {notice && <p className="voice-notice" role="status">{notice}</p>}
      {noPreviews && (
        <p className="voice-notice" role="status">
          Les aperçus audio ne sont pas encore disponibles : ils sont enregistrés depuis de vraies sessions et ne
          peuvent pas être simulés. Choisir une voix reste possible.
        </p>
      )}

      {loading ? (
        <p className="voice-loading">Chargement du catalogue…</p>
      ) : voices.length === 0 ? (
        <p className="voice-loading">Aucune voix disponible pour le moment.</p>
      ) : (
        <div className="voice-groups">
          <section>
            <h3>Suggérées</h3>
            <ul className="voice-list">
              {featured.map((voice) => (
                <VoiceRow
                  key={voice.id}
                  voice={voice}
                  selected={voice.id === selected}
                  onSelect={onSelect}
                  onPreview={preview}
                  playing={playing === voice.id}
                />
              ))}
            </ul>
          </section>
          {others.length > 0 && (
            <section>
              <h3>Toutes les voix</h3>
              <ul className="voice-list">
                {others.map((voice) => (
                  <VoiceRow
                    key={voice.id}
                    voice={voice}
                    selected={voice.id === selected}
                    onSelect={onSelect}
                    onPreview={preview}
                    playing={playing === voice.id}
                  />
                ))}
              </ul>
            </section>
          )}
        </div>
      )}

      <footer className="voice-picker-footer">
        <span aria-live="polite">
          {saving ? 'Enregistrement…' : 'Votre voix est appliquée dès la prochaine session vocale.'}
        </span>
        <button type="button" className="voice-done" onClick={onClose}>
          Terminé
        </button>
      </footer>
    </div>
  )
}
