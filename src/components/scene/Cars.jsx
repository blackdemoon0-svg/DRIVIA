import { useScene } from '../../lib/scene'

// Trois véhicules photoréalistes (photos professionnelles détourées), positionnés
// gauche / centre / droite. Les voitures ne sont plus dessinées en SVG : chaque
// SVG n'est qu'un conteneur compositeur qui accueille la photo détourée, ses
// phares LED lumineux, leurs faisceaux au sol et le reflet sur sol mouillé.
// La couleur d'ambiance (--rim) évolue avec --p ; seul un léger flottement
// vertical « premium » anime l'ensemble. Aucune translation excessive.
//
// Sources des photographies (usage presse / éditorial — vérifier les droits
// avant toute exploitation commerciale) :
//   BMW M5 G90        : autobics.com (visuel studio constructeur)
//   Mercedes-AMG G 63 : caricos.com (photo presse Grand Edition)
//   Audi Q9 2027      : cars.com (visuel studio couleur Mythos Black)

const CARS = [
  {
    id: 'm5',
    label: 'BMW M5',
    className: 'car-left',
    src: '/scene/cars/m5.webp',
    alt: 'BMW M5 noire, vue trois quarts avant, phares LED allumés',
    imgW: 1004,
    imgH: 457,
    imgX: 0,
    vbW: 1004,
    vbH: 577,
    groundY: 457,
    // Phares : le plus proche (aile gauche) et le plus lointain (aile droite).
    headlights: [
      { cx: 424, cy: 213, rx: 62, ry: 20, strip: 'M370 213 L478 208', haloRx: 92, haloRy: 34 },
      { cx: 34, cy: 208, rx: 22, ry: 15, strip: 'M16 208 L52 205', haloRx: 40, haloRy: 26 },
    ],
    pool: { cx: 330, cy: 492, rx: 260, ry: 30 },
    beams: ['M380 220 L250 500 L470 500 Z', 'M40 214 L-40 500 L130 500 Z'],
    led: { core: '#ffffff', mid: '#e9d5ff', glow: '168,85,247', strip: '#e9d5ff' },
  },
  {
    id: 'g63',
    label: 'Mercedes-AMG G 63',
    className: 'car-center',
    src: '/scene/cars/g63.webp',
    alt: 'Mercedes-AMG G 63 noire, vue trois quarts avant, phares ronds LED allumés',
    imgW: 725,
    imgH: 452,
    imgX: 99.5,
    vbW: 924,
    vbH: 572,
    groundY: 452,
    headlights: [
      { cx: 419, cy: 190, rx: 30, ry: 30, ring: 30, haloRx: 56, haloRy: 52 },
      { cx: 143, cy: 199, rx: 20, ry: 20, ring: 20, haloRx: 40, haloRy: 38 },
    ],
    pool: { cx: 400, cy: 488, rx: 270, ry: 32 },
    beams: ['M419 200 L300 505 L540 505 Z', 'M143 208 L40 505 L250 505 Z'],
    led: { core: '#ffffff', mid: '#f0f4ff', glow: '200,220,255', strip: '#eef2ff' },
  },
  {
    id: 'q9',
    label: 'Audi Q9',
    className: 'car-right',
    src: '/scene/cars/q9.webp',
    alt: 'Audi Q9 noir, vue trois quarts avant, signature LED allumée',
    imgW: 626,
    imgH: 290,
    imgX: 8,
    vbW: 642,
    vbH: 390,
    groundY: 290,
    headlights: [
      { cx: 196, cy: 122, rx: 52, ry: 9, strip: 'M148 122 L244 120', haloRx: 78, haloRy: 22 },
      { cx: 202, cy: 152, rx: 26, ry: 16, strip: 'M180 152 L224 150', haloRx: 44, haloRy: 28 },
      { cx: 16, cy: 146, rx: 12, ry: 12, strip: 'M6 146 L26 144', haloRx: 24, haloRy: 22 },
    ],
    pool: { cx: 210, cy: 322, rx: 200, ry: 24 },
    beams: ['M196 128 L110 330 L290 330 Z', 'M16 150 L-50 330 L90 330 Z'],
    led: { core: '#ffffff', mid: '#f5f8ff', glow: '220,230,255', strip: '#f5f8ff' },
  },
]

