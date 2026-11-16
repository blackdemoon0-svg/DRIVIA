import { memo, useState } from 'react'

// Couches superposées — idéal pour les couches de l'atmosphère, la structure
// d'une cellule, les strates géologiques. Chaque couche est cliquable.
// L'ordre du tableau est l'ordre visuel de bas en haut (la première couche de
// données étant la plus interne / basse).

export default memo(function LayerStack({ items, title }) {
  const [activeIndex, setActiveIndex] = useState(null)

  return (
    <div className="sr-visual-block sr-layers">
      {title && <h4 className="sr-visual-title">{title}</h4>}
      <div className="sr-layer-stack" role="list">
        {items.map((item, i) => {
          const depth = (i + 1) / items.length
          const isActive = activeIndex === i
          return (
            <button
              key={item.label}
              type="button"
              role="listitem"
              className={`sr-layer${isActive ? ' is-active' : ''}`}
              style={{ '--layer-depth': depth }}
              aria-expanded={isActive}
              onClick={() => setActiveIndex(isActive ? null : i)}
            >
              <span className="sr-layer-band" aria-hidden="true" />
              <span className="sr-layer-text">
                <span className="sr-layer-label">{item.label}</span>
                {item.value && <span className="sr-layer-value">{item.value}</span>}
              </span>
            </button>
          )
        })}
      </div>
      {activeIndex !== null && items[activeIndex].detail && (
        <div className="sr-step-detail" aria-live="polite">
          <strong>{items[activeIndex].label}</strong>
          <p>{items[activeIndex].detail}</p>
        </div>
      )}
    </div>
  )
})
