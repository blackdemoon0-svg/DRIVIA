import { memo, useState, useRef, useLayoutEffect } from 'react'
import { Inline } from '../Blocks'
import { ArrowIcon } from '../../Icons'

// Diagramme de flux interactif.
//
// Desktop : grille de colonnes égales. Un connecteur n'apparaît QU'ENTRE deux
// nœuds réellement adjacents d'une même rangée — jamais de flèche qui pointe
// vers le vide en fin de ligne. Le passage à la rangée suivante est signalé par
// un discret « suite » pour que l'ordre de lecture reste évident.
//
// Mobile (< 640 px) : colonne verticale, flèches vers le bas, séquence limitée
// à 6 nœuds avec dépliage explicite.

const MOBILE_MAX = 6
const MIN_COL_WIDTH = 165

export default memo(function FlowDiagram({ nodes, activeIndex = 0, onSelect, loop = false }) {
  const count = nodes.length
  const trackRef = useRef(null)
  const [columns, setColumns] = useState(1)

  // Nombre de colonnes réellement rendues : pilote la détection de fin de rangée.
  useLayoutEffect(() => {
    const el = trackRef.current
    if (!el || typeof ResizeObserver === 'undefined') return undefined
    const measure = () => {
      const width = el.clientWidth
      const next = Math.max(1, Math.floor(width / MIN_COL_WIDTH))
      setColumns(next)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const isMobile = columns <= 1
  const isRowEnd = (index) => !isMobile && (index + 1) % columns === 0
  const isLastOfRow = (index) => isRowEnd(index) && index < count - 1

  return (
    <div className="sr-flow" role="group" aria-label="Diagramme du processus">
      <ol className={`sr-flow-track${count > MOBILE_MAX ? ' has-overflow' : ''}`} ref={trackRef}>
        {nodes.map((node, i) => (
          <li
            key={node.id}
            className={`sr-flow-item${i === activeIndex ? ' is-active' : ''}${isRowEnd(i) ? ' is-row-end' : ''}`}
          >
            <button
              type="button"
              className="sr-flow-node"
              aria-pressed={i === activeIndex}
              aria-label={`Étape ${i + 1} sur ${count} : ${node.label}`}
              onClick={() => onSelect?.(i)}
            >
              <span className="sr-flow-index" aria-hidden="true">{i + 1}</span>
              <span className="sr-flow-label"><Inline text={node.label} /></span>
            </button>
            {i < count - 1 && !isRowEnd(i) && (
              <span className="sr-flow-arrow" aria-hidden="true"><ArrowIcon size={14} /></span>
            )}
            {isLastOfRow(i) && (
              <span className="sr-flow-wrap" aria-hidden="true">↳ suite</span>
            )}
          </li>
        ))}
      </ol>

      {count > MOBILE_MAX && (
        <details className="sr-flow-more">
          <summary>Voir les {count - MOBILE_MAX} étapes restantes</summary>
          <ol className="sr-flow-track is-extra" start={MOBILE_MAX + 1}>
            {nodes.slice(MOBILE_MAX).map((node, k) => {
              const i = k + MOBILE_MAX
              return (
                <li key={node.id} className={`sr-flow-item${i === activeIndex ? ' is-active' : ''}`}>
                  <button
                    type="button"
                    className="sr-flow-node"
                    aria-pressed={i === activeIndex}
                    aria-label={`Étape ${i + 1} sur ${count} : ${node.label}`}
                    onClick={() => onSelect?.(i)}
                  >
                    <span className="sr-flow-index" aria-hidden="true">{i + 1}</span>
                    <span className="sr-flow-label"><Inline text={node.label} /></span>
                  </button>
                </li>
              )
            })}
          </ol>
        </details>
      )}

      {loop && <div className="sr-flow-loop" aria-hidden="true">cycle continu ↺</div>}
    </div>
  )
})
