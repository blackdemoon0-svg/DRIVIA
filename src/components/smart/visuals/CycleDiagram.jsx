import { memo, useState, useMemo, useRef, useLayoutEffect } from 'react'

// Schéma d'un cycle technique à phases successives (ex. moteur à quatre temps).
//
// Deux lectures distinctes, volontairement séparées pour rester exactes :
//   1. le DÉROULÉ numéroté — une vignette par phase, avec une coupe du cylindre
//      dessinée à l'échelle de la phase (position du piston, état des soupapes,
//      contenu du cylindre) ;
//   2. la CHAÎNE CINÉMATIQUE — les pièces et leurs liens orientés typés
//      (gaz, allumage, énergie, mécanique), lus de haut en bas.
// Aucune géométrie n'est codée en dur pour une phase donnée : tout dérive de
// `spec.phases` et `spec.parts`, validés en amont par le schéma.

// --- Repères de la coupe du cylindre ---------------------------------------
const CYL = { x: 150, y: 74, w: 96, h: 150 } // chambre : du haut de culasse au PMB
const PISTON_H = 22
const ROD_LEN = 52

// Position du piston selon le temps du cycle. 0 = point mort haut (PMH),
// 1 = point mort bas (PMB). C'est une convention de dessin : elle traduit la
// cinématique réelle (admission/combustion : descente ; compression/échappement :
// montée), sans prétendre à une échelle angulaire exacte.
const PISTON_TRAVEL = {
  admission: 0.72,
  compression: 0.06,
  detente: 0.72,
  echappement: 0.06,
}

// Les quatre phases dessinées lorsqu'un état n'est pas fourni par le schéma.
const FALLBACK_STATE = ['admission', 'compression', 'detente', 'echappement']

const FLOW_STYLE = {
  gas: { label: 'Gaz / fluide', color: '#60a5fa', dash: '6 4' },
  ignition: { label: 'Allumage', color: '#f472b6', dash: '2 3' },
  energy: { label: 'Énergie', color: '#c084fc', dash: 'none' },
  mechanical: { label: 'Mécanique', color: '#fbbf24', dash: 'none' },
  control: { label: 'Commande', color: '#7dd3fc', dash: '5 4' },
  recovery: { label: 'Récupération', color: '#34d399', dash: '7 5' },
}

