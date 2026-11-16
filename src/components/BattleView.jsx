import { useState } from 'react'
import { BATTLE_CARS } from '../lib/cars'
import { BattleIcon, ChevronIcon, CheckIcon } from './Icons'

// Comparateur « VEYVRO Battle » — fonctionnalité gratuite existante, restylée.
const METRICS = [
  { label: 'Prix', key: 'price', num: 'priceNumber', lowerBetter: true },
  { label: 'Puissance', key: 'power', num: 'powerNumber' },
  { label: 'Couple', key: 'torque', num: 'torqueNumber' },
  { label: '0–100 km/h', key: 'acceleration', num: 'accelerationNumber', lowerBetter: true },
  { label: 'Vitesse max', key: 'topSpeed', num: 'topSpeedNumber' },
  { label: 'Poids', key: 'weight', num: 'weightNumber', lowerBetter: true },
]

export default function BattleView() {
  const [leftId, setLeftId] = useState('m3')
  const [rightId, setRightId] = useState('rs5')
  const left = BATTLE_CARS.find((c) => c.id === leftId) ?? BATTLE_CARS[0]
  const right = BATTLE_CARS.find((c) => c.id === rightId) ?? BATTLE_CARS[1]

  const winner = (m) => {
    const a = left[m.num]
    const b = right[m.num]
    if (a === b) return null
    return m.lowerBetter ? (a < b ? 'left' : 'right') : a > b ? 'left' : 'right'
  }

  return (
    <div className="page-view battle-view">
      <header className="page-head">
        <p className="eyebrow"><span className="eyebrow-dot" /> Le comparatif, en toute clarté</p>
        <h1>VEYVRO <span>Battle</span></h1>
        <p className="page-subtitle">Deux voitures. Chaque détail qui compte.</p>
      </header>

      <div className="battle-picker">
        {[{ id: 'left', value: leftId, set: setLeftId, other: rightId, label: 'Voiture 01' }, { id: 'right', value: rightId, set: setRightId, other: leftId, label: 'Voiture 02' }].map((side) => (
          <div className="battle-select" key={side.id}>
            <label htmlFor={`battle-${side.id}`}>{side.label}</label>
            <div className="select-control">
              <select id={`battle-${side.id}`} value={side.value} onChange={(e) => side.set(e.target.value)}>
                {BATTLE_CARS.map((c) => (
                  <option key={c.id} value={c.id} disabled={c.id === side.other}>{c.name}</option>
                ))}
              </select>
              <ChevronIcon size={16} />
            </div>
          </div>
        ))}
      </div>

      <div className="battle-card">
        <div className="battle-header">
          <div className="battle-car-name is-left">{left.name}</div>
          <div className="battle-vs"><BattleIcon size={20} /></div>
          <div className="battle-car-name is-right">{right.name}</div>
        </div>
        <div className="battle-rows">
          {METRICS.map((m) => {
            const w = winner(m)
            return (
              <div className="battle-row" key={m.key}>
                <div className={`battle-value is-left${w === 'left' ? ' is-winner' : ''}`}>
                  {left[m.key]} {w === 'left' && <CheckIcon size={14} />}
                </div>
                <div className="battle-label">{m.label}</div>
                <div className={`battle-value is-right${w === 'right' ? ' is-winner' : ''}`}>
                  {w === 'right' && <CheckIcon size={14} />} {right[m.key]}
                </div>
              </div>
            )
          })}
        </div>
        <div className="battle-specs">
          {[{ label: 'Moteur', key: 'engine' }, { label: 'Énergie', key: 'fuel' }, { label: 'Transmission', key: 'drivetrain' }].map((s) => (
            <div className="battle-spec-row" key={s.key}>
              <span className="battle-value is-left">{left[s.key]}</span>
              <span className="battle-label">{s.label}</span>
              <span className="battle-value is-right">{right[s.key]}</span>
            </div>
          ))}
        </div>
      </div>
      <p className="battle-note">Données indicatives. VEYVRO peut analyser votre situation précise dans le chat.</p>
    </div>
  )
}
