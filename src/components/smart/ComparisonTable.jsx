import { memo } from 'react'
import { Inline } from './Blocks'
import { CheckIcon, CloseIcon } from '../Icons'

// Comparatif professionnel : tableau responsive (pas de scroll horizontal sur
// mobile : chaque ligne devient un bloc libellé), avantages / inconvénients,
// puis conclusion. Toutes les valeurs proviennent de la réponse.
export default memo(function ComparisonTable({ title, header, rows, pros, cons, conclusion }) {
  const columns = header.slice(1)

  return (
    <section className="sr-compare" aria-label={title ?? 'Comparaison'}>
      {title && <h4 className="sr-compare-title">{title}</h4>}

      <div className="sr-compare-grid" role="table" aria-label={title ?? 'Tableau comparatif'}>
        <div className="sr-compare-row is-head" role="row">
          <span className="sr-compare-cell is-label" role="columnheader">Critère</span>
          {columns.map((col, i) => (
            <span key={i} className="sr-compare-cell" role="columnheader"><Inline text={col} /></span>
          ))}
        </div>
        {rows.map((row, r) => (
          <div key={r} className="sr-compare-row" role="row">
            <span className="sr-compare-cell is-label" role="rowheader"><Inline text={row[0] ?? ''} /></span>
            {columns.map((col, c) => (
              <span key={c} className="sr-compare-cell" role="cell" data-column={col}>
                <Inline text={row[c + 1] ?? '—'} />
              </span>
            ))}
          </div>
        ))}
      </div>

      {(pros || cons) && (
        <div className="sr-proscons">
          {columns.map((col) => {
            const good = pros?.[col]
            const bad = cons?.[col]
            if (!good && !bad) return null
            return (
              <article key={col} className="sr-proscons-card">
                <h5>{col}</h5>
                {good && (
                  <ul className="is-pros">
                    {good.map((item, i) => (
                      <li key={i}><CheckIcon size={13} aria-hidden="true" /><span><Inline text={item} /></span></li>
                    ))}
                  </ul>
                )}
                {bad && (
                  <ul className="is-cons">
                    {bad.map((item, i) => (
                      <li key={i}><CloseIcon size={13} aria-hidden="true" /><span><Inline text={item} /></span></li>
                    ))}
                  </ul>
                )}
              </article>
            )
          })}
        </div>
      )}

      {conclusion && (
        <div className="sr-conclusion">
          <span className="sr-conclusion-label">En bref</span>
          <p><Inline text={conclusion} /></p>
        </div>
      )}
    </section>
  )
})
