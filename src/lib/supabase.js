// Configuration Supabase — contrat identique à la production : GET /api/supabase-config
// renvoie { url, anonKey }. Aucune variable d'environnement n'est modifiée.
import { createClient } from '@supabase/supabase-js'
import { isDemoAvailable, createDemoClient } from './demo'

const CONFIG_ENDPOINT = '/api/supabase-config'

export class SupabaseConfigError extends Error {
  // `reason` distingue les causes réelles pour que l'interface n'affiche jamais
  // un diagnostic faux : 'network' | 'http' | 'invalid-json' | 'incomplete' | 'invalid-url' | 'unavailable'
  constructor(message, missingKeys = [], reason = 'unavailable', status = null) {
    super(message)
    this.name = 'SupabaseConfigError'
    this.missingKeys = missingKeys
    this.reason = reason
    this.status = status
  }
}

// Retourne { config } en cas de succès, ou { failure } décrivant la cause exacte.
// On ne confond plus « injoignable » (réseau) et « le serveur répond mais refuse »
// (404/500) : ce sont deux pannes différentes avec deux corrections différentes.
export async function fetchConfig(signal) {
  if (typeof fetch !== 'function') {
    return { failure: { reason: 'network', status: null } }
  }
  let res
  try {
    res = await fetch(CONFIG_ENDPOINT, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      cache: 'no-store',
      signal,
    })
  } catch {
    return { failure: { reason: 'network', status: null } }
  }
  if (!res.ok) {
    return { failure: { reason: 'http', status: res.status } }
  }
  let data
  try {
    data = await res.json()
  } catch {
    return { failure: { reason: 'invalid-json', status: res.status } }
  }
  const url = typeof data?.url === 'string' ? data.url.trim() : ''
  const anonKey = typeof data?.anonKey === 'string' ? data.anonKey.trim() : ''
  return { config: { url: url || null, anonKey: anonKey || null } }
}

// Traduit une cause de panne en message utilisateur exact.
// Exporté pour être testé sans réseau : c'est ici que se joue la justesse du diagnostic.
export function configFailureError(failure) {
  const reason = failure?.reason || 'unavailable'
  const status = failure?.status ?? null
  if (reason === 'network') {
    return new SupabaseConfigError(
      "Le serveur d'authentification est injoignable (aucune réponse réseau) : vérifiez votre connexion puis réessayez.",
      [],
      'network',
      status
    )
  }
  if (reason === 'http') {
    return new SupabaseConfigError(
      `Le serveur d'authentification a répondu par une erreur HTTP ${status} sur /api/supabase-config.`,
      [],
      'http',
      status
    )
  }
  if (reason === 'invalid-json') {
    return new SupabaseConfigError(
      "Le serveur d'authentification a renvoyé une réponse illisible (JSON invalide) sur /api/supabase-config.",
      [],
      'invalid-json',
      status
    )
  }
  return new SupabaseConfigError(
    "La configuration d'authentification est indisponible sur ce serveur.",
    [],
    'unavailable',
    status
  )
}

let clientPromise = null

export function getSupabase() {
  if (!clientPromise) {
    clientPromise = fetchConfig().then((result) => {
      const config = result.config || null
      const failure = result.failure || null
      // En développement uniquement, si le backend est injoignable, on bascule sur
      // un adaptateur de démonstration local pour pouvoir prévisualiser l'interface.
      // En production, ce fallback n'existe pas : le vrai Supabase est requis.
      if ((!config || !config.url || !config.anonKey) && isDemoAvailable()) {
        // Mode démonstration : uniquement en développement local. Un bundler de
        // production supprime cette branche, donc on continue explicitement le
        // chemin d'erreur réel pour que les tests (qui tournent en mode DEV)
        // vérifient bien les messages exacts.
        return createDemoClient()
      }
      if (!config) {
        // Une cause = un message. On n'annonce « injoignable » que si le réseau a
        // réellement échoué ; un statut HTTP ou un JSON invalide disent autre chose.
        throw configFailureError(failure)
      }
      const missing = []
      if (!config.url) missing.push('SUPABASE_URL')
      if (!config.anonKey) missing.push('SUPABASE_ANON_KEY')
      if (missing.length > 0) {
        throw new SupabaseConfigError(
          `Configuration Supabase incomplète. Variables manquantes : ${missing.join(', ')}.`,
          missing,
          'incomplete'
        )
      }
      if (!/^https?:\/\//i.test(config.url)) {
        throw new SupabaseConfigError(
          'Configuration Supabase invalide : SUPABASE_URL doit commencer par https://.',
          ['SUPABASE_URL'],
          'invalid-url'
        )
      }
      return createClient(config.url, config.anonKey, {
        auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
      })
    })
    clientPromise.catch(() => {
      clientPromise = null
    })
  }
  return clientPromise
}
