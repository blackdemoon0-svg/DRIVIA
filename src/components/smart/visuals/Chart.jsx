import { memo, useMemo, useState, useCallback } from 'react'

// Graphique SVG interactif (barres ou courbe), sans dépendance.
// Survol / focus clavier → valeur exacte. Les données viennent du modèle.
const W = 520
const H = 240
const PAD = { top: 18, right: 16, bottom: 34, left: 44 }

function niceTicks(min, max, count = 4) {
  const span = max - min || 1
  const step = span / count
  return Array.from({ length: count + 1 }, (_, i) => min + step * i)
}

function format(value, unit) {
  const rounded = Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100
  return unit ? `${rounded} ${unit}` : String(rounded)
}

export default memo(function Chart({ spec }) {
  const { variant, title, unit, series } = spec
  const [hover, setHover] = useState(null)

  const model = useMemo(() => {
    const values = series.flatMap((s) => s.points.map((p) => p.y))
    const rawMin = Math.min(...values, 0)
    const rawMax = Math.max(...values, 0)
    const pad = (rawMax - rawMin || 1) * 0.1
    const min = rawMin < 0 ? rawMin - pad : 0
    const max = rawMax + pad
    const labels = series[0].points.map((p) => p.x)
    const innerW = W - PAD.left - PAD.right
    const innerH = H - PAD.top - PAD.bottom
    const xFor = (i) => PAD.left + (labels.length === 1 ? innerW / 2 : (i / (labels.length - 1)) * innerW)
    const yFor = (v) => PAD.top + innerH - ((v - min) / (max - min || 1)) * innerH
    return { min, max, labels, innerW, innerH, xFor, yFor, ticks: niceTicks(min, max) }
  }, [series])

  const onLeave = useCallback(() => setHover(null), [])
  const bandWidth = model.innerW / Math.max(model.labels.length, 1)

  return (
    <figure className="sr-chart" aria-label={title ?? 'Graphique'}>
      {title && <figcaption className="sr-chart-title">{title}</figcaption>}
      <div className="sr-chart-canvas">
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={title ?? 'Graphique de valeurs'} preserveAspectRatio="xMidYMid meet">
          {model.ticks.map((tick, i) => (
            <g key={i}>
              <line x1={PAD.left} x2={W - PAD.right} y1={model.yFor(tick)} y2={model.yFor(tick)} className="sr-chart-grid" />
              <text x={PAD.left - 8} y={model.yFor(tick) + 4} className="sr-chart-axis" textAnchor="end">
                {Math.round(tick * 100) / 100}
              </text>
            </g>
          ))}

          {variant === 'bar'
            ? series.map((s, si) =>
                s.points.map((point, i) => {
                  const slot = bandWidth / series.length
                  const x = PAD.left + i * bandWidth + si * slot + slot * 0.15
                  const y = model.yFor(Math.max(point.y, 0))
                  const height = Math.abs(model.yFor(point.y) - model.yFor(0))
                  return (
                    <rect
                      key={`${si}-${i}`}
                      x={x}
                      y={y}
                      width={slot * 0.7}
                      height={Math.max(height, 1)}
                      rx="4"
                      className={`sr-chart-bar is-series-${si}${hover?.si === si && hover?.i === i ? ' is-hover' : ''}`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${s.label}, ${point.x} : ${format(point.y, unit)}`}
                      onMouseEnter={() => setHover({ si, i })}
                      onMouseLeave={onLeave}
                      onFocus={() => setHover({ si, i })}
                      onBlur={onLeave}
                    />
                  )
                })
              )
            : series.map((s, si) => (
                <g key={si}>
                  <polyline
                    className={`sr-chart-line is-series-${si}`}
                    points={s.points.map((p, i) => `${model.xFor(i)},${model.yFor(p.y)}`).join(' ')}
                    fill="none"
                  />
                  {s.points.map((point, i) => (
                    <circle
                      key={i}
                      cx={model.xFor(i)}
                      cy={model.yFor(point.y)}
                      r={hover?.si === si && hover?.i === i ? 6 : 4}
                      className={`sr-chart-dot is-series-${si}`}
                      tabIndex={0}
                      role="button"
                      aria-label={`${s.label}, ${point.x} : ${format(point.y, unit)}`}
                      onMouseEnter={() => setHover({ si, i })}
                      onMouseLeave={onLeave}
                      onFocus={() => setHover({ si, i })}
                      onBlur={onLeave}
                    />
                  ))}
                </g>
              ))}

          {model.labels.map((label, i) => (
            <text
              key={i}
              x={variant === 'bar' ? PAD.left + i * bandWidth + bandWidth / 2 : model.xFor(i)}
              y={H - 12}
              className="sr-chart-axis"
              textAnchor="middle"
            >
              {label.length > 10 ? `${label.slice(0, 9)}…` : label}
            </text>
          ))}
        </svg>

        {hover && (
          <div className="sr-chart-tip" role="status">
            <strong>{series[hover.si].points[hover.i].x}</strong>
            <span>{format(series[hover.si].points[hover.i].y, unit)}</span>
            {series.length > 1 && <em>{series[hover.si].label}</em>}
          </div>
        )}
      </div>

      {series.length > 1 && (
        <ul className="sr-chart-legend">
          {series.map((s, i) => (
            <li key={i}><span className={`sr-chart-swatch is-series-${i}`} aria-hidden="true" />{s.label}</li>
          ))}
        </ul>
      )}

      {/* Équivalent textuel : accessibilité et repli si le SVG ne s'affiche pas. */}
      <details className="sr-chart-data">
        <summary>Voir les valeurs</summary>
        <table>
          <thead>
            <tr><th>Point</th>{series.map((s, i) => <th key={i}>{s.label}</th>)}</tr>
          </thead>
          <tbody>
            {model.labels.map((label, i) => (
              <tr key={i}>
                <th scope="row">{label}</th>
                {series.map((s, si) => <td key={si}>{format(s.points[i]?.y ?? 0, unit)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </details>
    </figure>
  )
})
