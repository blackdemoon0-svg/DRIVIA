// Point d'entrée du moteur Smart Responses.
// Chaîne : contenu IA → parsing → validation des visuels → sélection du format.
// Le rendu reste un pur affichage : aucune donnée n'est inventée.

import { parseBlocks } from './parse'
import { validateVisual } from './schema'
import { validateImageBlock } from './imageService'
import { selectFormat } from './classify'

const CACHE_LIMIT = 60
const cache = new Map()

function cacheKey(content, question, streaming) {
  return `${streaming ? 's' : 'f'}|${question.length}|${question.slice(0, 80)}|${content.length}|${content.slice(-64)}`
}

// Analyse complète d'une réponse. `messages` sert à retrouver la question posée.
export function analyzeResponse(content, { question = '', streaming = false } = {}) {
  const text = String(content ?? '')
  const key = cacheKey(text, question, streaming)
  const hit = cache.get(key)
  if (hit) return hit

  const blocks = parseBlocks(text, { streaming })

  // Validation des blocs visuels. Un bloc encore ouvert pendant le streaming
  // n'est pas validé : il reste en repli code, puis devient un visuel à la fin.
  for (const block of blocks) {
    if (block.type === 'visual') {
      block.spec = block.open ? null : validateVisual(block.raw)
    } else if (block.type === 'image') {
      block.data = block.open ? null : validateImageBlock(block.raw)
    }
  }

  const format = selectFormat({ question, blocks, content: text, streaming })
  const result = { blocks, ...format, content: text }

  if (!streaming) {
    if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value)
    cache.set(key, result)
  }
  return result
}

export function clearSmartCache() {
  cache.clear()
}

export { parseBlocks, parseInline, sanitizeUrl } from './parse'
export { validateVisual, VISUAL_TYPES } from './schema'
export { generateImage, validateImageBlock, sanitizeHistoryForApi, ImageServiceError } from './imageService'
export { detectImageIntent } from './imageIntent'
export { selectFormat, KINDS } from './classify'
export { parseMath, mathToText, looksLikeMath } from './math'
export { highlight, normalizeLang, LANG_LABELS } from './highlight'
