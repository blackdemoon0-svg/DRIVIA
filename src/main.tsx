import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AuthProvider } from './lib/auth'
import { SceneProvider } from './lib/scene'
import './index.css'
import './styles/smart.css'

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <AuthProvider>
      <SceneProvider>
        <App />
      </SceneProvider>
    </AuthProvider>
  </React.StrictMode>
)
