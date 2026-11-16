import { memo, useMemo, lazy, useState, useEffect } from 'react'
import { analyzeResponse } from '../../lib/smart'
import { planVisual } from '../../lib/smart/plan'
import { isSmartEnabled, onSmartChange } from '../../lib/smart/prefs'
import { useScene } from '../../lib/scene'
import Block, { Inline, VisualFallback } from './Blocks'
import StepsPanel from './StepsPanel'
import ComparisonTable from './ComparisonTable'
import MathBlock from './MathBlock'
import VisualBoundary from './VisualBoundary'
import GeneratedImage from './GeneratedImage'
import { SparklesIcon } from '../Icons'

const FlowDiagram = lazy(() => import('./visuals/FlowDiagram'))
const Timeline = lazy(() => import('./visuals/Timeline'))
const Chart = lazy(() => import('./visuals/Chart'))
const TreeDiagram = lazy(() => import('./visuals/TreeDiagram'))
const ConceptMap = lazy(() => import('./visuals/ConceptMap'))
const PieChart = lazy(() => import('./visuals/PieChart'))
const LayerStack = lazy(() => import('./visuals/LayerStack'))
const SystemDiagram = lazy(() => import('./visuals/SystemDiagram'))
const CycleDiagram = lazy(() => import('./visuals/CycleDiagram'))
const JourneyDiagram = lazy(() => import('./visuals/JourneyDiagram'))

const KIND_LABELS = {
  educational: 'Explication',
  steps: 'Pas à pas',
  comparison: 'Comparatif',
  technical: 'Technique',
  math: 'Calcul',
  diagram: 'Schéma',
  system: 'Système',
  cycle: 'Cycle',
  journey: 'Parcours',
  data: 'Données',
  visual: 'Image générée',
  image: 'Image générée',
}

// Formats pour lesquels un schéma ajouté serait hors sujet.
const NO_PLANNED = new Set(['conversation', 'creative', 'technical', 'steps', 'comparison', 'math', 'system'])

const RESULT_RE = /^(r[ée]sultat|result|answer|r[ée]ponse finale|total)\s*[:=]\s*(.+)$/i

// Découpe un item de liste en titre + détail, sans rien réécrire.
function splitStep(item) {
  const bold = /^\*\*(.+?)\*\*\s*[:.—–-]?\s*(.*)$/.exec(item)
  if (bold) return { title: bold[1], detail: bold[2] || undefined }
  const colon = /^(.{3,90}?)\s*[:—–]\s+(.+)$/.exec(item)
  if (colon) return { title: colon[1], detail: colon[2] }
  const dash = /^(.{3,90}?)\s+-\s+(.+)$/.exec(item)
  if (dash) return { title: dash[1], detail: dash[2] }
  if (item.length > 96) {
    const cut = item.slice(0, 96)
    const at = cut.lastIndexOf(' ')
    return { title: `${cut.slice(0, at > 40 ? at : 96)}…`, detail: item }
  }
  return { title: item, detail: undefined }
}

// Bloc visuel explicite produit par le modèle (déjà validé par le schéma).
function ExplicitVisual({ spec, stable }) {
  const [active, setActive] = useState(0)
  if (spec.type === 'chart') {
    return <VisualBoundary fallbackText={JSON.stringify(spec, null, 2)}><Chart spec={spec} /></VisualBoundary>
  }
  if (spec.type === 'timeline') {
    return <VisualBoundary fallbackText={spec.events.map((e) => `${e.date ?? ''} ${e.label}`).join('\n')}><Timeline events={spec.events} title={spec.title} /></VisualBoundary>
  }
  if (spec.type === 'system') {
    return (
      <VisualBoundary
        fallbackText={[
          spec.title,
          ...spec.nodes.map((n) => `• ${n.label}${n.detail ? ` : ${n.detail}` : ''}`),
          ...spec.edges.map((e) => `  ${e.from} → ${e.to}${e.label ? ` (${e.label})` : ''}`),
        ].filter(Boolean).join('\n')}
      >
        <SystemDiagram spec={spec} />
      </VisualBoundary>
    )
  }
  if (spec.type === 'journey') {
    return (
      <VisualBoundary
        fallbackText={[
          spec.title,
          `${spec.from ?? ''} → ${spec.to ?? ''}`,
          ...spec.steps.map((st) => `${st.number}. ${st.label}${st.detail ? ` : ${st.detail}` : ''}`),
          ...(spec.components ?? []).map((c) => `• ${c.label}${c.role ? ` (${c.role})` : ''}`),
          spec.encryption ? `Chiffrement : ${spec.encryption}` : '',
        ].filter(Boolean).join('\n')}
      >
        <JourneyDiagram spec={spec} />
      </VisualBoundary>
    )
  }
  if (spec.type === 'cycle') {
    return (
      <VisualBoundary
        fallbackText={[
          spec.title,
          ...spec.phases.map((p) => `${p.number}. ${p.name}${p.detail ? ` : ${p.detail}` : ''}`),
          ...(spec.parts?.nodes ?? []).map((n) => `• ${n.label}${n.detail ? ` : ${n.detail}` : ''}`),
        ].filter(Boolean).join('\n')}
      >
        <CycleDiagram spec={spec} />
      </VisualBoundary>
    )
  }
  if (spec.type === 'diagram') {
    return <VisualBoundary fallbackText={JSON.stringify(spec.root, null, 2)}><TreeDiagram root={spec.root} title={spec.title} /></VisualBoundary>
  }
  if (spec.type === 'concept') {
    return <VisualBoundary fallbackText={spec.nodes.map((n) => `• ${n.label}`).join('\n')}><ConceptMap nodes={spec.nodes} edges={spec.edges} title={spec.title} /></VisualBoundary>
  }
  if (spec.type === 'pie') {
    return <VisualBoundary fallbackText={spec.slices.map((s) => `${s.label} : ${s.value}`).join('\n')}><PieChart slices={spec.slices} title={spec.title} unit={spec.unit} /></VisualBoundary>
  }
  if (spec.type === 'layers') {
    return <VisualBoundary fallbackText={spec.items.map((i) => `${i.label}${i.value ? ` (${i.value})` : ''}`).join('\n')}><LayerStack items={spec.items} title={spec.title} /></VisualBoundary>
  }
  if (spec.type === 'steps') {
    return (
      <StepsPanel
        steps={spec.steps}
        title={spec.title}
        showDiagram={stable && spec.steps.length >= 4}
      />
    )
  }
  if (spec.type === 'comparison') {
    return (
      <ComparisonTable
        title={spec.title}
        header={['Critère', ...spec.columns]}
        rows={spec.rows.map((r) => [r.label, ...r.values])}
        pros={spec.pros}
        cons={spec.cons}
        conclusion={spec.conclusion}
      />
    )
  }
  // flow
  const detail = spec.nodes[active]?.detail
  return (
    <VisualBoundary fallbackText={spec.nodes.map((n, i) => `${i + 1}. ${n.label}`).join('\n')}>
      <div className="sr-visual-block">
        {spec.title && <h4 className="sr-visual-title">{spec.title}</h4>}
        <FlowDiagram nodes={spec.nodes} activeIndex={active} onSelect={setActive} loop={spec.loop} />
        {detail && (
          <div className="sr-step-detail" aria-live="polite">
            <strong>{spec.nodes[active].label}</strong>
            <p><Inline text={detail} /></p>
          </div>
        )}
      </div>
    </VisualBoundary>
  )
}

