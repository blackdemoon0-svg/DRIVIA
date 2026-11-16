import { useEffect, useRef } from 'react'
import { useScene } from '../../lib/scene'
import Particles from './Particles'
import Cars from './Cars'
import Bats from './Bats'
import Sleigh from './Sleigh'

// Scène immersive plein écran, derrière l'interface. Deux décors cinématiques
// (Halloween / Noël) se fondent via --p. Parallaxe légère à la souris sur desktop.
// Tous les calques sont décoratifs (aria-hidden) et n'interceptent aucun clic.
export default function Scene() {
  const { rootRef, reducedMotion } = useScene()
  const parallaxRef = useRef(null)

  useEffect(() => {
    if (reducedMotion) return
    const fine = window.matchMedia('(pointer: fine)').matches
    if (!fine) return
    const el = parallaxRef.current
    if (!el) return
    let raf = 0
    let tx = 0
    let ty = 0
    let cx = 0
    let cy = 0
    const onMove = (e) => {
      const nx = (e.clientX / window.innerWidth - 0.5) * 2
      const ny = (e.clientY / window.innerHeight - 0.5) * 2
      tx = nx * 10
      ty = ny * 7
      if (!raf) raf = requestAnimationFrame(apply)
    }
    const apply = () => {
      cx += (tx - cx) * 0.06
      cy += (ty - cy) * 0.06
      el.style.transform = `translate3d(${cx.toFixed(2)}px, ${cy.toFixed(2)}px, 0)`
      if (Math.abs(tx - cx) > 0.05 || Math.abs(ty - cy) > 0.05) raf = requestAnimationFrame(apply)
      else raf = 0
    }
    window.addEventListener('mousemove', onMove, { passive: true })
    return () => {
      window.removeEventListener('mousemove', onMove)
      cancelAnimationFrame(raf)
    }
  }, [reducedMotion])

  return (
    <div ref={rootRef} className="scene" aria-hidden="true">
      <div ref={parallaxRef} className="scene-parallax">
        {/* Décors */}
        <div className="scene-bg scene-bg-halloween" />
        <div className="scene-bg scene-bg-noel" />
        {/* Étalonnage colorimétrique : violet -> rouge/or/blanc */}
        <div className="scene-grade" />
        {/* Brume volumétrique */}
        <div className="scene-mist scene-mist-a" />
        <div className="scene-mist scene-mist-b" />
        {/* Chauves-souris (Halloween) */}
        <Bats />
        {/* Traîneau (Noël) */}
        <Sleigh />
        {/* Particules : poussières violettes, flocons, étincelles */}
        <Particles />
        {/* Vignette */}
        <div className="scene-vignette" />
      </div>
      {/* Véhicules au premier plan — hors parallaxe pour un ancrage stable au sol */}
      <Cars />
    </div>
  )
}
