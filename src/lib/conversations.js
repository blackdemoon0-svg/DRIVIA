// Persistance locale des conversations (« Mes conversations »).
// Stockage localStorage par utilisateur — ne touche pas à Supabase.
// Les conversations restent privées au navigateur ; aucune donnée n'est envoyée
// au-delà du strict nécessaire au chat existant.

const PREFIX = 'veyvro.conversations.'
const MAX_CONVERSATIONS = 60

function key(userId) {
  return PREFIX + (userId || 'guest')
}

export function loadConversations(userId) {
  try {
    const raw = localStorage.getItem(key(userId))
    const list = raw ? JSON.parse(raw) : []
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

export function saveConversations(userId, conversations) {
  try {
    const trimmed = conversations.slice(0, MAX_CONVERSATIONS)
    localStorage.setItem(key(userId), JSON.stringify(trimmed))
  } catch {
    /* quota dépassé : on ignore silencieusement */
  }
}

export function createConversation() {
  return {
    id: 'conv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
    title: 'Nouvelle conversation',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
}

export function titleFromMessages(messages) {
  const firstUser = messages.find((m) => m.role === 'user')?.content ?? ''
  const clean = firstUser.replace(/\s+/g, ' ').trim()
  if (!clean) return 'Nouvelle conversation'
  return clean.length > 48 ? clean.slice(0, 48) + '…' : clean
}

export function upsertConversation(userId, conversation) {
  const list = loadConversations(userId)
  const index = list.findIndex((c) => c.id === conversation.id)
  const next = { ...conversation, updatedAt: Date.now(), title: titleFromMessages(conversation.messages) }
  if (index >= 0) list[index] = next
  else list.unshift(next)
  list.sort((a, b) => b.updatedAt - a.updatedAt)
  saveConversations(userId, list)
  return next
}

export function deleteConversation(userId, id) {
  const list = loadConversations(userId).filter((c) => c.id !== id)
  saveConversations(userId, list)
  return list
}

export function renameConversation(userId, id, title) {
  const list = loadConversations(userId)
  const target = list.find((c) => c.id === id)
  if (target) {
    target.title = title.trim().slice(0, 80) || target.title
    target.updatedAt = Date.now()
    saveConversations(userId, list)
  }
  return list
}
