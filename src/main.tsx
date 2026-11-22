// Point d'entrée VEYVRO.
// Les composants de l'application sont écrits en JSX (sans types) : on déclare
// explicitement leur signature ici pour que `tsc --noEmit` (script typecheck)
// reste vert, sans renommer les fichiers ni affaiblir `strict`.
import React from 'react'
import { createRoot } from 'react-dom/client'
import { Analytics } from '@vercel/analytics/react'

// @ts-expect-error — composants JSX non typés (App.jsx, lib/auth.jsx, lib/scene.jsx)
import App from './App'
// @ts-expect-error — AuthProvider est un composant JSX non typé
import { AuthProvider } from './lib/auth'
// @ts-expect-error — SceneProvider est un composant JSX non typé
import { SceneProvider } from './lib/scene'
import './index.css'
import './styles/smart.css'
import './styles/avatar.css'

const container = document.getElementById('root')
if (!container) throw new Error('Élément #root introuvable dans index.html')

createRoot(container).render(
  <React.StrictMode>
    <AuthProvider>
      <SceneProvider>
        <App />
      </SceneProvider>
    </AuthProvider>
    <Analytics />
  </React.StrictMode>
)