// --- Vignette : coupe du cylindre pour une phase ---------------------------
function PhasePiston({ state, number }) {
  const travel = PISTON_TRAVEL[state] ?? 0.5
  const intakeOpen = state === 'admission'
  const exhaustOpen = state === 'echappement'
  const burning = state === 'detente'

  const pistonTop = CYL.y + (CYL.h - PISTON_H) * travel
  const pistonCenterX = CYL.x + CYL.w / 2
  const crankX = pistonCenterX
  const crankY = pistonTop + PISTON_H + ROD_LEN

  // Contenu du cylindre : mélange, gaz comprimés, gaz brûlants, gaz évacués.
  const charge =
    state === 'admission' ? { color: '#60a5fa', opacity: 0.34, label: 'mélange' }
      : state === 'compression' ? { color: '#38bdf8', opacity: 0.5, label: 'comprimé' }
        : state === 'detente' ? { color: '#fb923c', opacity: 0.55, label: 'gaz brûlants' }
          : { color: '#94a3b8', opacity: 0.3, label: 'gaz brûlés' }

  return (
    <svg viewBox="54 12 302 288" className="sr-cycle-vignette" role="img"
      aria-label={`Phase ${number} : ${state ?? 'phase'} — piston ${travel > 0.4 ? 'en bas' : 'en haut'}`}>
      <defs>
        <linearGradient id={`charge-${number}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={charge.color} stopOpacity={charge.opacity + 0.18} />
          <stop offset="100%" stopColor={charge.color} stopOpacity={charge.opacity} />
        </linearGradient>
        <marker id="cyl-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M 0 0 L 10 5 L 0 10 z" fill="#cbd5e1" />
        </marker>
      </defs>

      {/* Culasse et conduits */}
      <rect x={CYL.x - 26} y={CYL.y - 30} width={CYL.w + 52} height="30" rx="6" className="sr-cycle-head" />
      {/* Soupape d'admission (gauche) */}
      <g className={`sr-cycle-valve${intakeOpen ? ' is-open' : ''}`}>
        <line x1={CYL.x + 22} y1={CYL.y - 30} x2={CYL.x + 22} y2={intakeOpen ? CYL.y + 6 : CYL.y - 2} />
        <line x1={CYL.x + 10} y1={intakeOpen ? CYL.y + 6 : CYL.y - 2} x2={CYL.x + 34} y2={intakeOpen ? CYL.y + 6 : CYL.y - 2} className="sr-cycle-valve-head" />
      </g>
      {/* Soupape d'échappement (droite) */}
      <g className={`sr-cycle-valve${exhaustOpen ? ' is-open' : ''}`}>
        <line x1={CYL.x + CYL.w - 22} y1={CYL.y - 30} x2={CYL.x + CYL.w - 22} y2={exhaustOpen ? CYL.y + 6 : CYL.y - 2} />
        <line x1={CYL.x + CYL.w - 34} y1={exhaustOpen ? CYL.y + 6 : CYL.y - 2} x2={CYL.x + CYL.w - 10} y2={exhaustOpen ? CYL.y + 6 : CYL.y - 2} className="sr-cycle-valve-head" />
      </g>
      {/* Bougie */}
      <g className={`sr-cycle-spark${burning ? ' is-firing' : ''}`}>
        <rect x={CYL.x + CYL.w / 2 - 4} y={CYL.y - 30} width="8" height="26" rx="2" />
        {burning && <circle cx={CYL.x + CYL.w / 2} cy={CYL.y + 12} r="9" className="sr-cycle-spark-flash" />}
      </g>

      {/* Corps du cylindre */}
      <rect x={CYL.x} y={CYL.y} width={CYL.w} height={CYL.h} rx="4" className="sr-cycle-wall" />

      {/* Charge dans la chambre, au-dessus du piston */}
      <rect
        x={CYL.x + 2} y={CYL.y + 2} width={CYL.w - 4}
        height={Math.max(0, pistonTop - CYL.y - 2)}
        fill={`url(#charge-${number})`}
      />
      {pistonTop - CYL.y > 30 && (
        <text
          x={CYL.x + CYL.w / 2}
          y={CYL.y + (pistonTop - CYL.y) / 2 + 4}
          textAnchor="middle"
          className="sr-cycle-charge-label"
        >
          {charge.label}
        </text>
      )}
      {/* Chambre très comprimée : une bande de couleur suffit à montrer la charge. */}
      {pistonTop - CYL.y <= 30 && pistonTop - CYL.y > 0 && (
        <rect
          x={CYL.x + 2} y={CYL.y + 2} width={CYL.w - 4} height={pistonTop - CYL.y - 2}
          fill={charge.color} opacity={0.75}
        />
      )}

      {/* Piston */}
      <rect x={CYL.x + 2} y={pistonTop} width={CYL.w - 4} height={PISTON_H} rx="3" className="sr-cycle-piston" />
      <line x1={CYL.x + 10} y1={pistonTop + 7} x2={CYL.x + CYL.w - 10} y2={pistonTop + 7} className="sr-cycle-ring" />
      <line x1={CYL.x + 10} y1={pistonTop + 13} x2={CYL.x + CYL.w - 10} y2={pistonTop + 13} className="sr-cycle-ring" />

      {/* Bielle + vilebrequin */}
      <line
        x1={pistonCenterX} y1={pistonTop + PISTON_H}
        x2={crankX} y2={crankY}
        className="sr-cycle-rod"
      />
      <circle cx={crankX} cy={crankY} r="16" className="sr-cycle-crank" />
      <circle cx={crankX} cy={crankY} r="4" className="sr-cycle-crank-pin" />

      {/* Sens de déplacement du piston */}
      <line
        x1={CYL.x - 16} y1={travel > 0.4 ? pistonTop - 26 : pistonTop + PISTON_H + 20}
        x2={CYL.x - 16} y2={travel > 0.4 ? pistonTop + 2 : pistonTop + PISTON_H - 6}
        className="sr-cycle-motion" markerEnd="url(#cyl-arrow)"
      />

      {/* Flux de gaz : entrant (admission) ou sortant (échappement) */}
      {intakeOpen && (
        <path
          d={`M ${CYL.x - 60} ${CYL.y - 14} L ${CYL.x + 20} ${CYL.y - 14}`}
          className="sr-cycle-gas is-in" markerEnd="url(#cyl-arrow)"
        />
      )}
      {exhaustOpen && (
        <path
          d={`M ${CYL.x + CYL.w - 20} ${CYL.y - 14} L ${CYL.x + CYL.w + 60} ${CYL.y - 14}`}
          className="sr-cycle-gas is-out" markerEnd="url(#cyl-arrow)"
        />
      )}

      {/* Repères PMH / PMB */}
      <text x={CYL.x + CYL.w + 14} y={CYL.y - 2} className="sr-cycle-mark">PMH</text>
      <text x={CYL.x + CYL.w + 14} y={CYL.y + CYL.h + 8} className="sr-cycle-mark">PMB</text>
    </svg>
  )
}

// --- Chaîne cinématique : pièces et liens orientés -------------------------
const NODE_W = 156
const NODE_H = 50
const CELL_W = 196
const CELL_H = 108
const PAD = 26

// Disposition en grille. Les colonnes (col) sont des rangs de lecture : colonne
// 0 = ce qui agit sur le cylindre, colonne suivante = le cylindre, puis la
// chaîne cinématique. Le lien de retour (vilebrequin → piston) est tracé sur le
// côté, jamais à travers les autres pièces.
function usePartLayout(nodes, edges) {
  return useMemo(() => {
    const hasGrid = nodes.every((n) => n.col !== undefined && n.row !== undefined)
    const positions = {}
    if (hasGrid) {
      for (const n of nodes) {
        positions[n.id] = {
          x: PAD + n.col * CELL_W + (CELL_W - NODE_W) / 2,
          y: PAD + n.row * CELL_H,
          w: NODE_W,
          h: NODE_H,
          col: n.col,
          row: n.row,
        }
      }
    } else {
      // Repli automatique : une rangée par pièce, aucune boucle possible.
      nodes.forEach((n, i) => {
        positions[n.id] = { x: PAD, y: PAD + i * (NODE_H + 32), w: NODE_W, h: NODE_H, col: 0, row: i }
      })
    }
    const cols = Math.max(...Object.values(positions).map((p) => p.col)) + 1
    const rows = Math.max(...Object.values(positions).map((p) => p.row)) + 1
    return {
      positions,
      width: PAD * 2 + cols * CELL_W,
      height: PAD * 2 + (rows - 1) * CELL_H + NODE_H,
      hasGrid,
    }
  }, [nodes, edges])
}

// Trace un lien : vertical si même colonne, horizontal sinon, et courbe latérale
// quand la cible est à gauche (mouvement de retour).
function partEdgePath(from, to, index) {
  const sameCol = from.col === to.col
  if (sameCol) {
    const down = to.y > from.y
    const x = from.x + from.w / 2
    const y1 = down ? from.y + from.h : from.y
    const y2 = down ? to.y : to.y + to.h
    return { d: `M ${x} ${y1} L ${x} ${y2}`, labelX: x + 8, labelY: (y1 + y2) / 2 + 3, anchor: 'start' }
  }
  const rightward = to.x > from.x
  if (rightward) {
    const x1 = from.x + from.w
    const y1 = from.y + from.h / 2
    const x2 = to.x
    const y2 = to.y + to.h / 2
    return {
      d: `M ${x1} ${y1} C ${x1 + 26} ${y1}, ${x2 - 26} ${y2}, ${x2} ${y2}`,
      labelX: (x1 + x2) / 2,
      labelY: (y1 + y2) / 2 - 7,
      anchor: 'middle',
    }
  }
  // Retour (cible à gauche) : contournement par le bas, jamais à travers les nœuds.
  const x1 = from.x + from.w / 2
  const y1 = from.y + from.h
  const x2 = to.x + to.w / 2
  const y2 = to.y + to.h
  const depth = Math.max(y1, y2) + 34
  return {
    d: `M ${x1} ${y1} C ${x1} ${depth}, ${x2} ${depth}, ${x2} ${y2}`,
    labelX: (x1 + x2) / 2,
    labelY: depth + 12,
    anchor: 'middle',
  }
}

function PartsChain({ parts }) {
  const [activeId, setActiveId] = useState(null)
  const { nodes, edges, caption } = parts
  const layout = usePartLayout(nodes, edges)

  const usedFlows = [...new Set(edges.map((e) => e.flow))]
  const byId = Object.fromEntries(nodes.map((n) => [n.id, n]))
  const active = nodes.find((n) => n.id === activeId)
  const activeEdges = edges.filter((e) => e.from === activeId || e.to === activeId)

  return (
    <div className="sr-cycle-parts">
      {caption && <p className="sr-cycle-caption">{caption}</p>}
      <div className="sr-cycle-parts-scroll">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="sr-cycle-parts-svg"
          role="group"
          aria-label="Chaîne cinématique des pièces"
        >
          <defs>
            {usedFlows.map((flow) => (
              <marker
                key={flow} id={`part-arrow-${flow}`} viewBox="0 0 10 10"
                refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={FLOW_STYLE[flow]?.color ?? '#fbbf24'} />
              </marker>
            ))}
          </defs>

          {edges.map((edge, i) => {
            const from = layout.positions[edge.from]
            const to = layout.positions[edge.to]
            if (!from || !to) return null
            const style = FLOW_STYLE[edge.flow] ?? FLOW_STYLE.mechanical
            const path = partEdgePath(from, to, i)
            const highlighted = activeId === edge.from || activeId === edge.to
            return (
              <g key={i} className={`sr-cycle-part-edge${highlighted ? ' is-active' : ''}`}>
                <path
                  d={path.d}
                  fill="none"
                  stroke={style.color}
                  strokeWidth={highlighted ? 2.4 : 1.8}
                  strokeDasharray={style.dash === 'none' ? undefined : style.dash}
                  markerEnd={`url(#part-arrow-${edge.flow})`}
                  opacity={activeId && !highlighted ? 0.28 : 0.92}
                />
                {edge.label && (
                  <text
                    x={path.labelX}
                    y={path.labelY}
                    textAnchor={path.anchor}
                    className="sr-cycle-part-edge-label"
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            )
          })}

          {nodes.map((node) => {
            const p = layout.positions[node.id]
            const isActive = node.id === activeId
            return (
              <g
                key={node.id}
                className={`sr-cycle-part-node${isActive ? ' is-active' : ''}`}
                tabIndex={0}
                role="button"
                aria-pressed={isActive}
                aria-label={`${node.label}${node.detail ? `. ${node.detail}` : ''}`}
                onClick={() => setActiveId(isActive ? null : node.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    setActiveId(isActive ? null : node.id)
                  }
                }}
              >
                <rect x={p.x} y={p.y} width={p.w} height={p.h} rx="10" />
                <text x={p.x + p.w / 2} y={p.y + p.h / 2 + 4} textAnchor="middle" className="sr-cycle-part-label">
                  {node.label}
                </text>
              </g>
            )
          })}
        </svg>
      </div>

      <ul className="sr-cycle-legend" aria-label="Types de liens">
        {usedFlows.map((flow) => {
          const style = FLOW_STYLE[flow] ?? FLOW_STYLE.mechanical
          return (
            <li key={flow}>
              <span
                className="sr-cycle-legend-line"
                style={style.dash === 'none'
                  ? { borderTop: `2px solid ${style.color}` }
                  : { background: `repeating-linear-gradient(90deg, ${style.color} 0 5px, transparent 5px 9px)`, height: 3 }}
                aria-hidden="true"
              />
              {style.label}
            </li>
          )
        })}
      </ul>

      {active && (
        <div className="sr-cycle-detail" aria-live="polite">
          <strong>{active.label}</strong>
          {active.detail && <p>{active.detail}</p>}
          {activeEdges.length > 0 && (
            <ul>
              {activeEdges.map((edge, i) => {
                const outgoing = edge.from === active.id
                const other = byId[outgoing ? edge.to : edge.from]
                if (!other) return null
                return (
                  <li key={i}>
                    <span className={`sr-cycle-arrow is-${edge.flow}`}>{outgoing ? '→' : '←'}</span>
                    {(FLOW_STYLE[edge.flow]?.label ?? '').toLowerCase()}
                    {edge.label ? ` · ${edge.label} ` : ' '}
                    <strong>{other.label}</strong>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

// Nombre de colonnes selon la largeur RÉELLE du conteneur (pas du viewport) :
// la carte de réponse est plus étroite que l'écran, et quatre vignettes
// serrées deviennent illisibles. Mesure par ResizeObserver, repli sur 2.
function useColumns() {
  const ref = useRef(null)
  const [columns, setColumns] = useState(2)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return undefined
    const measure = () => {
      const w = el.clientWidth || 0
      setColumns(w >= 980 ? 2 : 1)
    }
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const obs = new ResizeObserver(measure)
    obs.observe(el)
    return () => obs.disconnect()
  }, [])
  return [ref, columns]
}

// --- Composant principal ---------------------------------------------------
export default memo(function CycleDiagram({ spec }) {
  const { phases, parts, title, cycleName, notes } = spec
  const [activePhase, setActivePhase] = useState(1)
  const [rootRef, columns] = useColumns()

  return (
    <div className="sr-cycle" ref={rootRef}>
      {title && <h4 className="sr-visual-title">{title}</h4>}
      {cycleName && <p className="sr-visual-subtitle">{cycleName}</p>}

      {/* Déroulé numéroté des phases */}
      <ol className="sr-cycle-phases" style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }}>
        {phases.map((phase) => {
          const isActive = phase.number === activePhase
          const state = phase.state ?? FALLBACK_STATE[(phase.number - 1) % 4]
          return (
            <li
              key={phase.number}
              className={`sr-cycle-phase${isActive ? ' is-active' : ''}${columns === 1 ? ' is-wide' : ''}`}
              onClick={() => setActivePhase(phase.number)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  setActivePhase(phase.number)
                }
              }}
              tabIndex={0}
              role="button"
              aria-pressed={isActive}
            >
              <div className="sr-cycle-phase-head">
                <span className="sr-cycle-badge" aria-hidden="true">{phase.number}</span>
                <h5 className="sr-cycle-phase-name">{phase.name}</h5>
              </div>

              <div className="sr-cycle-phase-body">
              <PhasePiston state={state} number={phase.number} />

              <div className="sr-cycle-phase-info">
              <dl className="sr-cycle-facts">
                <div>
                  <dt>Piston</dt>
                  <dd>{phase.piston ?? '—'}</dd>
                </div>
                <div>
                  <dt>Soupapes</dt>
                  <dd>{phase.valves ?? '—'}</dd>
                </div>
                {phase.media && (
                  <div>
                    <dt>Contenu</dt>
                    <dd>{phase.media}</dd>
                  </div>
                )}
              </dl>
              {phase.detail && <p className="sr-cycle-phase-detail">{phase.detail}</p>}
              </div>
              </div>
            </li>
          )
        })}
      </ol>

      {/* Chaîne cinématique */}
      {parts && (
        <>
          <h5 className="sr-cycle-parts-title">Pièces et transmission du mouvement</h5>
          <PartsChain parts={parts} />
        </>
      )}

      {notes?.length > 0 && (
        <ul className="sr-cycle-notes">
          {notes.map((note, i) => <li key={i}>{note}</li>)}
        </ul>
      )}
    </div>
  )
})
