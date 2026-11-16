// Rendu mathématique sûr, sans dépendance externe.
// Sous-ensemble LaTeX → arbre de tokens → <span> (jamais de HTML injecté).
// Supporte fractions, racines, exposants, indices, symboles grecs et opérateurs.

const SYMBOLS = {
  times: '×', div: '÷', cdot: '·', pm: '±', mp: '∓',
  leq: '≤', le: '≤', geq: '≥', ge: '≥', neq: '≠', ne: '≠',
  approx: '≈', equiv: '≡', sim: '∼', propto: '∝',
  rightarrow: '→', to: '→', leftarrow: '←', Rightarrow: '⇒', leftrightarrow: '↔',
  infty: '∞', sum: '∑', prod: '∏', int: '∫', partial: '∂', nabla: '∇',
  pi: 'π', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε',
  theta: 'θ', lambda: 'λ', mu: 'μ', sigma: 'σ', tau: 'τ', phi: 'φ',
  omega: 'ω', Delta: 'Δ', Sigma: 'Σ', Omega: 'Ω', Phi: 'Φ', Lambda: 'Λ',
  in: '∈', notin: '∉', subset: '⊂', cup: '∪', cap: '∩', forall: '∀', exists: '∃',
  degree: '°', percent: '%', euro: '€', dots: '…', ldots: '…',
  left: '', right: '', ',': ' ', ';': ' ', ' ': ' ', quad: '  ',
}

const MAX_DEPTH = 12
const MAX_NODES = 600

class Parser {
  constructor(input) {
    this.s = String(input ?? '').slice(0, 1200)
    this.i = 0
    this.count = 0
  }

  peek() { return this.s[this.i] }

  // Groupe {…} ou un seul caractère/token.
  group(depth) {
    while (this.s[this.i] === ' ') this.i++
    if (this.peek() === '{') {
      this.i++
      const node = this.row(depth + 1, '}')
      if (this.peek() === '}') this.i++
      return node
    }
    if (this.peek() === '\\') {
      const sym = this.command(depth)
      return sym ?? { t: 'txt', v: '' }
    }
    const ch = this.peek()
    if (ch === undefined) return { t: 'txt', v: '' }
    this.i++
    return { t: 'txt', v: ch }
  }

  command(depth) {
    this.i++ // backslash
    const start = this.i
    while (this.i < this.s.length && /[A-Za-z]/.test(this.s[this.i])) this.i++
    let name = this.s.slice(start, this.i)
    if (!name) {
      name = this.s[this.i] ?? ''
      this.i++
    }
    if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
      const numerator = this.group(depth + 1)
      const denominator = this.group(depth + 1)
      return { t: 'frac', num: numerator, den: denominator }
    }
    if (name === 'sqrt') {
      return { t: 'sqrt', body: this.group(depth + 1) }
    }
    if (name === 'text' || name === 'mathrm' || name === 'operatorname') {
      const body = this.group(depth + 1)
      return { t: 'text', body }
    }
    if (Object.prototype.hasOwnProperty.call(SYMBOLS, name)) {
      return { t: 'txt', v: SYMBOLS[name] }
    }
    // Commande inconnue : on l'affiche littéralement, sans l'exécuter.
    return { t: 'txt', v: name }
  }

  row(depth, stop) {
    const children = []
    if (depth > MAX_DEPTH) {
      // Au-delà de la profondeur max, on rend le reste en texte brut.
      const rest = stop ? this.s.slice(this.i).split(stop)[0] : this.s.slice(this.i)
      this.i += rest.length
      return { t: 'row', children: [{ t: 'txt', v: rest }] }
    }
    while (this.i < this.s.length && this.count < MAX_NODES) {
      const ch = this.s[this.i]
      if (stop && ch === stop) break
      if (!stop && ch === '}') { this.i++; continue }
      this.count++
      if (ch === '\\') {
        const node = this.command(depth)
        if (node) children.push(node)
        continue
      }
      if (ch === '^' || ch === '_') {
        this.i++
        const base = children.pop() ?? { t: 'txt', v: '' }
        const script = this.group(depth + 1)
        children.push({ t: ch === '^' ? 'sup' : 'sub', base, script })
        continue
      }
      if (ch === '{') {
        children.push(this.group(depth))
        continue
      }
      // Accumule le texte courant.
      const start = this.i
      while (
        this.i < this.s.length &&
        !'\\^_{}'.includes(this.s[this.i]) &&
        !(stop && this.s[this.i] === stop)
      ) this.i++
      if (this.i === start) this.i++
      children.push({ t: 'txt', v: this.s.slice(start, this.i) })
    }
    return { t: 'row', children }
  }
}

export function parseMath(input) {
  try {
    return new Parser(input).row(0)
  } catch {
    return { t: 'row', children: [{ t: 'txt', v: String(input ?? '') }] }
  }
}

// Texte lisible (accessibilité + copie) à partir de l'arbre.
export function mathToText(node) {
  if (!node) return ''
  switch (node.t) {
    case 'row': return node.children.map(mathToText).join('')
    case 'txt': return node.v
    case 'text': return mathToText(node.body)
    case 'frac': return `(${mathToText(node.num)})/(${mathToText(node.den)})`
    case 'sqrt': return `√(${mathToText(node.body)})`
    case 'sup': return `${mathToText(node.base)}^${mathToText(node.script)}`
    case 'sub': return `${mathToText(node.base)}_${mathToText(node.script)}`
    default: return ''
  }
}

// Détecte une expression mathématique dans une ligne de texte.
export function looksLikeMath(text) {
  const t = String(text ?? '')
  if (/\$\$?[^$]+\$\$?/.test(t)) return true
  if (/\\(frac|sqrt|sum|int|times|cdot|leq|geq|pi)\b/.test(t)) return true
  return /[=≈≤≥]/.test(t) && /\d/.test(t) && /[+\-*/^]/.test(t)
}
