import { useCallback, useEffect, useRef, useState } from 'react'
import { startVoiceSession, endVoiceSession, voiceErrorMessage } from './chatApi'

// Conversation vocale temps réel avec GPT-Live, en WebRTC.
//
// Séquence (documentation officielle, guide WebRTC) :
//   1. getUserMedia(audio) sur une action utilisateur ;
//   2. création du data channel « oai-events » AVANT l'offre SDP ;
//   3. createOffer / setLocalDescription, attente de la fin de collecte ICE ;
//   4. envoi de l'offre à /api/voice-session — le serveur détient la clé ;
//   5. setRemoteDescription(answer) ;
//   6. attente de `session.started` sur le data channel avant d'envoyer quoi que
//      ce soit : on n'envoie JAMAIS `session.start` (le POST HTTP démarre).
//
// Cycle de vie : `stop()` ferme la piste micro, le peer connection, puis appelle
// /api/voice-end pour régler la durée réelle côté serveur. Sans cet appel, la
// session resterait facturée.

const ICE_GATHERING_TIMEOUT_MS = 5000
const DATA_CHANNEL_LABEL = 'oai-events'

function microphoneSupported() {
  return (
    typeof navigator !== 'undefined' &&
    Boolean(navigator.mediaDevices && typeof navigator.mediaDevices.getUserMedia === 'function') &&
    typeof window !== 'undefined' &&
    typeof window.RTCPeerConnection === 'function'
  )
}

/** Message lisible pour un refus de permission micro. */
export function microphoneErrorMessage(error) {
  const name = error?.name
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return "L'accès au microphone a été refusé. Autorisez le micro dans votre navigateur pour parler à VEYVRO."
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Aucun microphone détecté sur cet appareil.'
  if (name === 'NotReadableError')
    return 'Le microphone est déjà utilisé par une autre application.'
  if (name === 'TypeError' || name === 'NotSupportedError')
    return "La conversation vocale n'est pas prise en charge par ce navigateur."
  return 'Impossible de démarrer le microphone.'
}

