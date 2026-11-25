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

// Mémoire de la conversation vocale, conservée entre deux sessions.
//
// Une voix est figée dans une session GPT-Live : changer de voix impose de
// fermer la session et d'en ouvrir une neuve (voir `restartWithVoice`). Sans
// mémoire, VEYVRO repartait de zéro et oubliait tout ce qui venait d'être dit.
//
// La mémoire vit ici, dans le hook, et non dans `chat.messages` : le vocal et
// l'écrit restent deux fils distincts, mais le vocal se souvient de lui-même.
const MAX_VOICE_MEMORY_MESSAGES = 12
const MAX_VOICE_MEMORY_CHARACTERS = 4000

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

/**
 * Rôle d'un événement du data channel, ou `null` s'il n'en porte pas.
 *
 * Les deux événements qui comptent sont les transcriptions finalisées : celle
 * de l'utilisateur (sa parole, transcrite) et celle de l'assistant. Les
 * fragments de streaming sont ignorés — voir `MAX_VOICE_MEMORY_MESSAGES`.
 */
function transcriptRole(payload) {
  if (typeof payload?.role === 'string') {
    if (payload.role === 'user' || payload.role === 'assistant') return payload.role
  }
  if (payload?.type === 'conversation.item.input_audio_transcription.completed') return 'user'
  if (payload?.type === 'response.audio_transcript.done') return 'assistant'
  if (payload?.type === 'response.text.done') return 'assistant'
  return null
}

/**
 * Ajoute un tour à la mémoire vocale, en tenant les deux bornes.
 *
 * `MAX_VOICE_MEMORY_MESSAGES` limite la profondeur du fil ;
 * `MAX_VOICE_MEMORY_CHARACTERS` limite ce que la session suivante recevra. Un
 * long monologue ne doit pas faire exploser la requête de session.
 */
function pushMemory(memory, role, content) {
  const next = [...memory, { role, content }]
  let kept = next.slice(-MAX_VOICE_MEMORY_MESSAGES)
  let total = kept.reduce((sum, message) => sum + message.content.length, 0)
  while (kept.length > 1 && total > MAX_VOICE_MEMORY_CHARACTERS) {
    total -= kept[0].content.length
    kept = kept.slice(1)
  }
  return kept
}

/**
 * Fusionne deux fils sans doublon consécutif.
 *
 * Le parent peut fournir la conversation texte (`history`), la session en cours
 * fournit son propre fil vocal (`voiceHistoryRef`). Les deux sont utiles : le
 * vocal doit reprendre le contexte écrit ET ce qui vient d'être dit à voix
 * haute.
 */
export function mergeVoiceHistory(chatHistory, voiceMemory) {
  const merged = []
  const consider = (role, content) => {
    if (role !== 'user' && role !== 'assistant') return
    if (typeof content !== 'string') return
    const text = content.trim()
    if (!text) return
    const last = merged[merged.length - 1]
    if (last && last.role === role && last.content === text) return
    merged.push({ role, content: text })
  }
  if (Array.isArray(chatHistory)) {
    for (const message of chatHistory) consider(message?.role, message?.content)
  }
  if (Array.isArray(voiceMemory)) {
    for (const message of voiceMemory) consider(message?.role, message?.content)
  }
  return merged
}

