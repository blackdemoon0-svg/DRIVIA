import { memo } from 'react'
import { parseInline } from '../../lib/smart/parse'
import CodeBlock from './CodeBlock'
import MathBlock from './MathBlock'
import { ChevronIcon } from '../Icons'

// Rendu inline sûr : uniquement des éléments React, jamais de HTML injecté.
export const Inline = memo(function Inline({ text }) {
  const tokens = parseInline(text)
  return tokens.map((token, i) => {
    switch (token.t) {
      case 'bold': return <strong key={i}>{token.v}</strong>
      case 'italic': return <em key={i}>{token.v}</em>
      case 'strike': return <s key={i}>{token.v}</s>
      case 'code': return <code key={i}>{token.v}</code>
      case 'math': return <MathBlock key={i} expr={token.v} inline />
      case 'link':
        return (
          <a key={i} href={token.href} target="_blank" rel="noopener noreferrer nofollow" className="sr-link">
            {token.v}
          </a>
        )
      default: return <span key={i}>{token.v}</span>
    }
  })
})

function Callout({ tone, text }) {
  const safe = ['note', 'tip', 'info', 'warning', 'important', 'caution', 'danger'].includes(tone) ? tone : 'note'
  return (
    <div className={`sr-callout is-${safe}`} role="note">
      <Inline text={text} />
    </div>
  )
}

// Tableau markdown générique (le comparatif a son propre composant).
export function DataTable({ header, rows }) {
  return (
    <div className="sr-table-wrap" tabIndex={0} role="region" aria-label="Tableau de données">
      <table className="sr-table">
        <thead>
          <tr>{header.map((cell, i) => <th key={i} scope="col"><Inline text={cell} /></th>)}</tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {header.map((_, c) => (
                <td key={c} data-label={header[c]}>
                  {c === 0 ? <strong><Inline text={row[c] ?? ''} /></strong> : <Inline text={row[c] ?? ''} />}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function MarkdownList({ block }) {
  const Tag = block.ordered ? 'ol' : 'ul'
  return (
    <Tag className="sr-list" start={block.ordered ? block.start : undefined}>
      {block.items.map((item, i) => <li key={i}><Inline text={item} /></li>)}
    </Tag>
  )
}

// Un bloc visuel non valide (ou encore en cours) retombe sur du texte lisible.
export function VisualFallback({ raw, open }) {
  if (open) {
    return (
      <div className="sr-visual-pending" aria-live="polite">
        <span className="sr-pending-dot" aria-hidden="true" />
        Préparation de la visualisation…
      </div>
    )
  }
  return (
    <details className="sr-fallback">
      <summary>
        <ChevronIcon size={14} />
        Visualisation indisponible — afficher les données
      </summary>
      <pre><code>{raw}</code></pre>
    </details>
  )
}

// Rendu d'un bloc standard. Les blocs « transformés » (étapes, comparatif)
// sont pris en charge par SmartResponse et n'arrivent pas ici.
export default function Block({ block }) {
  switch (block.type) {
    case 'heading': {
      const level = Math.min(Math.max(block.level, 1), 4)
      const Tag = `h${Math.min(level + 2, 6)}`
      return <Tag className={`sr-heading is-level-${level}`}><Inline text={block.text} /></Tag>
    }
    case 'paragraph':
      return <p className="sr-paragraph"><Inline text={block.text} /></p>
    case 'list':
      return <MarkdownList block={block} />
    case 'code':
      return <CodeBlock code={block.code} lang={block.lang} open={block.open} />
    case 'math':
      return <MathBlock expr={block.expr} />
    case 'table':
      return <DataTable header={block.header} rows={block.rows} />
    case 'callout':
      return <Callout tone={block.tone} text={block.text} />
    case 'divider':
      return <hr className="sr-divider" />
    default:
      return null
  }
}
