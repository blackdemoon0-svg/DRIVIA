// Service de génération d'images IA — séparé de la logique du chat.
//
// Fournisseurs :
//  - « pollinations » (défaut) : génération réelle via image.pollinations.ai
//    (modèle Sana), sans clé API. Limite gratuite : 1 image / 45 s / IP —
//    gérée ici par une file d'attente et des réessais sur 402.
//  - « backend » : POST /api/image vers le backend VEYVRO (route à ajouter
//    côté serveur pour un fournisseur à clé, ex. Replicate/OpenAI).
//    Voir docs/image-generation.md. Aucune clé n'est exposée au navigateur.
//
// Le service ne devine jamais : il envoie le prompt au fournisseur et
// retourne l'image réellement générée, ou une erreur explicite.

import { nextSeed } from './imageIntent'

export class ImageServiceError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ImageServiceError'
    this.code = code
  }
}

const MAX_PROMPT = 500
const TIMEOUT_MS = 120000
const MAX_RETRIES = 3
const TRANSIENT_RETRIES = 2
const MIN_INTERVAL_MS = 2000

function providerName() {
  const value = (import.meta.env?.VITE_IMAGE_PROVIDER ?? 'pollinations').toLowerCase()
  return value === 'backend' ? 'backend' : 'pollinations'
}

function modelName() {
  return import.meta.env?.VITE_IMAGE_MODEL || 'sana'
}

export function validateImageRequest(request) {
  const prompt = String(request?.prompt ?? '').trim()
  if (!prompt) throw new ImageServiceError('INVALID_PROMPT', 'Le prompt de l\'image est vide.')
  if (prompt.length > MAX_PROMPT) throw new ImageServiceError('INVALID_PROMPT', 'Le prompt est trop long (500 caractères maximum).')
  const width = Number(request?.width) || 1024
  const height = Number(request?.height) || 1024
  if (width < 256 || width > 2048 || height < 256 || height > 2048) {
    throw new ImageServiceError('INVALID_PROMPT', 'Les dimensions demandées ne sont pas prises en charge.')
  }
  return {
    prompt: prompt.replace(/[\u0000-\u001f\u007f]/g, ' '),
    width,
    height,
    seed: Number.isFinite(Number(request?.seed)) ? Math.abs(Math.trunc(Number(request.seed))) % 1000000 : nextSeed(),
    model: String(request?.model ?? modelName()).slice(0, 40),
  }
}

// Base du fournisseur : proxy same-origin (« /img-gen », configuré dans
// vite.config.js en développement et dans vercel.json en production) pour
// éviter les restrictions d'origine. Surchargeable par VITE_IMAGE_PROXY_BASE.
function providerBase() {
  const configured = import.meta.env?.VITE_IMAGE_PROXY_BASE
  return (configured ?? '/img-gen').replace(/\/$/, '')
}

export function buildPollinationsUrl(request) {
  const { prompt, width, height, seed, model } = request
  const params = new URLSearchParams({
    width: String(width),
    height: String(height),
    seed: String(seed),
    model,
    referrer: 'veyvro',
  })
  return `${providerBase()}/prompt/${encodeURIComponent(prompt)}?${params}`
}

// URL publique utilisée pour l'affichage (l'image est servie par le proxy,
// donc l'URL stockée reste relative et fonctionne dans tous les environnements).
export function displayUrl(request) {
  return buildPollinationsUrl(request)
}

// --- File d'attente : sérialise les générations, évite les rafales. --------
let queue = Promise.resolve()
let lastStart = 0

function enqueue(task) {
  const run = queue.then(async () => {
    const wait = MIN_INTERVAL_MS - (Date.now() - lastStart)
    if (wait > 0) await new Promise((r) => setTimeout(r, wait))
    lastStart = Date.now()
    return task()
  })
  // La file continue même si une tâche échoue.
  queue = run.catch(() => {})
  return run
}

function combineSignals(signal, timeoutMs) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const onAbort = () => controller.abort()
  if (signal) {
    if (signal.aborted) controller.abort()
    else signal.addEventListener('abort', onAbort, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
    },
  }
}

