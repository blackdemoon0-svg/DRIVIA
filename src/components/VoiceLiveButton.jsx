import { useState } from 'react'
import { useVoiceLive } from '../lib/useVoiceLive'
import { useVoicePreference } from '../lib/useVoicePreference'
import VoicePicker from './VoicePicker'
import { MicIcon, MicOffIcon } from './Icons'

// Bouton de conversation vocale, posé à côté de la barre de saisie.
//
// Trois états visibles : inactif (micro fermé), en connexion, en direct. Le micro
// peut être coupé sans terminer la session ; « Terminer » ferme la session et
// arrête la facturation. Changer de voix pendant une session redémarre
// proprement la session avec le même contexte.
//
// Rien n'est simulé : si le navigateur ne sait pas faire de WebRTC, le bouton le
// dit au lieu d'afficher un état « en direct » mensonger.

export default function VoiceLiveButton({ session, accessToken, history = [], disabled = false }) {
  const enabled = Boolean(accessToken)
  const { voices, selected, loading, saving, error: preferenceError, choose } = useVoicePreference({
    session,
    accessToken,
  })

  const [pickerOpen, setPickerOpen] = useState(false)
  const [notice, setNotice] = useState(null)
  const [substitutedVoice, setSubstitutedVoice] = useState(null)

  const {
    status,
    micEnabled,
    error,
    quota,
    audioRef,
    start,
    stop,
    toggleMic,
    restartWithVoice,
    supported,
  } = useVoiceLive({
    accessToken,
    voice: selected,
    history,
    // Le serveur valide la voix et peut la remplacer (identifiant retiré du
    // catalogue). On répare alors la préférence du compte : sans cela, la même
    // requête serait refusée puis corrigée à chaque session.
    onVoiceSubstituted: (voiceId) => {
      setSubstitutedVoice(voiceId)
      choose(voiceId)
    },
  })

  // L'élément audio doit exister dans le DOM pour recevoir la piste distante, et
  // un navigateur sans WebRTC doit le dire au lieu d'afficher un bouton mort.
  const unsupported = notice ?? (supported ? null : "La conversation vocale n'est pas prise en charge par ce navigateur.")

  const handleVoiceSelect = async (voiceId) => {
    const result = await choose(voiceId)
    if (!result.ok) {
      setNotice("La voix a été choisie sur cet appareil, mais n'a pas pu être enregistrée sur le compte.")
      return
    }
    setNotice(null)
    // Session active : on la redémarre avec la nouvelle voix, sans perdre le fil.
    if (status === 'live' || status === 'connecting') {
      await restartWithVoice(voiceId)
    }
  }

  if (!enabled) return null

  const live = status === 'live'
  const connecting = status === 'connecting'

  return (
    <>
      <audio ref={audioRef} autoPlay playsInline className="sr-only" aria-hidden="true" />

      <div className="voice-live">
        {!live && !connecting ? (
          <button
            type="button"
            className="composer-icon-button"
            onClick={() => start()}
            disabled={disabled || !supported}
            aria-label="Démarrer une conversation vocale"
            title={supported ? 'Parler à VEYVRO' : 'Non pris en charge par ce navigateur'}
          >
            <MicIcon size={19} />
          </button>
        ) : (
          <div className="voice-live-active" role="group" aria-label="Conversation vocale en cours">
            <button
              type="button"
              className={`composer-icon-button${micEnabled ? ' is-active' : ''}`}
              onClick={toggleMic}
              aria-pressed={micEnabled}
              aria-label={micEnabled ? 'Couper le microphone' : 'Réactiver le microphone'}
              title={micEnabled ? 'Couper le microphone' : 'Réactiver le microphone'}
            >
              {micEnabled ? <MicIcon size={19} /> : <MicOffIcon size={19} />}
            </button>
            <button
              type="button"
              className="voice-live-stop"
              onClick={stop}
              aria-label="Terminer la conversation vocale"
            >
              Terminer
            </button>
            <span className="voice-live-state" aria-live="polite">
              {connecting ? 'Connexion…' : micEnabled ? 'En direct' : 'Micro coupé'}
            </span>
          </div>
        )}

        <button
          type="button"
          className="voice-live-picker"
          onClick={() => setPickerOpen(true)}
          aria-label="Changer la voix de VEYVRO"
          title="Changer la voix"
        >
          Voix
        </button>
      </div>

      {(error || unsupported) && (
        <p className="voice-live-error" role="alert">
          {error || unsupported}
        </p>
      )}
      {substitutedVoice && !error ? (
        <p className="voice-live-quota" role="status">
          Cette voix n'est plus disponible : VEYVRO utilise la voix par défaut.
        </p>
      ) : null}
      {/*
        Le quota n'est affiché que pendant une session. Le chiffre renvoyé au
        démarrage est une photo de l'instant, périmée dès la fermeture : l'afficher
        après coup annoncerait des minutes qui ont déjà été consommées.
      */}
      {quota?.limitMinutes && (live || connecting) ? (
        <p className="voice-live-quota">
          {Math.max(0, Math.floor((quota.remainingSeconds ?? 0) / 60))} min restantes aujourd'hui sur{' '}
          {quota.limitMinutes} min.
        </p>
      ) : null}

      {pickerOpen && (
        <VoicePicker
          voices={voices}
          selected={selected}
          onSelect={handleVoiceSelect}
          onClose={() => setPickerOpen(false)}
          loading={loading}
          saving={saving}
          error={preferenceError}
        />
      )}
    </>
  )
}
