import { useState, useEffect } from 'react'
import { useScene } from '../lib/scene'
import { isSmartEnabled, setSmartEnabled, onSmartChange } from '../lib/smart/prefs'
import { MoonIcon, SnowIcon, ReplayIcon, SparklesIcon, InfoIcon } from './Icons'

// Paramètres — préférences d'animation et de scène. Aucun réglage commercial.
export default function SettingsView() {
  const { reducedMotion, setReducedMotion, replay, phase } = useScene()
  const [smart, setSmart] = useState(isSmartEnabled)
  useEffect(() => onSmartChange(setSmart), [])
  const phaseLabel = phase === 'halloween' ? 'Halloween' : phase === 'noel' ? 'Noël' : 'Transition'

  return (
    <div className="page-view">
      <header className="page-head">
        <p className="eyebrow"><span className="eyebrow-dot" /> Préférences</p>
        <h1>Para<span>mètres</span></h1>
        <p className="page-subtitle">Ajustez l'expérience visuelle à votre goût et à votre appareil.</p>
      </header>

      <div className="settings-group">
        <h2 className="settings-group-title"><SparklesIcon size={17} /> Expérience visuelle</h2>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Réduire les animations</span>
            <span className="setting-description">Désactive la transition animée, les particules et les mouvements. Recommandé sur les appareils moins puissants ou si vous préférez le calme.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={reducedMotion}
            className={`toggle${reducedMotion ? ' is-on' : ''}`}
            onClick={() => setReducedMotion(!reducedMotion)}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Réponses intelligentes</span>
            <span className="setting-description">Affiche les réponses sous forme de schémas, étapes, tableaux et graphiques adaptés à la question. Désactivé : affichage texte simple.</span>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={smart}
            className={`toggle${smart ? ' is-on' : ''}`}
            onClick={() => setSmartEnabled(!smart)}
          >
            <span className="toggle-thumb" />
          </button>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Ambiance actuelle</span>
            <span className="setting-description">La scène évolue automatiquement d'Halloween vers Noël.</span>
          </div>
          <span className="season-badge">
            {phase === 'noel' ? <SnowIcon size={15} /> : <MoonIcon size={15} />}
            {phaseLabel}
          </span>
        </div>

        <div className="setting-row">
          <div className="setting-info">
            <span className="setting-label">Rejouer la transition</span>
            <span className="setting-description">Relance l'animation Halloween → Noël depuis le début.</span>
          </div>
          <button type="button" className="secondary-button" onClick={replay} disabled={reducedMotion}>
            <ReplayIcon size={16} /> Rejouer
          </button>
        </div>
      </div>

      <div className="settings-note">
        <InfoIcon size={16} />
        <span>VEYVRO respecte automatiquement la préférence système « réduire les animations » de votre appareil.</span>
      </div>
    </div>
  )
}