export function useVoiceLive({ accessToken, voice, history, onVoiceSubstituted }) {
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
  // Instant où la session a réellement été ouverte, pour pouvoir déclarer une
  // durée si le serveur a perdu la trace (autre instance serverless).
  const startedAtRef = useRef(null)
  // Une session est ouverte : l'état React peut retarder d'un rendu, ce drapeau
  // non. Il empêche deux sessions simultanées, donc deux facturations.
  const activeRef = useRef(false)
  // Fil de la conversation vocale, y compris à travers les changements de voix.
  // Une ref et non un état : la valeur doit être lue au moment exact où la
  // nouvelle session est créée, sans attendre un rendu.
  const voiceHistoryRef = useRef([])

  /** Secondes écoulées depuis l'ouverture de la session, ou null. */
  const elapsedSeconds = () => {
    const startedAt = startedAtRef.current
    if (!startedAt) return null
    return Math.max(0, Math.round((Date.now() - startedAt) / 1000))
  }

  /** Ajoute un tour à la mémoire vocale, sans provoquer de rendu inutile. */
  const appendVoiceMemory = useCallback((role, content) => {
    voiceHistoryRef.current = pushMemory(voiceHistoryRef.current, role, content)
  }, [])

  const cleanupPeer = useCallback(async () => {
    const sessionId = sessionIdRef.current
    const durationSeconds = elapsedSeconds()
    sessionIdRef.current = null
    startedAtRef.current = null
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
    //
    // `durationSeconds` n'est qu'un indice de diagnostic. Le serveur facture
    // `now() - started_at`, mesuré par PostgreSQL : envoyer 0, une valeur
    // négative ou un chiffre énorme ne change rien à ce qui est débité.
    if (sessionId && accessToken) {
      await endVoiceSession({ sessionId, durationSeconds, accessToken }).catch(() => null)
    }
  }, [accessToken])

  const stop = useCallback(async () => {
    await cleanupPeer()
    setMicEnabled(false)
    setStatus('idle')
    // Fin voulue par l'utilisateur : la mémoire vocale est effacée. Elle ne
    // survit qu'aux changements de voix, pas à une conversation terminée.
    voiceHistoryRef.current = []
    setTranscript([])
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
  const startSession = useCallback(
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

          // Mémoire de session : on ne garde que du texte final, jamais des
          // fragments. Un `delta` recopié tel quel produirait un historique
          // haché, où chaque mot serait un message.
          const role = transcriptRole(payload)
          const text =
            payload.type === 'conversation.item.input_audio_transcription.completed' ||
            payload.type === 'response.audio_transcript.done' ||
            payload.type === 'response.text.done'
              ? payload.transcript ?? payload.text ?? null
              : null
          if (role && typeof text === 'string' && text.trim()) {
            appendVoiceMemory(role, text.trim())
          }
        })

        stream.getTracks().forEach((track) => pc.addTrack(track, stream))

        const offer = await pc.createOffer()
        await pc.setLocalDescription(offer)
        await waitForIceGathering(pc)

        // Le contexte transmis est la fusion du fil écrit (fourni par le
        // parent) et du fil vocal de cette conversation. C'est ce qui permet à
        // VEYVRO de garder le fil après un changement de voix.
        const answer = await startVoiceSession({
          sdp: pc.localDescription?.sdp ?? offer.sdp,
          voice: sessionVoice,
          history: mergeVoiceHistory(history, voiceHistoryRef.current),
          accessToken,
        })

        await pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
        sessionIdRef.current = answer.sessionId
        startedAtRef.current = Date.now()
        activeRef.current = true
        setQuota(answer.quota ?? null)

        // Le serveur a refusé l'identifiant demandé et utilisé un autre : on le
        // dit à l'appelant pour qu'il répare la préférence du compte.
        if (answer.voice?.replacedInvalidRequest && typeof onVoiceSubstituted === 'function') {
          onVoiceSubstituted(answer.voice.id)
        }
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
    [accessToken, cleanupPeer, history, onVoiceSubstituted, voice]
  )

  // `startSession` change d'identité à chaque nouvelle voix ou nouveau fil.
  // `restartWithVoice` doit pourtant appeler la PLUS RÉCENTE version : sans
  // cette ref, il appellerait celle capturée au rendu du clic, et la nouvelle
  // session repartirait avec l'ancienne voix. Le bug est silencieux et
  // n'apparaît qu'après un second changement de voix.
  const startRef = useRef(startSession)
  useEffect(() => {
    startRef.current = startSession
  }, [startSession])

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
      await startRef.current(nextVoice)
    },
    [accessToken, cleanupPeer, status, voice]
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
          body: JSON.stringify({ sessionId, durationSeconds: elapsedSeconds() }),
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
    start: startSession,
    stop,
    toggleMic,
    restartWithVoice,
    supported: microphoneSupported(),
  }
}