function parseRetryAfter(bodyText, headers) {
  const header = headers?.get?.('retry-after')
  if (header && /^\d+$/.test(header)) return Number(header)
  const match = /Retry after (\d+)s/i.exec(bodyText ?? '')
  return match ? Number(match[1]) : 45
}

async function fetchPollinations(request, signal) {
  const url = buildPollinationsUrl(request)
  let attempt = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    attempt++
    const { signal: combined, cleanup } = combineSignals(signal, TIMEOUT_MS)
    let response
    try {
      response = await fetch(url, { signal: combined, headers: { Accept: 'image/*' } })
    } catch (err) {
      cleanup()
      if (err?.name === 'AbortError') {
        if (signal?.aborted) throw err
        throw new ImageServiceError('TIMEOUT', 'La génération a pris trop de temps. Réessayez.')
      }
      throw new ImageServiceError('NETWORK', 'Impossible de joindre le service de génération d\'images.')
    }
    cleanup()

    if (response.status === 402 && attempt <= MAX_RETRIES) {
      // Limite gratuite atteinte : on attend le délai indiqué puis on réessaie.
      const body = await response.text().catch(() => '')
      const waitSeconds = parseRetryAfter(body, response.headers)
      await new Promise((r) => setTimeout(r, (waitSeconds + 1) * 1000))
      continue
    }
    if (response.status === 402) {
      throw new ImageServiceError('RATE_LIMITED', 'Limite gratuite de génération atteinte (1 image / 45 s). Patientez puis réessayez.')
    }
    // 5xx et 429 transitoires : le fournisseur gratuit sature par moments.
    // On réessaie avec un backoff court plutôt que d'échouer immédiatement.
    if ((response.status >= 500 || response.status === 429) && attempt <= TRANSIENT_RETRIES) {
      const backoff = response.status === 429 ? 5000 : 1800 * attempt
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }
    if (!response.ok) {
      throw new ImageServiceError('PROVIDER_ERROR', `Le service de génération a répondu ${response.status}. Réessayez.`)
    }
    const blob = await response.blob()
    if (!blob.type.startsWith('image/')) {
      throw new ImageServiceError('PROVIDER_ERROR', 'Le service n\'a pas renvoyé une image valide.')
    }
    return { blob, remoteUrl: url }
  }
}

async function fetchBackend(request, { signal, getToken } = {}) {
  const { signal: combined, cleanup } = combineSignals(signal, TIMEOUT_MS)
  const headers = { 'Content-Type': 'application/json' }
  const token = typeof getToken === 'function' ? getToken() : null
  if (token) headers.Authorization = `Bearer ${token}`
  let response
  try {
    response = await fetch('/api/image', {
      method: 'POST',
      headers,
      signal: combined,
      body: JSON.stringify({ prompt: request.prompt, width: request.width, height: request.height, seed: request.seed, model: request.model }),
    })
  } catch (err) {
    cleanup()
    if (err?.name === 'AbortError' && !signal?.aborted) {
      throw new ImageServiceError('TIMEOUT', 'La génération a pris trop de temps. Réessayez.')
    }
    throw err
  }
  cleanup()
  // Traitement des cas spécifiques AVANT le cas générique.
  if (response.status === 404) {
    throw new ImageServiceError('NOT_CONFIGURED', 'La génération d\'images n\'est pas encore activée côté serveur.')
  }
  if (response.status === 401 || response.status === 403) {
    throw new ImageServiceError('AUTH_REQUIRED', 'Connectez-vous pour générer une image.')
  }
  if (response.status === 429) {
    const data = await response.json().catch(() => null)
    const retry = Number(data?.retry_after)
    const message = data?.error === 'daily_limit_reached'
      ? `Quota quotidien atteint (${data?.used ?? '?'}/${data?.limit ?? '?'} images). Réessayez demain.`
      : 'Trop de demandes de génération. Réessayez dans quelques secondes.'
    const err = new ImageServiceError('RATE_LIMITED', message)
    err.retryAfter = Number.isFinite(retry) ? retry : 20
    throw err
  }
  if (!response.ok) {
    throw new ImageServiceError('PROVIDER_ERROR', `Le service de génération a répondu ${response.status}. Réessayez.`)
  }
  const data = await response.json().catch(() => null)
  const url = data?.url ?? data?.imageUrl
  if (!url || !/^https?:\/\//.test(url)) {
    throw new ImageServiceError('PROVIDER_ERROR', 'Le serveur n\'a pas renvoyé d\'URL d\'image.')
  }
  return { blob: null, remoteUrl: url, usage: data?.usage ?? null }
}