export default memo(function SmartResponse({ content, question = '', streaming = false, onUpdate }) {
  const { reducedMotion } = useScene()
  const [enabled, setEnabled] = useState(isSmartEnabled)

  useEffect(() => onSmartChange(setEnabled), [])

  const analysis = useMemo(
    () => analyzeResponse(content, { question, streaming }),
    [content, question, streaming]
  )

  const { blocks, kind, orderedList, showProcessDiagram } = analysis
  const stable = !streaming
  const smart = enabled

  // Visuel complémentaire planifié (schéma pédagogique) : ajouté seulement si
  // la réponse n'en contient aucun et si le sujet s'y prête.
  const planned = useMemo(() => {
    if (!smart || !stable || NO_PLANNED.has(kind)) return null
    const hasVisual = blocks.some((b) => b.type === 'visual' || b.type === 'image')
    if (hasVisual) return null
    return planVisual(question, { hasVisualAlready: false, streaming })
  }, [smart, stable, kind, blocks, question, streaming])

  const composed = useMemo(() => {
    if (!planned) return blocks
    const firstPara = blocks.findIndex((b) => b.type === 'paragraph')
    const at = firstPara >= 0 ? firstPara + 1 : blocks.length
    return [...blocks.slice(0, at), { type: 'planned', spec: planned }, ...blocks.slice(at)]
  }, [blocks, planned])

  // Index du bloc liste transformé en tutoriel interactif.
  const stepsIndex = useMemo(() => {
    if (!smart || kind !== 'steps' || !orderedList || orderedList.items.length < 3) return -1
    return blocks.indexOf(orderedList)
  }, [smart, kind, orderedList, blocks])

  const mathCount = useMemo(() => blocks.filter((b) => b.type === 'math').length, [blocks])
  let mathSeen = 0

  const label = smart ? KIND_LABELS[kind] : null

  return (
    <div className={`smart-response${reducedMotion ? ' is-static' : ''} is-${smart ? kind : 'plain'}`}>
      {label && (
        <div className="sr-kind" aria-label={`Format de réponse : ${label}`}>
          <SparklesIcon size={11} />
          <span>{label}</span>
        </div>
      )}

      {composed.map((block, index) => {
        const key = `${index}-${block.type}`
        let node = null

        if (block.type === 'planned') {
          node = <ExplicitVisual spec={block.spec} stable={stable} />
        } else if (block.type === 'image') {
          node = block.data
            ? <GeneratedImage data={block.data} onUpdate={onUpdate} />
            : <VisualFallback raw={block.raw} open={block.open} />
        } else if (block.type === 'visual') {
          node = block.spec && smart
            ? <ExplicitVisual spec={block.spec} stable={stable} />
            : <VisualFallback raw={block.raw} open={block.open} />
        } else if (index === stepsIndex) {
          node = (
            <StepsPanel
              steps={block.items.map(splitStep)}
              showDiagram={showProcessDiagram && stable}
            />
          )
        } else if (smart && kind === 'comparison' && block.type === 'table' && block.header.length >= 2) {
          node = <ComparisonTable header={block.header} rows={block.rows} />
        } else if (smart && kind === 'math' && block.type === 'math') {
          mathSeen++
          node = <MathBlock expr={block.expr} result={mathCount > 1 && mathSeen === mathCount} />
        } else if (smart && block.type === 'paragraph') {
          const result = RESULT_RE.exec(block.text.replace(/\*\*/g, ''))
          node = result
            ? (
              <div className="sr-result">
                <span className="sr-result-label">{result[1]}</span>
                <p><Inline text={result[2]} /></p>
              </div>
            )
            : <Block block={block} />
        } else {
          node = <Block block={block} />
        }

        return <div className="sr-block" key={key}>{node}</div>
      })}
    </div>
  )
})