function CarSvg({ car }) {
  const { id, src, alt, imgW, imgH, imgX, vbW, vbH, groundY, headlights, pool, beams, led } = car
  const uid = `car-${id}`
  const reflectH = vbH - groundY

  return (
    <svg viewBox={`0 0 ${vbW} ${vbH}`} className="car-svg" role="img" aria-label={alt}>
      <defs>
        <radialGradient id={`${uid}-led`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={led.core} />
          <stop offset="0.4" stopColor={led.mid} />
          <stop offset="1" stopColor={`rgba(${led.glow},0)`} />
        </radialGradient>
        <linearGradient id={`${uid}-beam`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={`rgba(${led.glow},0.42)`} />
          <stop offset="1" stopColor={`rgba(${led.glow},0)`} />
        </linearGradient>
        <radialGradient id={`${uid}-pool`} cx="0.5" cy="0.5" r="0.5">
          <stop offset="0" stopColor={`rgba(${led.glow},0.38)`} />
          <stop offset="1" stopColor={`rgba(${led.glow},0)`} />
        </radialGradient>
        <linearGradient id={`${uid}-reflect-fade`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.34" />
          <stop offset="0.55" stopColor="#ffffff" stopOpacity="0.12" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
        </linearGradient>
        <mask id={`${uid}-reflect-mask`} maskUnits="userSpaceOnUse" x="0" y={groundY} width={vbW} height={reflectH}>
          <rect x="0" y={groundY} width={vbW} height={reflectH} fill={`url(#${uid}-reflect-fade)`} />
        </mask>
      </defs>

      {/* Faisceaux + flaque de lumière au sol */}
      <g className="car-beams">
        <ellipse cx={pool.cx} cy={pool.cy} rx={pool.rx} ry={pool.ry} fill={`url(#${uid}-pool)`} />
        {beams.map((d, i) => (
          <path key={i} d={d} fill={`url(#${uid}-beam)`} opacity="0.45" />
        ))}
      </g>

      {/* Reflet sur sol mouillé : photo inversée, estompée par un masque dégradé */}
      <g className="car-reflection" mask={`url(#${uid}-reflect-mask)`}>
        <image
          href={src}
          x={imgX}
          y="0"
          width={imgW}
          height={imgH}
          transform={`translate(0 ${2 * groundY}) scale(1 -1)`}
          preserveAspectRatio="none"
        />
      </g>

      {/* Ombre de contact au sol */}
      <ellipse
        className="car-shadow"
        cx={imgX + imgW / 2}
        cy={groundY + 4}
        rx={imgW * 0.42}
        ry={Math.max(10, imgH * 0.035)}
        fill="rgba(0,0,0,0.6)"
      />

      {/* Photographie détourée du véhicule */}
      <image href={src} x={imgX} y="0" width={imgW} height={imgH} className="car-photo" preserveAspectRatio="none" />

      {/* Phares LED lumineux */}
      {headlights.map((h, i) => (
        <g key={i} className={`headlight headlight-${i === 0 ? 'left' : 'right'}`}>
          <ellipse className="led-core" cx={h.cx} cy={h.cy} rx={h.rx} ry={h.ry} fill={`url(#${uid}-led)`} />
          {h.strip && (
            <path className="led-strip" d={h.strip} stroke={led.strip} strokeWidth="3" strokeLinecap="round" fill="none" />
          )}
          {h.ring && (
            <circle className="led-ring" cx={h.cx} cy={h.cy} r={h.ring} fill="none" stroke={led.strip} strokeWidth="3" />
          )}
        </g>
      ))}
      {headlights.map((h, i) => (
        <ellipse
          key={`halo-${i}`}
          className="headlight-halo"
          cx={h.cx}
          cy={h.cy}
          rx={h.haloRx}
          ry={h.haloRy}
          fill={`url(#${uid}-led)`}
        />
      ))}
    </svg>
  )
}

export default function Cars() {
  const { reducedMotion } = useScene()
  return (
    <div className={`scene-cars${reducedMotion ? ' is-static' : ''}`} aria-hidden={false}>
      {CARS.map((car, i) => (
        <figure key={car.id} className={`car ${car.className}`} style={{ '--car-index': i }}>
          <CarSvg car={car} />
          <figcaption className="car-label">{car.label}</figcaption>
        </figure>
      ))}
    </div>
  )
}
