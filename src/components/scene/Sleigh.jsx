import { useEffect, useState } from 'react'
import { useScene } from '../../lib/scene'

// Le traîneau du Père Noël traverse occasionnellement le ciel en phase Noël.
// Une traversée toutes les ~45 s, uniquement quand la phase Noël est atteinte
// et que les animations ne sont pas réduites.
export default function Sleigh() {
  const { phase, reducedMotion } = useScene()
  const [flying, setFlying] = useState(false)

  useEffect(() => {
    if (phase !== 'noel' || reducedMotion) return
    let timeout
    let interval
    const launch = () => {
      setFlying(true)
      timeout = setTimeout(() => setFlying(false), 16000)
    }
    const first = setTimeout(launch, 6000)
    interval = setInterval(launch, 45000)
    return () => {
      clearTimeout(first)
      clearTimeout(timeout)
      clearInterval(interval)
    }
  }, [phase, reducedMotion])

  if (!flying) return null

  return (
    <div className="scene-sleigh" aria-hidden="true">
      <svg viewBox="0 0 320 90" className="sleigh-svg">
        <defs>
          <linearGradient id="sleigh-glow" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="rgba(255,200,120,0)" />
            <stop offset="1" stopColor="rgba(255,200,120,0.5)" />
          </linearGradient>
        </defs>
        {/* traînée lumineuse */}
        <path d="M10 55 Q120 40 250 52" stroke="url(#sleigh-glow)" strokeWidth="3" fill="none" opacity="0.7" />
        {/* rennes (silhouettes) */}
        {[180, 210, 240].map((x, i) => (
          <g key={x} transform={`translate(${x},${38 + (i % 2) * 6})`}>
            <path d="M0 8 L14 6 L20 0 L22 6 L30 8 L26 12 L28 20 L24 14 L18 16 L14 22 L12 14 L4 14 Z" fill="#1a1226" stroke="rgba(255,214,140,0.6)" strokeWidth="0.8" />
          </g>
        ))}
        {/* traîneau */}
        <g transform="translate(258,34)">
          <path d="M0 18 Q2 6 16 6 L40 6 Q52 6 52 16 L50 24 Q48 30 38 30 L12 30 Q2 30 0 22 Z" fill="#7f1d1d" stroke="rgba(255,214,140,0.7)" strokeWidth="1" />
          <path d="M4 30 Q26 38 50 30" stroke="#fbbf24" strokeWidth="2" fill="none" />
          <circle cx="20" cy="2" r="6" fill="#dc2626" />
          <path d="M14 2 Q20 -6 26 2" fill="#dc2626" />
          <circle cx="20" cy="-4" r="2.4" fill="#fff" />
        </g>
        {/* étincelles */}
        {[[150, 30], [130, 44], [100, 36], [70, 50]].map(([x, y], i) => (
          <circle key={i} cx={x} cy={y} r="1.6" fill="#fde68a" opacity="0.8" />
        ))}
      </svg>
    </div>
  )
}
