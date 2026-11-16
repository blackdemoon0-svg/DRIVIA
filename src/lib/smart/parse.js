// Interprétation du contenu IA → blocs structurés.
// Tolérant au streaming : un bloc inachevé reste lisible, jamais bloquant.
// Aucune exécution de HTML/JS : tout est tokenisé en données simples.

const MAX_BLOCKS = 400

// --- Inline ---------------------------------------------------------------

const INLINE_RE =
  /(\*\*[^*]+\*\*|__[^_]+__|~~[^~]+~~|`[^`]+`|\$[^$\n]+\$|\[[^\]\n]+\]\([^)\s]+\)|\*[^*\n]+\*)/g

const SAFE_URL = /^(https?:\/\/|mailto:|\/(?!\/))/i

export function sanitizeUrl(href) {
  const value = String(href ?? '').trim()
  if (!value) return null
  // Rejette javascript:, data:, vbscript:… et toute scheme non autorisé.
  if (!SAFE_URL.test(value)) return null
  return value
}

// Découpe une ligne en tokens inline. Retourne toujours un tableau.
export function parseInline(text) {
  const input = String(text ?? '')
  const tokens = []
  let last = 0
  let match
  INLINE_RE.lastIndex = 0
  while ((match = INLINE_RE.exec(input)) !== null) {
    if (match.index > last) tokens.push({ t: 'text', v: input.slice(last, match.index) })
    const raw = match[0]
    if (raw.startsWith('**') || raw.startsWith('__')) tokens.push({ t: 'bold', v: raw.slice(2, -2) })
    else if (raw.startsWith('~~')) tokens.push({ t: 'strike', v: raw.slice(2, -2) })
    else if (raw.startsWith('*')) tokens.push({ t: 'italic', v: raw.slice(1, -1) })
    else if (raw.startsWith('`')) tokens.push({ t: 'code', v: raw.slice(1, -1) })
    else if (raw.startsWith('$')) tokens.push({ t: 'math', v: raw.slice(1, -1) })
    else {
      const cut = raw.indexOf('](')
      const label = raw.slice(1, cut)
      const href = sanitizeUrl(raw.slice(cut + 2, -1))
      // Lien non sûr → on conserve le libellé en texte, jamais de href.
      if (href) tokens.push({ t: 'link', v: label, href })
      else tokens.push({ t: 'text', v: label })
    }
    last = match.index + raw.length
  }
  if (last < input.length) tokens.push({ t: 'text', v: input.slice(last) })
  return tokens
}

// --- Blocs ----------------------------------------------------------------

