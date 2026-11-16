import { memo, useState } from 'react'

// Trajet bidirectionnel : requête à l'aller, réponse au retour.
//
// Pourquoi un type dédié plutôt qu'un « flow » linéaire : dans un trajet
// réseau, le RETOUR est une information de premier plan. Une chaîne linéaire
// suggère un sens unique et oblige à ajouter un nœud « retour » artificiel en
// fin de liste. Ici, les deux voies sont dessinées en vis-à-vis :
//   • voie ALLER (haut)    : les étapes sortantes, de gauche à droite
//   • voie RETOUR (bas)    : les étapes entrantes, de droite à gauche
//   • voie LATÉRALE        : les composants hors trajet (DNS), reliés mais distincts
// Le demi-tour est donc visible sans avoir à lire le texte.

const FLOW_STYLE = {
  request: { label: 'Requête (aller)', color: '#c084fc', dash: 'none' },
  response: { label: 'Réponse (retour)', color: '#34d399', dash: 'none' },
  side: { label: 'Hors trajet', color: '#7dd3fc', dash: '5 4' },
}

const LANE_LABELS = {
  request: 'Aller — la requête',
  response: 'Retour — la réponse',
  side: 'Résolution préalable',
}

// Une couleur par voie, la même que la flèche qui la traverse : le lecteur suit
// le parcours sans avoir à comparer des légendes.
function StepCard({ step, isActive, onSelect }) {
  const style = FLOW_STYLE[step.lane] ?? FLOW_STYLE.request
  return (
    <li
      className={`sr-journey-step is-${step.lane}${isActive ? ' is-active' : ''}`}
      tabIndex={0}
      role="button"
      aria-pressed={isActive}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      <div className="sr-journey-step-head">
        <span className="sr-journey-badge" style={{ background: style.color }} aria-hidden="true">
          {step.number}
        </span>
        <span className="sr-journey-step-label">{step.label}</span>
      </div>
      {step.protocol && <span className="sr-journey-protocol">{step.protocol}</span>}
      {step.detail && <p className="sr-journey-step-detail">{step.detail}</p>}
    </li>
  )
}

export default memo(function JourneyDiagram({ spec }) {
  const { steps, components, title, from, to, encryption, notes } = spec
  const [activeNumber, setActiveNumber] = useState(null)

  const requestSteps = steps.filter((s) => s.lane === 'request')
  const responseSteps = steps.filter((s) => s.lane === 'response')
  const sideSteps = steps.filter((s) => s.lane === 'side')
  const active = steps.find((s) => s.number === activeNumber)

  return (
    <div className="sr-journey">
      {title && <h4 className="sr-visual-title">{title}</h4>}

      {/* Bandeau du trajet : origine → destination */}
      {(from || to) && (
        <div className="sr-journey-route" aria-hidden="true">
          <span className="sr-journey-endpoint">{from}</span>
          <span className="sr-journey-route-line">
            <span className="sr-journey-route-arrow is-request" />
            <span className="sr-journey-route-label">requête</span>
          </span>
          <span className="sr-journey-endpoint is-destination">{to}</span>
          <span className="sr-journey-route-line is-return">
            <span className="sr-journey-route-label">réponse</span>
            <span className="sr-journey-route-arrow is-response" />
          </span>
        </div>
      )}

      {/* Voie aller */}
      <section className="sr-journey-lane is-request">
        <h5 className="sr-journey-lane-title">
          <span className="sr-journey-lane-dot is-request" aria-hidden="true" />
          {LANE_LABELS.request}
          <span className="sr-journey-lane-hint">→ vers le serveur</span>
        </h5>
        <ol className="sr-journey-track is-request">
          {requestSteps.map((step) => (
            <StepCard
              key={step.number}
              step={step}
              isActive={step.number === activeNumber}
              onSelect={() => setActiveNumber(step.number === activeNumber ? null : step.number)}
            />
          ))}
        </ol>
      </section>

      {/* Point de rebroussement : rend explicite le demi-tour */}
      <div className="sr-journey-turn" aria-hidden="true">
        <span className="sr-journey-turn-line" />
        <span className="sr-journey-turn-label">le serveur répond — le trajet s'inverse</span>
        <span className="sr-journey-turn-line" />
      </div>

      {/* Voie retour : sens de lecture inversé visuellement */}
      <section className="sr-journey-lane is-response">
        <h5 className="sr-journey-lane-title">
          <span className="sr-journey-lane-dot is-response" aria-hidden="true" />
          {LANE_LABELS.response}
          <span className="sr-journey-lane-hint">← vers mon appareil</span>
        </h5>
        <ol className="sr-journey-track is-response">
          {responseSteps.map((step) => (
            <StepCard
              key={step.number}
              step={step}
              isActive={step.number === activeNumber}
              onSelect={() => setActiveNumber(step.number === activeNumber ? null : step.number)}
            />
          ))}
        </ol>
      </section>

      {/* Composants hors trajet (DNS) */}
      {sideSteps.length > 0 && (
        <section className="sr-journey-lane is-side">
          <h5 className="sr-journey-lane-title">
            <span className="sr-journey-lane-dot is-side" aria-hidden="true" />
            {LANE_LABELS.side}
            <span className="sr-journey-lane-hint">n'achemine pas la donnée</span>
          </h5>
          <ol className="sr-journey-track is-side">
            {sideSteps.map((step) => (
              <StepCard
                key={step.number}
                step={step}
                isActive={step.number === activeNumber}
                onSelect={() => setActiveNumber(step.number === activeNumber ? null : step.number)}
              />
            ))}
          </ol>
        </section>
      )}

      {/* Détail de l'étape sélectionnée */}
      {active && (
        <div className="sr-journey-detail" aria-live="polite">
          <strong>Étape {active.number} — {active.label}</strong>
          <span className={`sr-journey-tag is-${active.lane}`}>{LANE_LABELS[active.lane]}</span>
          {active.detail && <p>{active.detail}</p>}
        </div>
      )}

      {/* Composants et leur rôle */}
      {components?.length > 0 && (
        <>
          <h5 className="sr-journey-components-title">Les composants</h5>
          <ul className="sr-journey-components">
            {components.map((c) => (
              <li key={c.label}>
                <div className="sr-journey-component-head">
                  <strong>{c.label}</strong>
                  {c.role && <span className="sr-journey-role">{c.role}</span>}
                </div>
                {c.detail && <p>{c.detail}</p>}
              </li>
            ))}
          </ul>
        </>
      )}

      {/* Chiffrement */}
      {encryption && (
        <div className="sr-journey-encryption">
          <span className="sr-journey-lock" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="4" y="10" width="16" height="11" rx="2.5" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <div>
            <strong>Chiffrement de bout en bout</strong>
            <p>{encryption}</p>
          </div>
        </div>
      )}

      {notes?.length > 0 && (
        <ul className="sr-journey-notes">
          {notes.map((note, i) => <li key={i}>{note}</li>)}
        </ul>
      )}
    </div>
  )
})
