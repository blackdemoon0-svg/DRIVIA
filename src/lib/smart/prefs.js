// Préférence utilisateur « Smart Responses ».
// Désactivable depuis les paramètres → repli markdown strict.

const KEY = 'veyvro.smartResponses'
const listeners = new Set()

export function isSmartEnabled() {
  try {
    return localStorage.getItem(KEY) !== '0'
  } catch {
    return true
  }
}

export function setSmartEnabled(value) {
  try {
    localStorage.setItem(KEY, value ? '1' : '0')
  } catch {
    /* stockage indisponible */
  }
  listeners.forEach((cb) => cb(value))
}

export function onSmartChange(cb) {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
