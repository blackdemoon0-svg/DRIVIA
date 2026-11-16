import { memo, useMemo } from 'react'
import { parseMath, mathToText } from '../../lib/smart/math'

// Rendu récursif de l'arbre mathématique en <span> (aucun HTML injecté).
function Node({ node }) {
  if (!node) return null
  switch (node.t) {
    case 'row':
      return <>{node.children.map((child, i) => <Node key={i} node={child} />)}</>
    case 'txt':
      return <span className="mx-txt">{node.v}</span>
    case 'text':
      return <span className="mx-text"><Node node={node.body} /></span>
    case 'frac':
      return (
        <span className="mx-frac">
          <span className="mx-num"><Node node={node.num} /></span>
          <span className="mx-den"><Node node={node.den} /></span>
        </span>
      )
    case 'sqrt':
      return (
        <span className="mx-sqrt">
          <span className="mx-radical" aria-hidden="true">√</span>
          <span className="mx-radicand"><Node node={node.body} /></span>
        </span>
      )
    case 'sup':
      return <span className="mx-script"><Node node={node.base} /><sup><Node node={node.script} /></sup></span>
    case 'sub':
      return <span className="mx-script"><Node node={node.base} /><sub><Node node={node.script} /></sub></span>
    default:
      return null
  }
}

export default memo(function MathBlock({ expr, inline = false, result = false }) {
  const tree = useMemo(() => parseMath(expr), [expr])
  const readable = useMemo(() => mathToText(tree), [tree])

  if (inline) {
    return (
      <span className="mx-inline" role="math" aria-label={readable}>
        <Node node={tree} />
      </span>
    )
  }
  return (
    <div className={`mx-block${result ? ' is-result' : ''}`} role="math" aria-label={readable}>
      {result && <span className="mx-result-label">Résultat</span>}
      <div className="mx-scroll">
        <Node node={tree} />
      </div>
    </div>
  )
})
