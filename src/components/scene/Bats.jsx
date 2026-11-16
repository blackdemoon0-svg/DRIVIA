// Chauves-souris traversant le ciel en phase Halloween. Elles s'estompent et
// disparaissent pendant la transition (opacité pilotée par --p).
const BATS = [
  { top: '14%', delay: '0s', duration: '26s', scale: 1 },
  { top: '22%', delay: '6s', duration: '32s', scale: 0.7 },
  { top: '9%', delay: '12s', duration: '24s', scale: 0.85 },
  { top: '30%', delay: '3s', duration: '38s', scale: 0.55 },
  { top: '18%', delay: '18s', duration: '29s', scale: 0.65 },
]

function Bat() {
  return (
    <svg viewBox="0 0 64 32" className="bat-svg" aria-hidden="true">
      <path
        className="bat-wings"
        d="M32 14 C26 6 16 4 8 8 C12 10 12 14 10 18 C18 16 24 18 30 22 L32 20 L34 22 C40 18 46 16 54 18 C52 14 52 10 56 8 C48 4 38 6 32 14 Z"
        fill="#0a0714"
        stroke="rgba(168,85,247,0.5)"
        strokeWidth="0.8"
      />
      <ellipse cx="32" cy="17" rx="3" ry="5" fill="#0a0714" />
    </svg>
  )
}

export default function Bats() {
  return (
    <div className="scene-bats" aria-hidden="true">
      {BATS.map((b, i) => (
        <span
          key={i}
          className="bat"
          style={{ top: b.top, '--delay': b.delay, '--duration': b.duration, '--scale': b.scale }}
        >
          <Bat />
        </span>
      ))}
    </div>
  )
}
