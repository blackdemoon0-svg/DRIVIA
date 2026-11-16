import { createContext, useContext, useEffect, useRef, useState, useCallback } from 'react'

// Moteur de la transition Halloween → Noël.
// La progression (0 → 1) est écrite directement dans une variable CSS (--p) sur la
// racine de la scène via requestAnimationFrame : AUCUN re-render React par frame.
// Seul le « phase » (halloween / transition / noel) est un état React, mis à jour
// quelques fois, pour l'indicateur et le traîneau.

const SceneContext = createContext(null)

const HOLD_MS = 5200 // phase Halloween pure
const TRANSITION_MS = 15000 // fondu Halloween → Noël
const TOTAL_MS = HOLD_MS + TRANSITION_MS

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}

function phaseFor(progress) {
  if (progress <= 0.02) return 'halloween'
  if (progress >= 0.985) return 'noel'
  return 'transition'
}

function readReducedPref() {
  try {
    const stored = localStorage.getItem('veyvro.reduceMotion')
    if (stored === '1') return true
    if (stored === '0') return false
  } catch {
    /* ignore */
  }
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

export function SceneProvider({ children }) {
  const rootRef = useRef(null)
  const progressRef = useRef(0)
  const rafRef = useRef(0)
  const startRef = useRef(0)
  const [phase, setPhase] = useState('halloween')
  const [reducedMotion, setReducedMotionState] = useState(readReducedPref)
  const [runId, setRunId] = useState(0)

  const setReducedMotion = useCallback((value) => {
    setReducedMotionState(value)
    try {
      localStorage.setItem('veyvro.reduceMotion', value ? '1' : '0')
    } catch {
      /* ignore */
    }
  }, [])

  const replay = useCallback(() => {
    setRunId((n) => n + 1)
  }, [])

  useEffect(() => {
    const root = rootRef.current
    if (!root) return

    // Respect des préférences de réduction des animations : scène de Noël statique.
    if (reducedMotion) {
      progressRef.current = 1
      root.style.setProperty('--p', '1')
      document.documentElement.style.setProperty('--p', '1')
      setPhase('noel')
      return
    }

    let lastPhase = 'halloween'
    startRef.current = performance.now()

    const tick = (now) => {
      const elapsed = now - startRef.current
      let progress
      if (elapsed <= HOLD_MS) progress = 0
      else if (elapsed >= TOTAL_MS) progress = 1
      else progress = easeInOutCubic((elapsed - HOLD_MS) / TRANSITION_MS)

      progressRef.current = progress
      root.style.setProperty('--p', progress.toFixed(4))
      document.documentElement.style.setProperty('--p', progress.toFixed(4))
      const nextPhase = phaseFor(progress)
      if (nextPhase !== lastPhase) {
        lastPhase = nextPhase
        setPhase(nextPhase)
      }
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }

    root.style.setProperty('--p', '0')
    document.documentElement.style.setProperty('--p', '0')
    setPhase('halloween')
    rafRef.current = requestAnimationFrame(tick)

    const onVisibility = () => {
      // Pause quand l'onglet est caché pour économiser les ressources.
      if (document.hidden) {
        cancelAnimationFrame(rafRef.current)
      } else if (progressRef.current < 1) {
        // On recale le départ pour ne pas « sauter » la transition.
        const p = progressRef.current
        const elapsedEquivalent = p <= 0 ? 0 : HOLD_MS + invertEase(p) * TRANSITION_MS
        startRef.current = performance.now() - elapsedEquivalent
        rafRef.current = requestAnimationFrame(tick)
      }
    }
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelAnimationFrame(rafRef.current)
      document.removeEventListener('visibilitychange', onVisibility)
    }
  }, [reducedMotion, runId])

  const value = { rootRef, progressRef, phase, reducedMotion, setReducedMotion, replay }
  return <SceneContext.Provider value={value}>{children}</SceneContext.Provider>
}

function invertEase(y) {
  // Approximation numérique inverse de easeInOutCubic pour recaler la timeline.
  let lo = 0
  let hi = 1
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (easeInOutCubic(mid) < y) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

export function useScene() {
  const ctx = useContext(SceneContext)
  if (!ctx) throw new Error('useScene must be used within SceneProvider')
  return ctx
}
