import { memo, useState, useMemo } from 'react'

// Diagramme circulaire (camembert / donut) accessible et interactif.
// Les parts sont calculées en pourcentage réel à partir des valeurs fournies.

const COLORS = ['#a855f7', '#e879f9', '#7c3aed', '#c084fc', '#8b5cf6', '#f0abfc', '#6d28d9', '#d8b4fe']
const SIZE = 220
const R = 92
const CENTER = SIZE / 2
const STROKE = 42

function polar(angle) {
  return { x: CENTER + R * Math.cos(angle), y: CENTER + R * Math.sin(angle) }
}

export default memo(function PieChart({ slices, title, unit }) {
  const [activeIndex, setActiveIndex] = useState(null)
  const total = slices.reduce((sum, s) => sum + s.value, 0)

  const arcs = useMemo(() => {
    let angle = -Math.PI / 2
    return slices.map((slice, i) => {
      const share = slice.value / total
      const start = angle
      const end = angle + share * Math.PI * 2
      angle = end
      const largeArc = end - start > Math.PI ? 1 : 0
      const p1 = polar(start)
      const p2 = polar(end)
      // Part unique à 100 % : cercle complet.
      const isFull = share > 0.999
      return {
        ...slice,
        share,
        index: i,
        color: COLORS[i % COLORS.length],
        path: isFull
          ? `M ${CENTER} ${CENTER - R} A ${R} ${R} 0 1 1 ${CENTER - 0.01} ${CENTER - R}`
          : `M ${CENTER} ${CENTER} L ${p1.x} ${p1.y} A ${R} ${R} 0 ${largeArc} 1 ${p2.x} ${p2.y} Z`,
      }
    })
  }, [slices, total])

  const active = activeIndex !== null ? arcs[activeIndex] : null
  const display = active ?? null
  const centerValue = display ? `${Math.round(display.share * 100)}%` : ''
  const centerLabel = display ? 'part' : ''

  return (
    <div className="sr-visual-block sr-pie">
      {title && <h4 className="sr-visual-title">{title}</h4>}
      <div className="sr-pie-layout">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} className="sr-pie-svg" role="img" aria-label={title ?? 'Diagramme circulaire'}>
          {arcs.length === 1 ? (
            <circle cx={CENTER} cy={CENTER} r={R} fill="none" stroke={arcs[0].color} strokeWidth={STROKE} />
          ) : (
            arcs.map((arc) => (
              <path
                key={arc.label}
                d={arc.path}
                fill={arc.color}
                className={`sr-pie-slice${arc.index === activeIndex ? ' is-active' : ''}`}
                tabIndex={0}
                role="button"
                aria-label={`${arc.label} : ${Math.round(arc.share * 100)}%`}
                onMouseEnter={() => setActiveIndex(arc.index)}
                onMouseLeave={() => setActiveIndex(null)}
                onFocus={() => setActiveIndex(arc.index)}
                onBlur={() => setActiveIndex(null)}
                onClick={() => setActiveIndex(arc.index === activeIndex ? null : arc.index)}
              />
            ))
          )}
          {display && (
            <g pointerEvents="none">
              <text x={CENTER} y={CENTER + 2} textAnchor="middle" className="sr-pie-center-value">{centerValue}</text>
              <text x={CENTER} y={CENTER + 20} textAnchor="middle" className="sr-pie-center-label">{display.label}</text>
            </g>
          )}
        </svg>
        <ul className="sr-pie-legend" aria-label={unit ? `Répartition en ${unit}` : 'Répartition'}>
          {arcs.map((arc) => (
            <li
              key={arc.label}
              className={arc.index === activeIndex ? 'is-active' : ''}
              onMouseEnter={() => setActiveIndex(arc.index)}
              onMouseLeave={() => setActiveIndex(null)}
            >
              <span className="sr-pie-dot" style={{ background: arc.color }} aria-hidden="true" />
              <span className="sr-pie-label">{arc.label}</span>
              <span className="sr-pie-value">{Math.round(arc.share * 100)}%</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
})
