// Logo VEYVRO intégré au centre de la scène, avec halo lumineux évoluant
// du violet vers l'or selon la phase.
export default function Logo({ compact = false }) {
  return (
    <div className={`scene-logo${compact ? ' is-compact' : ''}`}>
      <div className="scene-logo-halo" aria-hidden="true" />
      <div className="scene-logo-word" aria-label="VEYVRO">
        <svg viewBox="0 0 32 32" className="scene-logo-mark" aria-hidden="true" fill="none">
          <path d="M8 5.5h8a10.5 10.5 0 1 1-9.1 5.3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
          <path d="M6 4.5v7h7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
          <path d="M12.4 11.5 16 20.5 19.6 11.5" stroke="var(--rim)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span className="scene-logo-text">
          VEYVRO<span className="scene-logo-dot">.</span>
        </span>
      </div>
      {!compact && <p className="scene-logo-tagline">L'automobile, en toute clarté.</p>}
    </div>
  )
}