// Générations en cours, dédupliquées par requête (StrictMode, re-rendus…).
const inflight = new Map()

// Génère réellement une image. Retourne { url (object URL affichable),
// remoteUrl, prompt, seed, width, height, model, provider }.
export async function generateImage(rawRequest, options = {}) {
  const request = validateImageRequest(rawRequest)
  const provider = providerName()
  const key = `${provider}|${request.prompt}|${request.seed}|${request.width}x${request.height}`
  if (inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    const { blob, remoteUrl, usage } = await enqueue(() =>
      provider === 'backend'
        ? fetchBackend(request, options)
        : fetchPollinations(request, options.signal)
    )
    return {
      url: blob ? URL.createObjectURL(blob) : remoteUrl,
      remoteUrl,
      prompt: request.prompt,
      seed: request.seed,
      width: request.width,
      height: request.height,
      model: request.model,
      provider,
      ...(usage ? { usage } : {}),
    }
  })()
  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
}

// --- Format de persistance : bloc ```veyvro-image dans le contenu. ---------
export function imageFence({ status, prompt, seed, width, height, model, url, message }) {
  const data = { status, prompt, seed, width, height, model }
  if (url) data.url = url
  if (message) data.message = message
  return `\`\`\`veyvro-image\n${JSON.stringify(data)}\n\`\`\``
}

// Validation stricte d'un bloc image (utilisée par le parser).
export function validateImageBlock(raw) {
  let data = raw
  if (typeof raw === 'string') {
    if (raw.length > 4000) return null
    try { data = JSON.parse(raw) } catch { return null }
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null
  if (!['pending', 'ready', 'error'].includes(data.status)) return null
  const prompt = typeof data.prompt === 'string' ? data.prompt.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_PROMPT) : ''
  if (!prompt) return null
  const seed = Number.isFinite(Number(data.seed)) ? Math.abs(Math.trunc(Number(data.seed))) % 1000000 : 0
  const width = [576, 1024].includes(Number(data.width)) ? Number(data.width) : 1024
  const height = [576, 1024].includes(Number(data.height)) ? Number(data.height) : 1024
  const model = typeof data.model === 'string' ? data.model.slice(0, 40) : 'sana'
  const out = { status: data.status, prompt, seed, width, height, model }
  if (data.status === 'ready') {
    // URL acceptée : https absolu, ou chemin same-origin du proxy d'images.
    const url = data.url
    const validHttps = typeof url === 'string' && /^https:\/\//.test(url) && url.length <= 2000
    const validProxy = typeof url === 'string' && /^\/(img-gen|api)\/[\w\-./?=&%+,:]+$/.test(url) && url.length <= 2000
    if (!validHttps && !validProxy) return null
    out.url = url
  }
  if (data.status === 'error') {
    out.message = typeof data.message === 'string' ? data.message.slice(0, 300) : 'La génération a échoué.'
  }
  return out
}

// Nettoie l'historique envoyé au modèle : les blocs image deviennent une
// mention textuelle, pour ne pas polluer le contexte de conversation.
export function sanitizeHistoryForApi(messages) {
  if (!Array.isArray(messages)) return messages
  return messages.map((m) => {
    if (m?.role !== 'assistant' || typeof m.content !== 'string' || !m.content.includes('veyvro-image')) return m
    const content = m.content.replace(/```veyvro-image\n[\s\S]*?```/g, (block) => {
      try {
        const data = JSON.parse(block.replace(/```veyvro-image\n|```/g, ''))
        return `[Image générée : ${data.prompt ?? 'image'}]`
      } catch {
        return '[Image générée]'
      }
    })
    return { ...m, content }
  })
}
