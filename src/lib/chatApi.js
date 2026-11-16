// Contrat d'API chat identique à la production VEYVRO existante.
// POST /api/chat — SSE (text/event-stream), Authorization: Bearer <supabase token>.
// Corps : { messages, attachments?, task? }. Ne pas modifier ce contrat.

export class VeyvroApiError extends Error {
  constructor(status, message, code) {
    super(message)
    this.name = 'VeyvroApiError'
    this.status = status
    this.code = code ?? null
  }
}

// Parse un bloc SSE. Retourne true si le flux est terminé.
export function parseSseBlock(block, onDelta) {
  let event = 'message'
  const dataLines = []
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) event = line.slice(6).trim()
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart())
  }
  if (dataLines.length === 0) return false
  const data = dataLines.join('\n')
  if (data === '[DONE]') return true
  let payload
  try {
    payload = JSON.parse(data)
  } catch {
    throw new VeyvroApiError(502, 'The VEYVRO AI service returned an invalid stream.', 'provider_error')
  }
  if (event === 'error' || typeof payload.error === 'string') {
    const message =
      typeof payload.error === 'string' && payload.error.trim().length > 0
        ? payload.error
        : 'VEYVRO AI is temporarily unavailable.'
    const code = typeof payload.code === 'string' ? payload.code : 'provider_error'
    throw new VeyvroApiError(502, message, code)
  }
  const delta =
    typeof payload.delta === 'string' ? payload.delta : payload.choices?.[0]?.delta?.content
  if (typeof delta === 'string' && delta.length > 0) onDelta(delta)
  return event === 'done'
}

// Trim de l'historique comme en production : 24 derniers messages, 4000 car./message,
// 24 000 caractères au total.
export function trimHistory(messages) {
  const trimmed = messages
    .slice(-24)
    .map((m) => ({ ...m, content: m.content.trim().slice(0, 4000) }))
    .filter((m) => m.content.length > 0)
  let total = trimmed.reduce((acc, m) => acc + m.content.length, 0)
  while (trimmed.length > 1 && total > 24000) {
    total -= trimmed.shift()?.content.length ?? 0
  }
  return trimmed
}

function mapHttpError(payload, status) {
  const code = typeof payload?.code === 'string' ? payload.code : null
  const message = typeof payload?.error === 'string' ? payload.error : null
  if (code === 'auth_required' || status === 401)
    return new VeyvroApiError(401, 'Sign in to VEYVRO to use the chat.', 'auth_required')
  if (code === 'rate_day' || code === 'rate_minute' || status === 429)
    return new VeyvroApiError(
      429,
      message ?? 'Trop de requêtes en peu de temps. Patientez un instant avant de réessayer.',
      code ?? 'rate_limited'
    )
  return new VeyvroApiError(status, message ?? 'The VEYVRO AI service returned an error.', code)
}

// Stream la réponse IA. onDelta reçoit chaque fragment de texte.
export async function streamChat(messages, onDelta, options = {}) {
  const { signal, attachments, accessToken, task } = options
  const payloadMessages = trimHistory(messages)
  if (!accessToken)
    throw new VeyvroApiError(401, 'Sign in to VEYVRO to use the chat.', 'auth_required')

  let response
  try {
    response = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        messages: payloadMessages,
        ...(attachments?.length ? { attachments } : {}),
        ...(task ? { task } : {}),
      }),
      signal,
    })
  } catch (err) {
    if (err?.name === 'AbortError') throw err
    throw new VeyvroApiError(0, 'The VEYVRO AI service could not be reached.')
  }

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    throw mapHttpError(payload, response.status)
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream') || !response.body) {
    throw new VeyvroApiError(404, 'The /api/chat endpoint did not return a response stream.')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let done = false
  let received = false
  const emit = (delta) => {
    received = true
    onDelta(delta)
  }
  try {
    while (!done) {
      const { done: readerDone, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !readerDone })
      buffer = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      let index = buffer.indexOf('\n\n')
      while (index !== -1) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        done = parseSseBlock(block, emit)
        if (done) break
        index = buffer.indexOf('\n\n')
      }
      if (readerDone) {
        if (!done && buffer.trim()) done = parseSseBlock(buffer, emit)
        break
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {})
    if (err instanceof VeyvroApiError || err?.name === 'AbortError') throw err
    throw new VeyvroApiError(0, 'The VEYVRO AI stream was interrupted.')
  } finally {
    reader.releaseLock()
  }
  if (!received)
    throw new VeyvroApiError(502, 'The VEYVRO AI service returned an empty response.', 'empty_response')
  if (!done)
    throw new VeyvroApiError(
      0,
      'La réponse IA a été interrompue avant la fin. / The VEYVRO AI stream ended before the response was complete.',
      'incomplete_stream'
    )
}

// Messages d'erreur utilisateur, alignés sur la production.
export function chatErrorMessage(error) {
  if (!(error instanceof VeyvroApiError)) return 'Une erreur est survenue. Réessayez dans un instant.'
  const code = error.code
  if (code === 'auth_required' || error.status === 401)
    return 'Connectez-vous à VEYVRO pour utiliser le chat.'
  if (code === 'rate_day')
    return "Vous avez atteint votre limite de messages pour aujourd'hui. Elle revient demain à minuit (UTC)."
  if (code === 'rate_minute' || error.status === 429)
    return 'Trop de requêtes en peu de temps. Patientez un instant avant de réessayer.'
  if (code === 'not_configured')
    // Panne serveur certaine : réessayer ne changera rien, le message ne doit pas
    // laisser croire à un incident passager ni au fait que l'utilisateur a mal agi.
    return "Le chat VEYVRO n'est pas encore activé sur le serveur (configuration incomplète). Aucune action de votre part n'est nécessaire : le reste du site reste utilisable."
  if (code === 'identity_unavailable')
    return 'Le service de compte VEYVRO est momentanément indisponible. Réessayez dans un instant.'
  if (code === 'provider_error' || error.status >= 500)
    return 'Le service IA est momentanément indisponible. Réessayez dans un instant.'
  return error.message || 'Une erreur est survenue. Réessayez dans un instant.'
}
