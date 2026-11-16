import { memo, useMemo, useState, useCallback } from 'react'
import { highlight, normalizeLang, LANG_LABELS } from '../../lib/smart/highlight'
import { CopyIcon, CheckIcon } from '../Icons'

// Bloc de code : coloration sûre + copie + repli si la coloration échoue.
export default memo(function CodeBlock({ code, lang, open }) {
  const [copied, setCopied] = useState(false)
  const language = normalizeLang(lang)
  const label = LANG_LABELS[language] ?? (language ? language.toUpperCase() : 'Code')

  const tokens = useMemo(() => {
    try {
      return highlight(code, language)
    } catch {
      return [{ t: 'text', v: code }]
    }
  }, [code, language])

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* presse-papiers indisponible */
    }
  }, [code])

  return (
    <figure className="sr-code">
      <figcaption className="sr-code-head">
        <span className="sr-code-lang">{label}</span>
        {open && <span className="sr-code-live">en cours…</span>}
        <button type="button" className="sr-code-copy" onClick={copy} aria-label={`Copier le code ${label}`}>
          {copied ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
          <span>{copied ? 'Copié' : 'Copier'}</span>
        </button>
      </figcaption>
      <pre tabIndex={0} role="region" aria-label={`Exemple de code ${label}`}>
        <code>
          {tokens.map((token, i) => (
            <span key={i} className={`tok-${token.t}`}>{token.v}</span>
          ))}
        </code>
      </pre>
    </figure>
  )
})
