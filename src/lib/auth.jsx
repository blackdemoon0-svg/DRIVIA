import { createContext, useContext, useEffect, useState, useCallback } from 'react'
import { getSupabase, SupabaseConfigError } from './supabase'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [state, setState] = useState({ status: 'loading', session: null, user: null, message: null, isDemo: false })

  useEffect(() => {
    let cancelled = false
    let subscription = null

    getSupabase()
      .then(async (client) => {
        if (cancelled) return
        const { data } = await client.auth.getSession()
        if (cancelled) return
        setState({
          status: 'ready',
          session: data.session ?? null,
          user: data.session?.user ?? null,
          message: null,
          isDemo: Boolean(client.__demo),
        })
        const { data: sub } = client.auth.onAuthStateChange((_event, session) => {
          setState((prev) => ({
            ...prev,
            session: session ?? null,
            user: session?.user ?? null,
          }))
        })
        subscription = sub.subscription
      })
      .catch((err) => {
        if (cancelled) return
        // Les messages de configuration sont déjà des phrases complètes et exactes :
        // plus de préfixe générique qui masquait la cause réelle.
        const message =
          err instanceof SupabaseConfigError
            ? err.message
            : "Service d'authentification indisponible. Réessayez dans un instant."
        setState({ status: 'error', session: null, user: null, message, isDemo: false })
      })

    return () => {
      cancelled = true
      subscription?.unsubscribe?.()
    }
  }, [])

  const value = { ...state, getSupabase }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

const MIN_PASSWORD = 8

export function validateCredentials(email, password) {
  const e = String(email ?? '').trim().toLowerCase()
  if (!e) return 'Renseignez votre adresse e-mail.'
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e)) return "Cette adresse e-mail n'est pas valide."
  if (!password) return 'Renseignez un mot de passe.'
  if (password.length < MIN_PASSWORD) return `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`
  return null
}

export function authErrorMessage(error) {
  if (error instanceof SupabaseConfigError) return error.message
  const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : '').toLowerCase()
  if (!message) return 'La connexion a échoué. Réessayez dans un instant.'
  if (message.includes('invalid login credentials')) return 'E-mail ou mot de passe incorrect.'
  if (message.includes('email not confirmed'))
    return "Confirmez d'abord votre adresse e-mail : ouvrez le lien reçu par e-mail, puis reconnectez-vous."
  if (message.includes('password should be at least') || message.includes('password is too short'))
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD} caractères.`
  if (message.includes('already registered') || message.includes('already been registered'))
    return 'Un compte existe déjà avec cette adresse. Connectez-vous.'
  if (message.includes('rate limit') || message.includes('too many'))
    return 'Trop de tentatives. Patientez un instant avant de réessayer.'
  return 'La connexion a échoué. Réessayez dans un instant.'
}

// Hook de connexion / inscription / déconnexion, aligné sur les flows Supabase existants.
export function useAuthActions() {
  const { getSupabase: getClient } = useAuth()
  const [busy, setBusy] = useState(false)

  const signIn = useCallback(
    async (email, password) => {
      setBusy(true)
      try {
        const client = await getClient()
        const { error } = await client.auth.signInWithPassword({
          email: String(email).trim().toLowerCase(),
          password,
        })
        if (error) throw error
        return { ok: true }
      } catch (err) {
        return { ok: false, message: authErrorMessage(err) }
      } finally {
        setBusy(false)
      }
    },
    [getClient]
  )

  const signUp = useCallback(
    async (email, password) => {
      setBusy(true)
      try {
        const client = await getClient()
        const { data, error } = await client.auth.signUp({
          email: String(email).trim().toLowerCase(),
          password,
          options: { emailRedirectTo: typeof window !== 'undefined' ? window.location.origin : undefined },
        })
        if (error) throw error
        // Supabase renvoie une session si la confirmation est désactivée, sinon null.
        if (data?.session) return { ok: true, status: 'signed-in' }
        return { ok: true, status: 'confirmation-sent' }
      } catch (err) {
        return { ok: false, message: authErrorMessage(err) }
      } finally {
        setBusy(false)
      }
    },
    [getClient]
  )

  const signOut = useCallback(async () => {
    setBusy(true)
    try {
      const client = await getClient()
      await client.auth.signOut()
      return { ok: true }
    } catch (err) {
      return { ok: false, message: authErrorMessage(err) }
    } finally {
      setBusy(false)
    }
  }, [getClient])

  const resend = useCallback(
    async (email) => {
      try {
        const client = await getClient()
        const { error } = await client.auth.resend({ type: 'signup', email: String(email).trim().toLowerCase() })
        if (error) throw error
        return { ok: true }
      } catch (err) {
        return { ok: false, message: authErrorMessage(err) }
      }
    },
    [getClient]
  )

  return { busy, signIn, signUp, signOut, resend }
}
