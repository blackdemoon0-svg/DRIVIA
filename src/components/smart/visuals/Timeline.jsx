import { memo, useState } from 'react'
import { Inline } from '../Blocks'
import { ChevronIcon } from '../../Icons'

// Frise chronologique interactive : chaque événement se déplie au clic.
export default memo(function Timeline({ events, title }) {
  const [open, setOpen] = useState(null)
  return (
    <section className="sr-timeline" aria-label={title ?? 'Chronologie'}>
      {title && <h4>{title}</h4>}
      <ol>
        {events.map((event, i) => {
          const isOpen = open === i
          const expandable = Boolean(event.detail)
          return (
            <li key={i} className={isOpen ? 'is-open' : ''}>
              <span className="sr-timeline-dot" aria-hidden="true" />
              <div className="sr-timeline-body">
                <button
                  type="button"
                  className="sr-timeline-head"
                  aria-expanded={expandable ? isOpen : undefined}
                  disabled={!expandable}
                  onClick={() => setOpen(isOpen ? null : i)}
                >
                  {event.date && <span className="sr-timeline-date">{event.date}</span>}
                  <span className="sr-timeline-label"><Inline text={event.label} /></span>
                  {expandable && <ChevronIcon size={14} className="sr-timeline-chevron" />}
                </button>
                {expandable && (
                  <div className="sr-timeline-detail" hidden={!isOpen}>
                    <Inline text={event.detail} />
                  </div>
                )}
              </div>
            </li>
          )
        })}
      </ol>
    </section>
  )
})
