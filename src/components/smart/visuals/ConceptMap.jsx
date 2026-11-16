import { memo, useState, useMemo } from 'react'
import { wrapLabel } from './SystemDiagram'

// Carte conceptuelle : nœuds disposés en cercle, relations nommées au centre.
// Cliquer un nœud met en évidence ses relations.

const SIZE = 460
const RADIUS = 152
const CENTER = SIZE / 2

export default memo(function ConceptMap({ nodes, edges, title }) {
  const [activeId, setActiveId] = useState(null)

  const positioned = useMemo(() => {
    return nodes.map((node, i) => {
      const angle = (i / nodes.length) * Math.PI * 2 - Math.PI / 2
      return {
        ...node,
        x: CENTER + Math.cos(angle) * RADIUS,
        y: CENTER + Math.sin(angle) * RADIUS,
      }
    })
  }, [nodes])

  const byId = useMemo(() => Object.fromEntries(positioned.map((n) => [n.id, n])), [positioned])
  const active = activeId ? byId[activeId] : null
  const activeEdges = useMemo(
    () => (activeId ? edges.filter((e) => e.from === activeId || e.to === activeId) : []),
    [edges, activeId]
  )

  return (
    <div className="sr-visual-block sr-concept">
      {title && <h4 className="sr-visual-title">{title}</h4>}
      <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="sr-concept-svg" role="group" aria-label={title ?? 'Carte conceptuelle'}>
        {/* Liens : lignes seules, en arrière-plan. */}
        {edges.map((edge, i) => {
          const a = byId[edge.from]
          const b = byId[edge.to]
          if (!a || !b) return null
          const highlighted = activeId && (edge.from === activeId || edge.to === activeId)
          return (
            <g key={`${edge.from}-${edge.to}-${i}`} className={`sr-concept-edge${highlighted ? ' is-active' : ''}`}>
              <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} />
            </g>
          )
        })}
        {positioned.map((node) => (
          <g
            key={node.id}
            className={`sr-concept-node${node.id === activeId ? ' is-active' : ''}`}
            tabIndex={0}
            role="button"
            aria-label={node.label}
            aria-pressed={node.id === activeId}
            onClick={() => setActiveId(node.id === activeId ? null : node.id)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setActiveId(node.id === activeId ? null : node.id)
              }
            }}
          >
            <circle cx={node.x} cy={node.y} r="42" />
            {/* Libellés sur deux lignes, coupés sur une frontière de mot.
                Avant : troncature à 16 caractères, ce qui affichait
                « Deux bancs de c… » et rendait le schéma illisible. */}
            {wrapLabel(node.label, 15).map((line, li, all) => (
              <text
                key={li}
                x={node.x}
                y={node.y + 4 + (li - (all.length - 1) / 2) * 13}
                textAnchor="middle"
                className="sr-concept-label"
              >
                {line}
              </text>
            ))}
          </g>

        ))}
        {/* Étiquettes de liens AU PREMIER PLAN : rendues après les nœuds, sinon
            les cercles les recouvrent et le texte apparaît tronqué. Chaque
            étiquette a une pastille sombre pour rester lisible au-dessus du trait. */}
        {edges.map((edge, i) => {
          const a = byId[edge.from]
          const b = byId[edge.to]
          if (!a || !b || !edge.label) return null
          const mx = (a.x + b.x) / 2
          const my = (a.y + b.y) / 2
          const w = Math.min(edge.label.length * 4.8 + 12, 130)
          const highlighted = activeId && (edge.from === activeId || edge.to === activeId)
          return (
            <g key={`lbl-${edge.from}-${edge.to}-${i}`} className={`sr-concept-edge-label-group${highlighted ? ' is-active' : ''}`}>
              <rect x={mx - w / 2} y={my - 11} width={w} height={15} rx="7.5" className="sr-concept-edge-label-bg" />
              <text x={mx} y={my} textAnchor="middle" className="sr-concept-edge-label">
                {edge.label}
              </text>
            </g>
          )
        })}
      </svg>
      {active && (
        <div className="sr-step-detail" aria-live="polite">
          <strong>{active.label}</strong>
          {active.detail && <p>{active.detail}</p>}
          {activeEdges.length > 0 && (
            <ul className="sr-concept-links">
              {activeEdges.map((e, i) => {
                const other = e.from === active.id ? byId[e.to] : byId[e.from]
                return (
                  <li key={i}>
                    {e.label ? `${e.label} : ` : ''}
                    {other?.label}
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
})
