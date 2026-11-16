import { memo, useState, useCallback, useRef, lazy } from 'react'
import { Inline } from './Blocks'
import VisualBoundary from './VisualBoundary'
import { ChevronIcon, ArrowIcon } from '../Icons'

const FlowDiagram = lazy(() => import('./visuals/FlowDiagram'))

// Tutoriel interactif : étapes numérotées, progression, navigation clavier.
// Le contenu vient intégralement de la réponse — rien n'est inventé.
export default memo(function StepsPanel({ steps, title, showDiagram = false, summary }) {
  const [active, setActive] = useState(0)
  const [mode, setMode] = useState(showDiagram ? 'diagram' : 'list')
  const listRef = useRef(null)
  const total = steps.length

  const select = useCallback((index) => {
    setActive(Math.min(Math.max(index, 0), total - 1))
  }, [total])

  const onKeyDown = useCallback((event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') {
      event.preventDefault()
      setActive((i) => Math.min(i + 1, total - 1))
    } else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') {
      event.preventDefault()
      setActive((i) => Math.max(i - 1, 0))
    } else if (event.key === 'Home') {
      event.preventDefault(); setActive(0)
    } else if (event.key === 'End') {
      event.preventDefault(); setActive(total - 1)
    }
  }, [total])

  const nodes = steps.map((step, i) => ({ id: `s${i}`, label: step.title, detail: step.detail }))
  const progress = total > 1 ? ((active + 1) / total) * 100 : 100

  return (
    <section className="sr-steps" aria-label={title ?? 'Étapes'}>
      <header className="sr-steps-head">
        <div className="sr-steps-title">
          {title && <h4>{title}</h4>}
          <span className="sr-steps-count">Étape {active + 1} sur {total}</span>
        </div>
        {showDiagram && (
          <div className="sr-viewtoggle" role="group" aria-label="Mode d'affichage des étapes">
            <button type="button" className={mode === 'list' ? 'is-on' : ''} aria-pressed={mode === 'list'} onClick={() => setMode('list')}>
              Liste
            </button>
            <button type="button" className={mode === 'diagram' ? 'is-on' : ''} aria-pressed={mode === 'diagram'} onClick={() => setMode('diagram')}>
              Schéma
            </button>
          </div>
        )}
      </header>

      <div className="sr-progress" role="progressbar" aria-valuemin={1} aria-valuemax={total} aria-valuenow={active + 1} aria-label="Progression dans les étapes">
        <span style={{ width: `${progress}%` }} />
      </div>

      {mode === 'diagram' && showDiagram ? (
        <VisualBoundary fallbackText={steps.map((s, i) => `${i + 1}. ${s.title}`).join('\n')}>
          <FlowDiagram nodes={nodes} activeIndex={active} onSelect={select} />
        </VisualBoundary>
      ) : (
        <ol className="sr-steplist" ref={listRef} onKeyDown={onKeyDown}>
          {steps.map((step, i) => {
            const isActive = i === active
            return (
              <li key={i} className={`sr-step${isActive ? ' is-active' : ''}${i < active ? ' is-done' : ''}`}>
                <button
                  type="button"
                  className="sr-step-head"
                  aria-expanded={isActive}
                  aria-controls={`sr-step-body-${i}`}
                  onClick={() => select(i)}
                >
                  <span className="sr-step-num" aria-hidden="true">{i + 1}</span>
                  <span className="sr-step-label"><Inline text={step.title} /></span>
                  <ChevronIcon size={15} className="sr-step-chevron" />
                </button>
                <div id={`sr-step-body-${i}`} className="sr-step-body" hidden={!isActive}>
                  {step.detail ? <p><Inline text={step.detail} /></p> : null}
                </div>
              </li>
            )
          })}
        </ol>
      )}

      {mode === 'diagram' && steps[active]?.detail && (
        <div className="sr-step-detail" aria-live="polite">
          <strong>{steps[active].title}</strong>
          <p><Inline text={steps[active].detail} /></p>
        </div>
      )}

      <footer className="sr-steps-foot">
        <button type="button" className="sr-nav" onClick={() => select(active - 1)} disabled={active === 0}>
          <ArrowIcon size={14} className="is-prev" /> Précédent
        </button>
        <div className="sr-dots" aria-hidden="true">
          {steps.map((_, i) => <span key={i} className={i === active ? 'is-on' : i < active ? 'is-done' : ''} />)}
        </div>
        <button type="button" className="sr-nav" onClick={() => select(active + 1)} disabled={active === total - 1}>
          Suivant <ArrowIcon size={14} />
        </button>
      </footer>

      {summary && <div className="sr-summary"><Inline text={summary} /></div>}
    </section>
  )
})
