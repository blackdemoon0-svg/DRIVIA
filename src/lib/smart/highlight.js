// Coloration syntaxique minimale, sans dépendance.
// Tokenisation par expressions régulières → spans colorés via CSS.
// Aucune insertion de HTML : le rendu React échappe tout le texte.

const KEYWORDS = {
  js: 'const let var function return if else for while do break continue new class extends super this typeof instanceof try catch finally throw async await import export from default switch case yield delete in of null undefined true false static get set',
  ts: 'const let var function return if else for while interface type enum implements public private protected readonly abstract as namespace declare new class extends this try catch finally throw async await import export from default null undefined true false number string boolean any unknown void never',
  python: 'def class return if elif else for while break continue import from as pass raise try except finally with lambda yield global nonlocal assert del async await None True False and or not in is',
  css: 'important media supports keyframes import from to',
  sql: 'select from where insert into values update set delete create table alter drop join left right inner outer on group by order having limit offset as and or not null primary key foreign references distinct union all',
  bash: 'if then else elif fi for while do done case esac function return export local echo cd sudo apt npm npx git curl',
  json: 'true false null',
}
KEYWORDS.jsx = KEYWORDS.js
KEYWORDS.tsx = KEYWORDS.ts
KEYWORDS.javascript = KEYWORDS.js
KEYWORDS.typescript = KEYWORDS.ts
KEYWORDS.py = KEYWORDS.python
KEYWORDS.sh = KEYWORDS.bash
KEYWORDS.shell = KEYWORDS.bash
KEYWORDS.zsh = KEYWORDS.bash

const ALIASES = { javascript: 'js', typescript: 'ts', py: 'python', sh: 'bash', shell: 'bash', zsh: 'bash', html: 'markup', xml: 'markup', svg: 'markup', vue: 'markup' }

export function normalizeLang(lang) {
  const value = String(lang ?? '').toLowerCase().trim()
  return ALIASES[value] ?? value ?? 'text'
}

function keywordSet(lang) {
  const words = KEYWORDS[lang] ?? KEYWORDS[normalizeLang(lang)]
  if (!words) return null
  return new Set(words.split(' '))
}

const MAX_TOKENS = 4000

// Retourne [{ t, v }] — t ∈ text|keyword|string|comment|number|tag|attr|punct|fn
export function highlight(code, lang) {
  const source = String(code ?? '')
  const language = normalizeLang(lang)
  const words = keywordSet(language)
  const tokens = []
  let i = 0

  const push = (t, v) => {
    if (!v) return
    if (tokens.length >= MAX_TOKENS) return
    const last = tokens[tokens.length - 1]
    if (last && last.t === t) last.v += v
    else tokens.push({ t, v })
  }

  if (language === 'markup') {
    const re = /(<!--[\s\S]*?-->)|(<\/?[A-Za-z][\w:-]*)|([A-Za-z-]+)(?==)|("[^"]*"|'[^']*')|(\/?>)/g
    let last = 0
    let m
    while ((m = re.exec(source)) !== null) {
      if (m.index > last) push('text', source.slice(last, m.index))
      if (m[1]) push('comment', m[1])
      else if (m[2]) push('tag', m[2])
      else if (m[3]) push('attr', m[3])
      else if (m[4]) push('string', m[4])
      else push('punct', m[5])
      last = m.index + m[0].length
    }
    if (last < source.length) push('text', source.slice(last))
    return tokens
  }

  const lineComment = language === 'python' || language === 'bash' ? '#' : '//'
  while (i < source.length && tokens.length < MAX_TOKENS) {
    const rest = source.slice(i)

    // Commentaires
    if (rest.startsWith(lineComment)) {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      push('comment', source.slice(i, stop)); i = stop; continue
    }
    if (rest.startsWith('/*')) {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      push('comment', source.slice(i, stop)); i = stop; continue
    }
    if (language === 'sql' && rest.startsWith('--')) {
      const end = source.indexOf('\n', i)
      const stop = end === -1 ? source.length : end
      push('comment', source.slice(i, stop)); i = stop; continue
    }

    // Chaînes
    const quote = source[i]
    if (quote === '"' || quote === "'" || quote === '`') {
      let j = i + 1
      while (j < source.length) {
        if (source[j] === '\\') { j += 2; continue }
        if (source[j] === quote) { j++; break }
        j++
      }
      push('string', source.slice(i, j)); i = j; continue
    }

    // Nombres
    const number = /^\d[\d_]*(\.\d+)?([eE][+-]?\d+)?/.exec(rest)
    if (number) { push('number', number[0]); i += number[0].length; continue }

    // Identifiants / mots-clés
    const ident = /^[A-Za-z_$][\w$]*/.exec(rest)
    if (ident) {
      const word = ident[0]
      const after = rest.slice(word.length)
      if (words?.has(word) || words?.has(word.toLowerCase())) push('keyword', word)
      else if (/^\s*\(/.test(after)) push('fn', word)
      else push('text', word)
      i += word.length
      continue
    }

    // Ponctuation / opérateurs
    if (/[{}[\]();,.:=+\-*/%<>!&|?]/.test(source[i])) { push('punct', source[i]); i++; continue }

    push('text', source[i]); i++
  }
  if (i < source.length) push('text', source.slice(i))
  return tokens
}

export const LANG_LABELS = {
  js: 'JavaScript', jsx: 'JSX', ts: 'TypeScript', tsx: 'TSX', python: 'Python',
  css: 'CSS', scss: 'SCSS', markup: 'HTML', json: 'JSON', sql: 'SQL',
  bash: 'Shell', yaml: 'YAML', yml: 'YAML', text: 'Texte',
}
