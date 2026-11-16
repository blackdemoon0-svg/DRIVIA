import { useEffect } from 'react'
import { BrandMark, CloseIcon, ShieldIcon, SparklesIcon, CarIcon } from './Icons'

export default function AboutDialog({ onClose }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div className="dialog-backdrop" onMouseDown={onClose}>
      <section className="dialog about-dialog" role="dialog" aria-modal="true" aria-labelledby="about-title" onMouseDown={(e) => e.stopPropagation()}>
        <button className="dialog-close" type="button" autoFocus aria-label="Fermer" onClick={onClose}>
          <CloseIcon size={18} />
        </button>
        <div className="about-brand"><BrandMark size={38} /></div>
        <h2 id="about-title">VEYVRO<span className="brand-dot">.</span></h2>
        <p className="dialog-intro">L'automobile, en toute clarté. Votre assistant IA dédié à l'automobile.</p>
        <div className="about-points">
          <div className="about-point"><CarIcon size={19} /><span>Devis, voyants, comparatifs et occasions : une lecture claire de chaque situation.</span></div>
          <div className="about-point"><SparklesIcon size={19} /><span>Une expérience immersive, pensée pour être aussi agréable qu'utile.</span></div>
          <div className="about-point"><ShieldIcon size={19} /><span>Une aide à la décision pédagogique, à confirmer par un professionnel pour les choix importants.</span></div>
        </div>
        <p className="about-version">Version 2.0 — Édition Hiver</p>
      </section>
    </div>
  )
}