export function useVoiceLive({ accessToken, voice, history }) {
  const [status, setStatus] = useState('idle') // idle | connecting | live | error
  const [micEnabled, setMicEnabled] = useState(false)
  const [error, setError] = useState(null)
  const [quota, setQuota] = useState(null)
  const [transcript, setTranscript] = useState([])

  const pcRef = useRef(null)
  const streamRef = useRef(null)
  const channelRef = useRef(null)
  const sessionIdRef = useRef(null)
  const audioRef = useRef(null)
  const startingRef = useRef(false)
  // Une session est ouverte : l'état React peut retarder d'un rendu, ce drapeau
  // non. Il empêche deux sessions simultanées, donc deux facturations.
  const activeRef = useRef(false)

  const cleanupPeer = useCallback(async () => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = null
    activeRef.current = false

    try {
      channelRef.current?.close()
    } catch {
      /* déjà fermé */
    }
    channelRef.current = null

    try {
      pcRef.current?.close()
    } catch {
      /* déjà fermé */
    }
    pcRef.current = null

    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null

    if (audioRef.current) {
      audioRef.current.srcObject = null
    }

    // Toujours régler côté serveur : c'est ce qui arrête la facturation.
    if (sessionId && accessToken) {
      await endVoiceSession({ sessionId, accessToken }).catch(() => null)
    }
  }, [accessToken])

  const stop = useCallback(async () => {
    await cleanupPeer()
    setMicEnabled(false)
    setStatus('idle')
  }, [cleanupPeer])

  /** Coupe ou rétablit le micro sans fermer la session (la session reste facturée). */
  const toggleMic = useCallback(() => {
    const stream = streamRef.current
    if (!stream) return
    const next = !micEnabled
    stream.getAudioTracks().forEach((track) => {
      track.enabled = next
    })
    setMicEnabled(next)
  }, [micEnabled])

  const waitForIceGathering = (pc) =>
    new Promise((resolve) => {
      let settled = false
      const done = () => {
        if (settled) return
        settled = true
        pc.removeEventListener('icegatheringstatechange', check)
        resolve()
      }
      const check = () => {
        if (pc.iceGatheringState === 'complete') done()
      }
      if (pc.iceGatheringState === 'complete') return done()
      pc.addEventListener('icegatheringstatechange', check)
      setTimeout(done, ICE_GATHERING_TIMEOUT_MS)
    })

  /**
   * Ouvre une session Live.
   *
   * `voiceOverride` existe pour le changement de voix en cours de session : la
   * nouvelle voix doit être utilisée immédiatement, sans attendre que le parent
   * ait re-rendu avec la nouvelle préférence. Un événement de clic n'est pas un
   * identifiant de voix : tout ce qui n'est pas une chaîne est ignoré.
   */
  const start = useCallback(
    async (voiceOverride) => {
      const sessionVoice = typeof voiceOverride === 'string' && voiceOverride ? voiceOverride : voice
      if (!sessionVoice) return
      if (startingRef.current || activeRef.current) return
      if (!microphoneSupported()) {
        setError("La conversation vocale n'est pas prise en charge par ce navigateur.")
        setStatus('error')
        return
      }
      startingRef.current = true
      setStatus('connecting')
      setError(null)

      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
        streamRef.current = stream

        const pc = new RTCPeerConnection()
        pcRef.current = pc

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
            setError('La connexion vocale a été interrompue. Relancez la conversation.')
            setStatus('error')
            void cleanupPeer()
          }
        }

        const remoteAudio = audioRef.current
        pc.ontrack = (event) => {
          if (remoteAudio) {
            remoteAudio.srcObject = event.streams[0]
            remoteAudio.play?.().catch(() => {
              /* lecture refusée tant que l'utilisateur n'a pas interagi */
            })
          }
        }

        // Le data channel est créé AVANT l'offre : il doit être dans la négociation.
        const channel = pc.createDataChannel(DATA_CHANNEL_LABEL)
        channelRef.current = channel
        channel.addEventListener('message', (event) => {
          let payload
          try {
            payload = JSON.parse(event.data)
          } catch {
            return
          }
          if (typeof payload?.type !== 'string') return
          if (payload.type === 'session.started') {
            setStatus('live')
          }
          const delta = payload?.delta ?? payload?.transcript ?? null
          if (payload.type.endsWith('.delta') && typeof delta === 'string' && delta) {
            setTranscript((prev) => [...prev.slice(-40), { role: 'assistant', text: delta }])
          }
        })

        stream.getTracks().forEach((track) => pc.addTrack(track, stream))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGathering(pc)

        const answer = await startVoiceSession({
          sdp: pc.localDescription?.sdp ?? offer.sdp,
          voice: sessionVoice,
          history,
          accessToken,
        })

        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
        sessionIdRef.current = answer.sessionId
        activeRef.current = true
        setQuota(answer.quota ?? null)
        setMicEnabled(true)
        // `status` passe à « live » sur session.started ; en attendant, on reste
        // en « connecting » pour ne pas promettre une session qui n'a pas démarré.
      } catch (err) {
        const isMediaError =
          typeof err?.name === 'string' &&
          (err.name.startsWith('Not') || err.name === 'TypeError' || err.name === 'SecurityError')
        setError(isMediaError ? microphoneErrorMessage(err) : voiceErrorMessage(err))
        setStatus('error')
        await cleanupPeer()
      } finally {
        startingRef.current = false
      }
    },
    [accessToken, cleanupPeer, history, voice]
  )

  /**
   * Redémarrage propre après changement de voix.
   *
   * La voix est figée dans une session GPT-Live : la seule façon honnête de
   * changer de voix est de fermer la session et d'en ouvrir une nouvelle avec le
   * même contexte. On attend la fermeture avant de rouvrir, sinon deux sessions
   * seraient facturées en parallèle.
   */
  const restartWithVoice = useCallback(
    async (nextVoice) => {
      if (!nextVoice || nextVoice === voice) return
      if (!activeRef.current && status !== 'live' && status !== 'connecting') return
      await cleanupPeer()
      setStatus('connecting')
      if (!accessToken) {
        setStatus('idle')
        return
      }
      await start(nextVoice)
    },
    [accessToken, cleanupPeer, start, status, voice]
  )

  // Fermeture de page : on ne peut pas attendre une réponse HTTP, mais on peut
  // régler la durée avec un `fetch keepalive` (sendBeacon n'envoie pas
  // d'en-tête Authorization).
  useEffect(() => {
    const onHide = () => {
      const sessionId = sessionIdRef.current
      if (!sessionId || !accessToken) return
      try {
        fetch('/api/voice-end', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
          body: JSON.stringify({ sessionId }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* rien de plus à faire à la fermeture */
      }
    }
    window.addEventListener('pagehide', onHide)
    return () => window.removeEventListener('pagehide', onHide)
  }, [accessToken])

  // Nettoyage au démontage : jamais de session ni de micro abandonnés.
  useEffect(() => {
    return () => {
      cleanupPeer()
    }
  }, [cleanupPeer])

  return {
    status,
    micEnabled,
    error,
    quota,
    transcript,
    audioRef,
    start,
    stop,
    toggleMic,
    restartWithVoice,
    supported: microphoneSupported(),
  }
}
