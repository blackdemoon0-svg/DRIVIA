import { useEffect, useRef } from 'react'
import { useScene } from '../../lib/scene'

// Canvas de particules : poussières violettes (Halloween), flocons + étincelles
// dorées (Noël). Le nombre de particules s'adapte à l'appareil ; la boucle se met
// en pause quand l'onglet est caché. En mode réduit, un rendu statique unique.

export default function Particles() {
  const canvasRef = useRef(null)
  const { progressRef, reducedMotion } = useScene()

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const isMobile = window.matchMedia('(max-width: 768px)').matches
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5)
    let width = 0
    let height = 0
    let raf = 0
    let running = true

    const SNOW_COUNT = isMobile ? 46 : 110
    const MOTE_COUNT = isMobile ? 16 : 34
    const SPARK_COUNT = isMobile ? 10 : 22

    const snow = []
    const motes = []
    const sparks = []

    const rand = (a, b) => a + Math.random() * (b - a)

    function resize() {
      width = canvas.clientWidth
      height = canvas.clientHeight
      canvas.width = Math.floor(width * dpr)
      canvas.height = Math.floor(height * dpr)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    }

    function seed() {
      snow.length = 0
      motes.length = 0
      sparks.length = 0
      for (let i = 0; i < SNOW_COUNT; i++)
        snow.push({ x: rand(0, width), y: rand(0, height), r: rand(0.8, 2.6), s: rand(0.25, 0.9), drift: rand(-0.25, 0.25), o: rand(0.35, 0.9) })
      for (let i = 0; i < MOTE_COUNT; i++)
        motes.push({ x: rand(0, width), y: rand(0, height), r: rand(0.8, 2.2), s: rand(0.08, 0.3), o: rand(0.2, 0.7), hue: rand(265, 300) })
      for (let i = 0; i < SPARK_COUNT; i++)
        sparks.push({ x: rand(0, width), y: rand(0, height * 0.7), r: rand(0.6, 1.6), tw: rand(0, Math.PI * 2), ts: rand(0.01, 0.04) })
    }

    function drawFrame(advance) {
      const p = progressRef.current
      ctx.clearRect(0, 0, width, height)

      // Poussières violettes — visibles surtout en phase Halloween.
      const moteAlpha = Math.max(0, 1 - p * 1.4)
      if (moteAlpha > 0.01) {
        for (const m of motes) {
          if (advance) {
            m.y -= m.s
            m.x += Math.sin((m.y + m.r * 50) * 0.01) * 0.2
            if (m.y < -4) {
              m.y = height + 4
              m.x = rand(0, width)
            }
          }
          ctx.beginPath()
          ctx.fillStyle = `hsla(${m.hue}, 90%, 72%, ${m.o * moteAlpha})`
          ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Flocons — apparaissent avec la transition.
      const snowAlpha = Math.min(1, Math.max(0, (p - 0.12) / 0.5))
      if (snowAlpha > 0.01) {
        for (const f of snow) {
          if (advance) {
            f.y += f.s
            f.x += f.drift + Math.sin(f.y * 0.01) * 0.15
            if (f.y > height + 4) {
              f.y = -4
              f.x = rand(0, width)
            }
            if (f.x < -4) f.x = width + 4
            if (f.x > width + 4) f.x = -4
          }
          ctx.beginPath()
          ctx.fillStyle = `rgba(255,255,255,${f.o * snowAlpha})`
          ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2)
          ctx.fill()
        }
      }

      // Étincelles dorées scintillantes — phase Noël.
      const sparkAlpha = Math.min(1, Math.max(0, (p - 0.55) / 0.4))
      if (sparkAlpha > 0.01) {
        for (const s of sparks) {
          if (advance) s.tw += s.ts
          const twinkle = (Math.sin(s.tw) + 1) / 2
          ctx.beginPath()
          ctx.fillStyle = `rgba(255, 214, 140, ${twinkle * 0.8 * sparkAlpha})`
          ctx.arc(s.x, s.y, s.r * (0.6 + twinkle * 0.6), 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    function loop() {
      if (!running) return
      drawFrame(true)
      raf = requestAnimationFrame(loop)
    }

    resize()
    seed()

    if (reducedMotion) {
      // Rendu statique : quelques flocons figés, pas de boucle.
      drawFrame(false)
    } else {
      raf = requestAnimationFrame(loop)
    }

    const onResize = () => {
      resize()
      seed()
      if (reducedMotion) drawFrame(false)
    }
    const onVisibility = () => {
      if (reducedMotion) return
      if (document.hidden) {
        running = false
        cancelAnimationFrame(raf)
      } else if (!running) {
        running = true
        raf = requestAnimationFrame(loop)
      }
    }
    window.addEventListener('resize', onResize)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      running = false
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', onResize)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reducedMotion, progressRef])

  return <canvas ref={canvasRef} className="scene-particles" aria-hidden="true" />
}
