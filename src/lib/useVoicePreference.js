import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchVoiceProfiles, saveVoicePreference } from './chatApi'

// Préférence vocale de l'utilisateur.
//
// Deux niveaux, dans cet ordre :
//   1. le COMPTE (raw_user_meta_data.veyvro_voice) — la source de vérité, elle
//      suit l'utilisateur d'un appareil à l'autre ;
//   2. un cache local, pour afficher la bonne voix sans attendre le réseau.
//
// Le catalogue vient du serveur : un identifiant qui disparaît de la
// documentation OpenAI cesse d'être proposé, sans qu'on puisse le réinventer
// côté navigateur.

const CACHE_KEY = 'veyvro.voice.'
const FALLBACK_VOICE = 'brise'

function cacheKey(userId) {
  return CACHE_KEY + (userId || 'guest')
}

function readCache(userId) {
  try {
    return localStorage.getItem(cacheKey(userId))
  } catch {
    return null
  }
}

function writeCache(userId, voiceId) {
  try {
    localStorage.setItem(cacheKey(userId), voiceId)
  } catch {
    /* quota ou navigation privée : le compte reste la source de vérité */
  }
}

export function useVoicePreference({ session, accessToken }) {
  const userId = session?.user?.id ?? null
  const cached = useMemo(() => readCache(userId), [userId])

  const [voices, setVoices] = useState([])
  const [selected, setSelected] = useState(cached || FALLBACK_VOICE)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    let cancelled = false
    const controller = new AbortController()
    setLoading(true)
    fetchVoiceProfiles(accessToken, { signal: controller.signal })
      .then((payload) => {
        if (cancelled) return
        setVoices(Array.isArray(payload?.voices) ? payload.voices : [])
        // Le compte gagne sur le cache : c'est lui qui fait autorité.
        const fromAccount = payload?.selected
        if (fromAccount) {
          setSelected(fromAccount)
          writeCache(userId, fromAccount)
        } else if (payload?.defaultVoice) {
          setSelected((current) => current || payload.defaultVoice)
        }
        setError(null)
      })
      .catch((err) => {
        if (cancelled || err?.name === 'AbortError') return
        // Le catalogue reste vide : l'interface doit le dire, pas inventer.
        setError(err)
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
      controller.abort()
    }
  }, [accessToken, userId])

  /**
   * Choisit une voix. Le cache est mis à jour immédiatement (l'interface réagit),
   * le compte ensuite. Un échec d'enregistrement est signalé : on ne fait pas
   * croire que le choix est durable s'il ne l'est pas.
   */
  const choose = useCallback(
    async (voiceId) => {
      if (!voiceId) return { ok: false }
      const previous = selected
      setSelected(voiceId)
      writeCache(userId, voiceId)
      setSaving(true)
      setError(null)
      try {
        await saveVoicePreference(accessToken, voiceId)
        return { ok: true }
      } catch (err) {
        setError(err)
        // Le choix local reste (l'utilisateur peut réessayer), mais on prévient.
        return { ok: false, error: err, previous }
      } finally {
        setSaving(false)
      }
    },
    [accessToken, selected, userId]
  )

  const current = useMemo(
    () => voices.find((voice) => voice.id === selected) ?? null,
    [selected, voices]
  )

  return { voices, selected, current, loading, saving, error, choose }
}
