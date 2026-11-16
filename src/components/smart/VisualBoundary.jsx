import { Component, Suspense } from 'react'
import { VisualFallback } from './Blocks'

// Filet de sécurité : si une visualisation échoue, la réponse reste lisible.
export default class VisualBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    if (import.meta.env?.DEV) console.warn('[Smart Responses] visuel en repli :', error?.message)
  }

  render() {
    if (this.state.failed) {
      return <VisualFallback raw={this.props.fallbackText ?? 'Données du visuel indisponibles.'} />
    }
    return (
      <Suspense fallback={<div className="sr-visual-skeleton" aria-hidden="true" />}>
        {this.props.children}
      </Suspense>
    )
  }
}