function splitRow(line) {
  return line
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

function isSeparator(line) {
  return /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')
}

function isFence(line) {
  const m = /^\s*(`{3,}|~{3,})\s*([A-Za-z0-9_+-]*)\s*$/.exec(line)
  return m ? { marker: m[1][0], len: m[1].length, lang: (m[2] || '').toLowerCase() } : null
}

function isBlockStart(line, next) {
  const t = line.trim()
  if (!t) return true
  if (isFence(line)) return true
  if (/^#{1,6}\s+/.test(t)) return true
  if (/^([-*_])\1{2,}$/.test(t)) return true
  if (/^[-*•]\s+/.test(t)) return true
  if (/^\d+[.)]\s+/.test(t)) return true
  if (/^>/.test(t)) return true
  if (t.startsWith('$$')) return true
  if (t.includes('|') && next !== undefined && isSeparator(next)) return true
  return false
}

// Parse le markdown de la réponse en blocs. `streaming` indique que la fin du
// texte n'est pas définitive : les blocs ouverts sont marqués `open`.
export function parseBlocks(text, { streaming = false } = {}) {
  const source = String(text ?? '').replace(/\r\n?/g, '\n')
  const lines = source.split('\n')
  const blocks = []
  let i = 0

  const push = (block) => {
    if (blocks.length < MAX_BLOCKS) blocks.push(block)
  }

  while (i < lines.length) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) { i++; continue }

    // Fence de code (ou bloc visuel `veyvro`)
    const fence = isFence(line)
    if (fence) {
      const body = []
      let closed = false
      i++
      while (i < lines.length) {
        const f = isFence(lines[i])
        if (f && f.marker === fence.marker && f.len >= fence.len && !f.lang) { closed = true; i++; break }
        body.push(lines[i])
        i++
      }
      const code = body.join('\n')
      if (fence.lang === 'veyvro' || fence.lang === 'veyvro-visual') {
        push({ type: 'visual', raw: code, open: !closed })
      } else if (fence.lang === 'veyvro-image') {
        push({ type: 'image', raw: code, open: !closed })
      } else {
        push({ type: 'code', lang: fence.lang || 'text', code, open: !closed })
      }
      continue
    }

    // Math display $$…$$
    if (trimmed.startsWith('$$')) {
      const single = /^\$\$(.+)\$\$$/.exec(trimmed)
      if (single) { push({ type: 'math', expr: single[1].trim() }); i++; continue }
      const body = [trimmed.slice(2)]
      let closed = false
      i++
      while (i < lines.length) {
        if (lines[i].trim().endsWith('$$')) { body.push(lines[i].trim().slice(0, -2)); closed = true; i++; break }
        body.push(lines[i])
        i++
      }
      push({ type: 'math', expr: body.join(' ').trim(), open: !closed })
      continue
    }

    // Titre
    const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (heading) {
      push({ type: 'heading', level: heading[1].length, text: heading[2].trim() })
      i++
      continue
    }

    // Séparateur
    if (/^([-*_])\1{2,}$/.test(trimmed)) { push({ type: 'divider' }); i++; continue }

    // Tableau markdown
    if (trimmed.includes('|') && i + 1 < lines.length && isSeparator(lines[i + 1])) {
      const header = splitRow(trimmed)
      i += 2
      const rows = []
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) {
        rows.push(splitRow(lines[i]))
        i++
      }
      push({ type: 'table', header, rows, open: streaming && i >= lines.length })
      continue
    }

    // Citation / callout
    if (/^>/.test(trimmed)) {
      const body = []
      while (i < lines.length && /^\s*>/.test(lines[i])) {
        body.push(lines[i].replace(/^\s*>\s?/, ''))
        i++
      }
      const joined = body.join(' ').trim()
      const tag = /^\[!(\w+)\]\s*/.exec(joined)
      const tone = tag ? tag[1].toLowerCase() : 'note'
      push({ type: 'callout', tone, text: tag ? joined.slice(tag[0].length) : joined })
      continue
    }

    // Listes (à puces ou numérotées) — les items indentés sont rattachés.
    const bullet = /^[-*•]\s+(.*)$/.exec(trimmed)
    const numbered = /^(\d+)[.)]\s+(.*)$/.exec(trimmed)
    if (bullet || numbered) {
      const ordered = Boolean(numbered)
      const start = ordered ? Number(numbered[1]) : 1
      const items = []
      while (i < lines.length) {
        const t = lines[i].trim()
        if (!t) {
          // Ligne vide : fin de liste seulement si la suite n'est pas un item.
          const next = lines[i + 1]?.trim() ?? ''
          if (!/^([-*•]\s+|\d+[.)]\s+)/.test(next)) break
          i++
          continue
        }
        const b = /^[-*•]\s+(.*)$/.exec(t)
        const n = /^(\d+)[.)]\s+(.*)$/.exec(t)
        if (ordered && n) { items.push(n[2]); i++; continue }
        if (!ordered && b) { items.push(b[1]); i++; continue }
        if (/^\s{2,}\S/.test(lines[i]) && items.length) { items[items.length - 1] += ' ' + t; i++; continue }
        break
      }
      push({ type: 'list', ordered, start, items })
      continue
    }

    // Paragraphe : agrège jusqu'à la prochaine structure.
    const para = [trimmed]
    i++
    while (i < lines.length && !isBlockStart(lines[i], lines[i + 1])) {
      para.push(lines[i].trim())
      i++
    }
    push({ type: 'paragraph', text: para.join(' ') })
  }

  return blocks
}

// Texte brut d'un bloc — utilisé pour la classification et le repli.
export function blockText(block) {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
    case 'callout':
      return block.text
    case 'list':
      return block.items.join(' ')
    case 'table':
      return [...block.header, ...block.rows.flat()].join(' ')
    case 'code':
      return block.code
    case 'math':
      return block.expr
    default:
      return ''
  }
}
