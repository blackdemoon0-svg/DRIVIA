import { memo, useState, useMemo, useRef, useLayoutEffect } from 'react'

// Diagramme système interactif.
//
// REFONTE DU MOTEUR DE DISPOSITION.
//
// L'ancienne version plaçait tous les nœuds sur UNE SEULE rangée horizontale,
// à largeur fixe (140 px), avec des libellés coupés à 16 caractères. Résultat :
// libellés tronqués (« Moteur d'assistance élect… »), flèches droites qui
// traversent les blocs, étiquettes de liens empilées au même endroit, et un
// diagramme horizontal illisible sur mobile.
//
// Ce moteur-ci part du GRAPHE, pas d'un gabarit :
//   • il CHOISIT une disposition selon la forme du graphe (chaîne, boucle,
//     architecture à plusieurs voies, étoile autour d'un calculateur) ;
//   • il mesure le texte pour adapter la taille des blocs (aucune troncature) ;
//   • il route chaque lien hors des blocs, avec des courbes de Bézier
//     orthogonales et des points d'ancrage choisis par géométrie ;
//   • il place les étiquettes dans les couloirs libres, avec détection de
//     collision (nœuds, autres étiquettes) ;
//   • il produit une légende et un panneau de détail cohérents.

const PAD = 28
const COL_GAP = 72 // couloir horizontal entre deux colonnes
const ROW_GAP = 34 // couloir vertical entre deux blocs d'une même colonne
const NODE_MIN_W = 132
const NODE_MAX_W = 200
const NODE_H = 74
const NODE_H_SUB = 58 // bloc secondaire (commande, capteur)
const MIN_READABLE_WIDTH = 560
const MAX_LINE_CHARS = 15
const CHAR_W = 7.6 // largeur moyenne d'un caractère à 13,5 px, police du thème

// Mention de rôle affichée sous le libellé. Courte À DESSEIN : elle tient dans
// la largeur minimale d'un bloc, donc elle ne dicte jamais la largeur du bloc
// ni ne déborde du cadre.
const TIER_LABELS = {
  source: 'Source',
  control: 'Commande',
  power: 'Conversion',
  mechanical: 'Transmission',
  recovery: 'Récupération',
  other: 'Autre',
}

// Une couleur par NATURE de flux. `kind` décide aussi du tracé : un flux
// d'information se courbe, un flux de matière suit les couloirs.
const FLOW_STYLE = {
  energy: { label: 'Énergie électrique', color: '#c084fc', dash: 'none', width: 2.4, kind: 'energy' },
  mechanical: { label: 'Liaison mécanique', color: '#fbbf24', dash: 'none', width: 2.2, kind: 'mechanical' },
  fluid: { label: 'Fluide', color: '#38bdf8', dash: 'none', width: 2.4, kind: 'fluid' },
  heat: { label: 'Chaleur', color: '#fb7185', dash: '1 4', width: 2, kind: 'heat' },
  information: { label: 'Information / mesure', color: '#a3e635', dash: '6 4', width: 1.5, kind: 'information' },
  control: { label: 'Commande', color: '#7dd3fc', dash: '5 4', width: 1.5, kind: 'control' },
  recovery: { label: 'Récupération', color: '#34d399', dash: '7 5', width: 2.2, kind: 'recovery' },
  gas: { label: 'Gaz', color: '#94a3b8', dash: '3 4', width: 2, kind: 'gas' },
  ignition: { label: 'Allumage', color: '#f472b6', dash: '2 3', width: 1.6, kind: 'ignition' },
}

const styleOf = (flow) => FLOW_STYLE[flow] ?? FLOW_STYLE.energy

// Découpe un libellé sur au plus deux lignes, sans jamais tronquer un mot.
export function wrapLabel(label, maxChars = MAX_LINE_CHARS) {
  const text = String(label ?? '').trim()
  if (text.length <= maxChars) return [text]
  const words = text.split(/\s+/)
  if (words.length === 1) return [text]
  let best = null
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ')
    const b = words.slice(i).join(' ')
    const score = Math.max(a.length, b.length)
    if (!best || score < best.score) best = { a, b, score }
  }
  return best ? [best.a, best.b] : [text]
}

export function wrapEdgeLabel(label, maxChars = 12) {
  const text = String(label ?? '').trim()
  if (text.length <= maxChars) return [text]
  const words = text.split(/\s+/)
  if (words.length === 1) return [text]
  let first = ''
  let i = 0
  while (i < words.length && (first + (first ? ' ' : '') + words[i]).length <= maxChars) {
    first += (first ? ' ' : '') + words[i]
    i++
  }
  if (!first) first = words[0]
  const second = words.slice(i).join(' ')
  return second ? [first, second] : [first]
}

// Un titre de schéma suit toujours la forme « Sujet — Précision : ce que le
// schéma montre ». Elle est rendue en trois fragments typographiques plutôt
// qu'en un seul bloc de texte : la précision passe en second plan, et la
// lecture ne dépend plus d'un seul niveau de gris.
export function formatTitle(title) {
  const text = String(title ?? '').trim()
  const m = text.match(/^(.*?)\s+—\s+(.*?)\s*:\s*(.*)$/)
  if (!m) return text
  const [, subject, precision, what] = m
  return (
    <>
      <span className="sr-title-subject">{subject}</span>
      <span className="sr-title-precision">{precision}</span>
      <span className="sr-title-what">{what}</span>
    </>
  )
}

// Nom d'une voie, déduit de sa source et des flux qui la parcourent. Deux
// voies sans nom se contenteraient de « Voie 1 / Voie 2 », ce qui n'apprend
// rien ; les noms sont donc tirés de ce que la voie contient réellement.
function laneCaption(lane, flows) {
  const label = String(typeof lane?.source === 'string' ? lane.source : lane?.source?.label ?? '')
  if (/batterie|accumulateur|[ée]lectri/i.test(label) || (flows.has('energy') && !flows.has('mechanical'))) return 'Chaîne électrique'
  if (/moteur|thermique|carburant|r[ée]servoir/i.test(label) || flows.has('heat')) return 'Chaîne thermique'
  if (flows.has('fluid')) return 'Circuit de fluide'
  return 'Chaîne mécanique'
}

function useWidth(ref) {
  const [width, setWidth] = useState(760)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const update = () => setWidth(el.clientWidth || 760)
    update()
    if (typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [ref])
  return width
}
// Disposition en VOIES — la lisibilité prime sur la compacité :
//   • voie de commande (en haut)   : capteurs, calculateurs, BMS
//   • voie principale (au centre)  : la chaîne énergie → roues, alignée
//   • flux de récupération (bas)   : retours dessinés sous la voie principale
// Ainsi la chaîne principale est parfaitement horizontale (aucun zigzag) et les
// flux inverses ne traversent jamais les nœuds.

// ---------------------------------------------------------------------------
// 1. LECTURE DU GRAPHE
// ---------------------------------------------------------------------------
// Avant de dessiner, on mesure la FORME du graphe. C'est ce qui permet de
// choisir une disposition adaptée au système au lieu d'un gabarit unique.

export function analyzeGraph(nodes, edges) {
  const ids = new Set(nodes.map((n) => n.id))
  const valid = edges.filter((e) => ids.has(e.from) && ids.has(e.to) && e.from !== e.to)
  const outDeg = new Map(nodes.map((n) => [n.id, 0]))
  const inDeg = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of valid) {
    outDeg.set(e.from, (outDeg.get(e.from) ?? 0) + 1)
    inDeg.set(e.to, (inDeg.get(e.to) ?? 0) + 1)
  }
  const roots = nodes.filter((n) => (inDeg.get(n.id) ?? 0) === 0).map((n) => n.id)
  const leaves = nodes.filter((n) => (outDeg.get(n.id) ?? 0) === 0).map((n) => n.id)

  // Profondeur par plus long chemin depuis une racine (parcours en largeur
  // borné : les graphes de schémas sont petits, mais on évite toute boucle
  // infinie en cas de cycle).
  const depth = new Map()
  const queue = [...(roots.length ? roots : [nodes[0]?.id]).filter(Boolean)]
  for (const r of queue) depth.set(r, 0)
  let guard = 0
  while (queue.length && guard++ < 500) {
    const id = queue.shift()
    const d = depth.get(id) ?? 0
    for (const e of valid.filter((x) => x.from === id)) {
      if ((depth.get(e.to) ?? -1) < d + 1) {
        depth.set(e.to, d + 1)
        queue.push(e.to)
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0)

  const controlIds = new Set(nodes.filter((n) => n.tier === 'control').map((n) => n.id))
  const hub = nodes
    .map((n) => ({ id: n.id, deg: (outDeg.get(n.id) ?? 0) + (inDeg.get(n.id) ?? 0) }))
    .sort((a, b) => b.deg - a.deg)[0]

  // Boucle : existe-t-il un chemin retour vers un nœud déjà traversé ?
  const hasCycle = (() => {
    const state = new Map()
    const visit = (id, stack) => {
      if (stack.has(id)) return true
      if (state.get(id) === 'done') return false
      stack.add(id)
      for (const e of valid.filter((x) => x.from === id)) if (visit(e.to, stack)) return true
      stack.delete(id)
      state.set(id, 'done')
      return false
    }
    return nodes.some((n) => visit(n.id, new Set()))
  })()

  const flowKinds = new Set(valid.map((e) => e.flow))
  // « Hybride » : plusieurs natures d'énergie qui CHEMINENT séparément.
  // On le détecte sur les nœuds, pas sur les mots : deux sources distinctes
  // (un bloc source de nature différente et un autre) qui alimentent des
  // branches différentes.
  const sourceNodes = nodes.filter((n) => n.tier === 'source')
  const mechanicalFromSource = sourceNodes.some((s) =>
    valid.some((e) => e.from === s.id && e.flow === 'mechanical')
  )
  const electricFromSource = sourceNodes.some((s) =>
    valid.some((e) => e.from === s.id && (e.flow === 'energy' || e.flow === 'recovery'))
  )
  const isHybrid = sourceNodes.length >= 2 && (mechanicalFromSource || electricFromSource)

  // Écart maximal de hauteur entre deux blocs reliés : c'est ce qui décide du
  // tracé (courbe courte ou détour par un couloir).
  const maxEdgeSpan = valid.reduce((m, e) => {
    const a = nodes.find((n) => n.id === e.from)
    const b = nodes.find((n) => n.id === e.to)
    if (!a || !b) return m
    return Math.max(m, Math.abs((a.y ?? 0) - (b.y ?? 0)))
  }, 0)

  // Profondeur « amont → aval » : calculée SANS les arcs de retour
  // (récupération) ni les arcs de commande. Sans cela, une boucle de recharge
  // plaçait la batterie À DROITE de l'onduleur, et le parcours se lisait à
  // l'envers. C'est cette profondeur que suivent les dispositions.
  const FWD = new Set(['mechanical', 'energy', 'fluid', 'heat', 'gas', 'ignition'])
  const fwd = valid.filter((e) => FWD.has(e.flow) && e.flow !== 'recovery')
  const fwdDepth = new Map()
  const fwdRoots = nodes.filter((n) => !fwd.some((e) => e.to === n.id)).map((n) => n.id)
  const queueF = fwdRoots.length ? [...fwdRoots] : [nodes[0]?.id].filter(Boolean)
  for (const r of queueF) fwdDepth.set(r, 0)
  let guardF = 0
  while (queueF.length && guardF++ < 800) {
    const id = queueF.shift()
    const d = fwdDepth.get(id) ?? 0
    for (const e of fwd.filter((x) => x.from === id)) {
      if ((fwdDepth.get(e.to) ?? -1) < d + 1) {
        fwdDepth.set(e.to, d + 1)
        queueF.push(e.to)
      }
    }
  }
  for (const n of nodes) if (!fwdDepth.has(n.id)) fwdDepth.set(n.id, 0)

  return {
    valid,
    fwd,
    fwdDepth,
    roots,
    leaves,
    depth,
    degrees: { out: outDeg, in: inDeg },
    controlCount: controlIds.size,
    controlIds,
    hub,
    hasCycle,
    flowKinds,
    isHybrid,
    maxDepth: Math.max(...[...depth.values()], 0),
  }
}

// Nature dominante du schéma : sert au titre de légende et au choix de rendu.
export function diagramNature(nodes, graph) {
  const flows = graph.flowKinds
  const has = (f) => flows.has(f)
  if (graph.isHybrid) return { id: 'hybrid', label: 'Système hybride : deux chaînes de puissance' }
  if (has('fluid') && has('heat')) return { id: 'hydraulic', label: 'Circuit hydraulique et thermique' }
  if (has('fluid')) return { id: 'hydraulic', label: 'Circuit de fluide' }
  if (has('heat') && !has('energy')) return { id: 'thermal', label: 'Transfert thermique' }
  if (has('energy') && !has('mechanical')) return { id: 'electric', label: 'Circuit électrique' }
  if (has('mechanical') && !has('energy')) return { id: 'mechanical', label: 'Système mécanique' }
  if (has('energy') && has('mechanical')) return { id: 'electromechanical', label: 'Chaîne électromécanique' }
  return { id: 'general', label: 'Système fonctionnel' }
}

// ---------------------------------------------------------------------------
// 2. MESURE DU TEXTE
// ---------------------------------------------------------------------------
// La taille d'un bloc est DÉDUITE de son libellé : plus de troncature, plus de
// texte qui dépasse. On répartit les lignes pour minimiser la largeur.
export function measureNode(node, narrow) {
  const maxChars = narrow ? 26 : MAX_LINE_CHARS
  const words = String(node.label ?? '').split(/\s+/)
  const lines = []
  let current = ''
  for (const w of words) {
    if (!current) current = w
    else if ((current + ' ' + w).length <= maxChars) current += ' ' + w
    else {
      lines.push(current)
      current = w
    }
  }
  if (current) lines.push(current)

  // Largeur = largeur RÉELLE de la ligne la plus longue, plus une marge
  // intérieure. Le plancher ne s'applique que si la place existe : sinon on
  // répartit le libellé autrement au lieu de rogner le texte.
  const longest = Math.max(...lines.map((l) => l.length), 1)
  const needed = longest * CHAR_W + 34
  const w = Math.min(NODE_MAX_W, Math.max(NODE_MIN_W, needed))
  const isSub = node.tier === 'control'
  const h = (isSub ? NODE_H_SUB : NODE_H) + (lines.length - 1) * 15
  // La mention de rôle (« Transmission ») est plus large que la largeur minimale
  // de certains libellés courts : elle fait partie de la mesure du bloc,
  // sinon elle débordait du cadre.
  const tierW = (TIER_LABELS[node.tier] ?? '').length * 6.6 + 18
  return { lines, w: Math.max(w, Math.min(NODE_MAX_W, tierW)), h }
}

// ---------------------------------------------------------------------------
// 3. CHOIX DE LA DISPOSITION
// ---------------------------------------------------------------------------
// Quatre dispositions, choisies d'après la FORME du graphe :
//   • chain   — une chaîne linéaire → une seule voie horizontale aérée
//   • lanes   — architecture hybride / branches parallèles → une voie par branche
//   • loop    — boucle de régulation → voie principale + retour sous le schéma
//   • star    — calculateur central → étoile autour du calculateur
export function chooseLayout(nodes, edges, narrow) {
  const graph = analyzeGraph(nodes, edges)
  if (narrow) return { kind: 'narrow', graph }

  // Une CHAÎNE LINÉAIRE (aucun embranchement) ne justifie pas une voie par
  // source : la batterie et le calculateur de gestion ouvraient deux voies
  // pour une seule suite d'organes. Deux sources ne font une architecture à
  // deux voies que si elles alimentent des branches DIFFÉRENTES.
  const POWER = new Set(['mechanical', 'energy', 'fluid', 'heat'])
  const powerOut = (id) => graph.valid.filter((e) => e.from === id && POWER.has(e.flow))
  const sources = nodes.filter((n) => powerOut(n.id).length > 0 && !graph.valid.some((e) => e.to === n.id && POWER.has(e.flow)))
  const branchTargets = new Set()
  let shared = false
  for (const s2 of sources) {
    for (const e of powerOut(s2.id)) {
      if (branchTargets.has(e.to)) shared = true
      branchTargets.add(e.to)
    }
  }
  // Deux sources qui convergent vers le MÊME organe = deux voies à dessiner.
  // Deux sources indépendantes dans une même suite = une seule voie.
  const parallel = sources.length >= 2 && graph.isHybrid === false ? shared : false
  if (graph.isHybrid || parallel) {
    // continue vers le choix de disposition à deux voies
  }
  const branchCount = new Set(
    graph.valid.filter((e) => e.flow === 'mechanical' || e.flow === 'energy' || e.flow === 'fluid').map((e) => e.from)
  ).size
  if (graph.isHybrid && branchCount >= 2 && parallel) return { kind: 'lanes', graph }
  if (graph.hub && graph.degrees.out.get(graph.hub.id) >= 3) return { kind: 'star', graph }
  if (graph.hasCycle) return { kind: 'loop', graph }
  return { kind: 'chain', graph }
}

// Ordonne les nœuds par profondeur, puis par degré : les éléments de commande
// passent dans une voie haute, les éléments de puissance dans la voie basse.
function laneAssignment(nodes, graph) {
  const main = nodes.filter((n) => n.tier !== 'control')
  const control = nodes.filter((n) => n.tier === 'control')
  return { main, control }
}

// Disposition « chain » : une voie horizontale, alignée verticalement au centre.
// Les colonnes suivent la profondeur réelle du graphe, pas l'ordre du tableau.
export function layoutChain(nodes, graph, opts = {}) {
  const isControl = (n) =>
    n.tier === 'control' && !graph.valid.some((e) => e.to === n.id && ['fluid', 'mechanical', 'heat', 'energy'].includes(e.flow))

  const depthOf = (n) => (graph.fwdDepth ?? graph.depth).get(n.id) ?? 0
  const sizes = new Map(nodes.map((n) => [n.id, measureNode(n, false)]))

  // CHAÎNES D'ÉNERGIE. Sur un schéma à plusieurs sources, chaque organe
  // remonte à une ou plusieurs sources. C'est cette appartenance qui donne les
  // bandeaux « chaîne thermique » / « chaîne électrique » : sans elle, le
  // lecteur ne peut pas distinguer deux chemins qui se ressemblent.
  const POWER = new Set(['mechanical', 'energy', 'fluid', 'heat'])
  const powerEdges = graph.valid.filter((e) => POWER.has(e.flow))
  const powered = new Set(powerEdges.map((e) => e.to))
  const sourceNodes = nodes.filter((n) => !powered.has(n.id) && powerEdges.some((e) => e.from === n.id))
  const chainsOf = (id) => {
    const found = new Set()
    const stack = [id]
    const seen = new Set([id])
    while (stack.length) {
      const cur = stack.pop()
      if (sourceNodes.some((s2) => s2.id === cur)) found.add(cur)
      for (const e of powerEdges) {
        if (e.to === cur && !seen.has(e.from)) {
          seen.add(e.from)
          stack.push(e.from)
        }
      }
    }
    return found
  }
  const chainSources = sourceNodes.filter((s2) => nodes.some((n) => chainsOf(n.id).has(s2.id)))
  // Une chaîne n'est retenue que si elle porte au moins deux organes : une
  // source isolée n'est pas une chaîne.
  const bands = chainSources
    .map((s2) => ({ source: s2, ids: nodes.filter((n) => chainsOf(n.id).has(s2.id)).map((n) => n.id) }))
    .filter((b) => b.ids.length >= 2)

  const byDepth = new Map()
  for (const n of nodes) {
    if (isControl(n)) continue
    const d = depthOf(n)
    if (!byDepth.has(d)) byDepth.set(d, [])
    byDepth.get(d).push(n)
  }
  const depths = [...byDepth.keys()].sort((a, b) => a - b)
  const colWidth = (d) => Math.max(...byDepth.get(d).map((n) => sizes.get(n.id).w))
  const colHeight = (d) =>
    byDepth.get(d).reduce((acc, n) => acc + sizes.get(n.id).h, 0) + (byDepth.get(d).length - 1) * ROW_GAP

  // --- Répartition en RANGÉES ------------------------------------------------
  // Un parcours de sept organes sur une seule ligne mesurait plus de 1 100 px
  // et n'était lisible qu'en faisant défiler la carte. On replie donc le
  // parcours en serpentin : gauche → droite, puis droite → gauche. Le lien de
  // raccord descend alors tout droit d'une rangée à l'autre, sans traverser de
  // bloc, et le regard suit le trajet comme on lit un texte.
  const maxWidth = opts.maxWidth ?? 760
  const rows = []
  let current = []
  let w = PAD
  for (const d of depths) {
    const cw = colWidth(d)
    const need = w + cw + (current.length ? COL_GAP : 0)
    if (current.length && need > maxWidth) {
      rows.push(current)
      current = []
      w = PAD
    }
    current.push(d)
    w += (current.length > 1 ? COL_GAP : 0) + cw
  }
  if (current.length) rows.push(current)

  const positions = {}
  const rowTops = []
  let y = PAD
  let width = 0
  let maxH = 0

  rows.forEach((rowDepths, rowIndex) => {
    const reverse = rowIndex % 2 === 1
    const ordered = reverse ? [...rowDepths].reverse() : rowDepths
    const rowHeight = Math.max(...rowDepths.map(colHeight))
    let x = PAD
    for (const d of ordered) {
      const col = byDepth.get(d)
      const cw = colWidth(d)
      const ch = colHeight(d)
      let cy = y + (rowHeight - ch) / 2
      for (const n of col) {
        const sz = sizes.get(n.id)
        positions[n.id] = {
          x: x + (cw - sz.w) / 2,
          y: cy,
          w: sz.w,
          h: sz.h,
          lines: sz.lines,
          col: d,
          rowIndex,
        }
        cy += sz.h + ROW_GAP
      }
      x += cw + COL_GAP
    }
    width = Math.max(width, x - COL_GAP + PAD)
    rowTops.push({ top: y, bottom: y + rowHeight })
    maxH = y + rowHeight - PAD
    y += rowHeight + ROW_GAP * 1.7 // couloir de repli entre deux rangées
  })

  // Rangée de commande : sous le parcours, à l'aplomb de l'organe piloté.
  const control = nodes.filter(isControl)
  let bottom = maxH + PAD * 2
  if (control.length) {
    const cy = Math.max(...rowTops.map((r) => r.bottom), PAD) + ROW_GAP + 4
    const stacked = new Map()
    for (const n of control) {
      const sz = sizes.get(n.id)
      const target = graph.valid.find((e) => e.from === n.id)
      const anchor = target ? positions[target.to] : null
      const key = Math.round((anchor?.x ?? PAD) / 8)
      const offset = stacked.get(key) ?? 0
      stacked.set(key, offset + sz.w + 12)
      positions[n.id] = {
        x: (anchor?.x ?? PAD) + offset,
        y: cy,
        w: sz.w,
        h: sz.h,
        lines: sz.lines,
        row: 'control',
      }
    }
    width = Math.max(width, ...control.map((n) => positions[n.id].x + positions[n.id].w + PAD))
    bottom = cy + Math.max(...control.map((n) => positions[n.id].h)) + PAD
  }

  // Couloir de repli : la rangée d'en dessous laisse une bande libre entre elle
  // et la précédente. Les liens de raccord y passent.
  const corridors = { mid: bottom - PAD + 6, back: bottom - PAD + 16 }
  // Bandeaux de chaîne, calculés sur la boîte englobante des organes de chaque
  // chaîne. Ils ne recouvrent que des blocs, jamais un couloir de lien.
  const chainBands = bands.map((b) => {
    const xs = b.ids.map((id) => positions[id]).filter(Boolean)
    if (xs.length < 2) return null
    const x0 = Math.min(...xs.map((p) => p.x)) - 10
    const x1 = Math.max(...xs.map((p) => p.x + p.w)) + 10
    const y0 = Math.min(...xs.map((p) => p.y)) - 10
    const y1 = Math.max(...xs.map((p) => p.y + p.h)) + 10
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, source: b.source.label, ids: b.ids }
  }).filter(Boolean)
  // Marge : un lien peut passer par un canal latéral. Le cadre doit le
  // contenir, sinon la flèche est rognée au bord du schéma.
  const rightMost = Math.max(
    ...Object.values(positions).map((p) => p.x + p.w),
    PAD
  )
  return {
    positions,
    width: Math.max(width, rightMost + COL_GAP),
    height: bottom,
    lanes: null,
    rows: rowTops,
    corridors,
    chainBands,
  }
}

// Disposition « lanes » : une voie horizontale par source d'énergie. C'est la
// disposition qui distingue visuellement un chemin thermique d'un chemin
// électrique, et qui montre où ils convergent.
export function layoutLanes(nodes, graph) {
  const sizes = new Map(nodes.map((n) => [n.id, measureNode(n, false)]))
  const control = nodes.filter((n) => n.tier === 'control')

  // Flux de PUISSANCE : ceux qui transportent de l'énergie ou de la matière.
  // La commande et l'information n'ouvrent pas de voie.
  const POWER_FLOWS = new Set(['mechanical', 'energy', 'fluid', 'heat'])
  const powerEdges = graph.valid.filter((e) => POWER_FLOWS.has(e.flow))

  // Sources : nœuds sans entrée de puissance qui émettent de la puissance.
  const powered = new Set(powerEdges.map((e) => e.to))
  const sources = nodes.filter((n) => n.tier !== 'control' && !powered.has(n.id))

  // Appartenance de chaque nœud : on remonte les flux de puissance jusqu'aux
  // sources. Un nœud qui remonte à DEUX sources est une convergence — c'est
  // exactement le point que le schéma doit rendre évident.
  const members = new Map()
  for (const n of nodes) {
    const found = new Set()
    const stack = [n.id]
    const seen = new Set([n.id])
    while (stack.length) {
      const id = stack.pop()
      if (sources.some((s) => s.id === id)) found.add(id)
      for (const e of powerEdges) {
        if (e.to === id && !seen.has(e.from)) {
          seen.add(e.from)
          stack.push(e.from)
        }
      }
    }
    members.set(n.id, found)
  }

  // Voie d'un nœud : première de ses sources. Les sources elles-mêmes portent
  // leur propre voie.
  const laneOrder = sources.filter((s) => nodes.some((n) => members.get(n.id)?.has(s.id)))
  const laneOf = (id) => {
    const m = members.get(id)
    if (!m || !m.size) return 0
    const idx = laneOrder.findIndex((s) => m.has(s.id))
    return idx < 0 ? 0 : idx
  }
  const isConvergence = (id) => (members.get(id)?.size ?? 0) > 1

  // Colonnes : profondeur calculée SANS les arcs de retour (récupération), sinon
  // la batterie, alimentée en retour, se retrouverait placée tout à droite.
  const RETURN_FLOWS = new Set(['recovery'])
  const fwd = powerEdges.filter((e) => !RETURN_FLOWS.has(e.flow))
  const depth = new Map()
  const roots = nodes.filter((n) => !fwd.some((e) => e.to === n.id)).map((n) => n.id)
  const queue = [...roots]
  for (const r of roots) depth.set(r, 0)
  let guard = 0
  while (queue.length && guard++ < 800) {
    const id = queue.shift()
    const d = depth.get(id) ?? 0
    for (const e of fwd.filter((x) => x.from === id)) {
      if ((depth.get(e.to) ?? -1) < d + 1) {
        depth.set(e.to, d + 1)
        queue.push(e.to)
      }
    }
  }
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0)

  // Nœuds de RETOUR : hors parcours aller, ils ne créent donc pas de colonne.
  const isReturn = (id) => graph.valid.some((e) => e.from === id && e.flow === 'recovery')
  const producersOf = (id) => graph.valid.filter((e) => e.to === id).map((e) => e.from)

  // Largeur de colonne = bloc le plus large à cette profondeur.
  const colW = new Map()
  for (const n of nodes) {
    if (n.tier === 'control' || isReturn(n.id)) continue
    const c = depth.get(n.id) ?? 0
    colW.set(c, Math.max(colW.get(c) ?? 0, sizes.get(n.id).w))
  }
  const cols = [...colW.keys()].sort((a, b) => a - b)
  // Largeur RÉELLE de chaque colonne : réserver la même largeur partout
  // allongeait le schéma de deux travées pour rien.
  const colX = new Map()
  let x = PAD
  for (const c of cols) {
    colX.set(c, x)
    x += colW.get(c) + COL_GAP
  }
  const width = x - COL_GAP + PAD

  // Hauteur de chaque voie = bloc le plus haut qui lui appartient.
  const laneH = laneOrder.map((s) =>
    Math.max(
      sizes.get(s.id).h,
      ...nodes.filter((n) => laneOf(n.id) === laneOrder.indexOf(s) && !isConvergence(n.id)).map((n) => sizes.get(n.id).h),
      0
    )
  )
  const laneGap = ROW_GAP
  const laneY = []
  let y = PAD
  for (let i = 0; i < laneOrder.length; i++) {
    laneY.push(y)
    y += laneH[i] + laneGap
  }
  const lanesBottom = laneOrder.length ? y - laneGap : PAD

  // Nœuds de RETOUR (récupération, recyclage) : ils ne se placent pas dans une
  // colonne du parcours aller, sinon le schéma s'allonge d'une travée pour une
  // flèche qui revient en arrière. On les pose sur une rangée de retour, sous
  // leur producteur, d'où la flèche remonte vers sa source.
  const positions = {}
  const stacked = new Map() // (colonne|voie) → décalage vertical cumulé
  for (const n of nodes) {
    if (n.tier === 'control') continue
    if (isReturn(n.id)) continue
    const s = sizes.get(n.id)
    const c = depth.get(n.id) ?? 0
    const lane = laneOf(n.id)
    const laneTop = laneOrder.length ? laneY[lane] : PAD
    let nodeY
    if (isConvergence(n.id) && laneOrder.length > 1) {
      // Convergence : centrée ENTRE les voies qu'elle réunit — c'est la
      // traduction visuelle du fait que les deux chaînes y aboutissent.
      const ids = [...members.get(n.id)]
      const tops = ids.map((id) => laneY[laneOrder.findIndex((s2) => s2.id === id)] ?? PAD)
      const h = Math.max(...ids.map((id) => sizes.get(id).h))
      nodeY = Math.min(...tops) + h / 2 - s.h / 2
      // On laisse la convergence déborder sous les voies plutôt que de la
      // superposer au bloc de la première voie.
      nodeY = Math.max(nodeY, lanesBottom + laneGap / 2)
    } else {
      nodeY = laneTop + (laneH[lane] - s.h) / 2
    }
    const k = `${c}|${lane}`
    const off = stacked.get(k) ?? 0
    stacked.set(k, off + s.h + ROW_GAP)
    positions[n.id] = {
      x: colX.get(c) + (colW.get(c) - s.w) / 2,
      y: nodeY + off,
      w: s.w,
      h: s.h,
      lines: s.lines,
      lane,
      laneLabel: laneOrder[lane]?.label ?? null,
    }
  }

  // Rangée de retour : sous tout le parcours aller, dans la colonne du nœud
  // qui fournit l'énergie récupérée.
  const forwardBottom = Math.max(lanesBottom, ...Object.values(positions).map((p) => p.y + p.h), PAD)
  const returnNodes = nodes.filter((n) => n.tier !== 'control' && isReturn(n.id))
  let returnBottom = forwardBottom
  if (returnNodes.length) {
    const y = forwardBottom + ROW_GAP
    for (const n of returnNodes) {
      const s2 = sizes.get(n.id)
      const prod = producersOf(n.id)[0]
      const c = prod ? depth.get(prod) ?? 0 : cols[cols.length - 1] ?? 0
      positions[n.id] = {
        x: (colX.get(c) ?? PAD) + ((colW.get(c) ?? s2.w) - s2.w) / 2,
        y,
        w: s2.w,
        h: s2.h,
        lines: s2.lines,
        lane: 'return',
      }
      returnBottom = Math.max(returnBottom, y + s2.h)
    }
  }

  // Blocs de commande : sous les voies, dans leur colonne.
  const maxBottom = returnBottom
  const controlY = maxBottom + ROW_GAP + 8
  for (const n of control) {
    const s = sizes.get(n.id)
    const c = depth.get(n.id) ?? 0
    positions[n.id] = { x: colX.get(c) ?? PAD, y: controlY, w: s.w, h: s.h, lines: s.lines, lane: 'control' }
  }
  const controlH = control.length ? Math.max(...control.map((n) => positions[n.id].h)) : 0
  // Couloirs de circulation réservés AUX FLÈCHES : aucune ligne ne traverse un
  // bloc, aucun retour ne coupe une voie.
  const corridors = {
    mid: forwardBottom + 16, // entre le parcours aller et la rangée de retour
    back: (returnNodes.length ? returnBottom : forwardBottom) + 18, // sous tout
  }
  const bottom = Math.max(maxBottom, corridors.back + 8)
  return {
    positions,
    width,
    height: (control.length ? controlY + controlH : bottom) + PAD,
    lanes: laneOrder.map((s, i) => ({ y: laneY[i], h: laneH[i], source: s })),
    corridors,
  }
}

// Disposition « loop » : voie principale + couloir de retour réservé SOUS les
// blocs, pour qu'aucune flèche de retour ne traverse un composant.
export function layoutLoop(nodes, graph) {
  // Circuit FERMÉ : la boucle se lit comme un cycle, pas comme une file
  // d'attente. On place le parcours aller sur une rangée, les composants de
  // commande au-dessus (information → calculateur), et les nœuds qui
  // n'appartiennent pas à la boucle fermée (le milieu qui reçoit la chaleur)
  // sur une rangée distincte : ils ne sont pas traversés par le fluide.
  const base = layoutChain(nodes, graph)
  const positions = { ...base.positions }
  const sizes = new Map(nodes.map((n) => [n.id, measureNode(n, false)]))

  // Nœuds de la boucle : ceux qui ont une entrée ET une sortie de fluide.
  const isLoopNode = (id) =>
    graph.valid.some((e) => e.to === id && (e.flow === 'fluid' || e.flow === 'heat')) &&
    graph.valid.some((e) => e.from === id && (e.flow === 'fluid' || e.flow === 'heat'))
  const loopNodes = nodes.filter((n) => n.tier !== 'control' && isLoopNode(n.id))
  const exterior = nodes.filter((n) => n.tier !== 'control' && !isLoopNode(n.id) && n.tier !== 'source' ? false : false)
  const sinks = nodes.filter(
    (n) => n.tier !== 'control' && !isLoopNode(n.id) && graph.valid.some((e) => e.to === n.id) && !graph.valid.some((e) => e.from === n.id)
  )

  // Rangée basse pour les puits (milieu qui reçoit la chaleur, échangeur).
  const bottom = Math.max(...Object.values(base.positions).map((p) => p.y + p.h), 0)
  let y = bottom + ROW_GAP + 10
  for (const n of sinks) {
    const sz = sizes.get(n.id)
    positions[n.id] = {
      x: positions[n.id]?.x ?? PAD,
      y,
      w: sz.w,
      h: sz.h,
      lines: sz.lines,
      row: 'sink',
    }
  }

  // Couloir de retour : SOUS toutes les rangées, jamais entre deux blocs.
  const height = Math.max(
    bottom + PAD,
    ...sinks.map((n) => positions[n.id].y + positions[n.id].h + PAD)
  )
  return {
    ...base,
    positions,
    height: height + 44,
    loop: true,
    loopIds: loopNodes.map((n) => n.id),
    corridors: { mid: height + 6, back: height + 24 },
  }
}

// Disposition « star » : le nœud le plus connecté (souvent un calculateur) au
// centre, ses correspondants répartis autour, à gauche et à droite.
export function layoutStar(nodes, edges, graph) {
  const sizes = new Map(nodes.map((n) => [n.id, measureNode(n, false)]))
  const center = graph.hub?.id
  if (!center) return layoutChain(nodes, graph)
  const others = nodes.filter((n) => n.id !== center)
  const half = Math.ceil(others.length / 2)
  const left = others.slice(0, half)
  const right = others.slice(half)
  const positions = {}
  const centerSize = sizes.get(center)
  const centerX = PAD + Math.max(...left.map((n) => sizes.get(n.id).w), 0) + COL_GAP
  const centerY = PAD + 8
  positions[center] = { x: centerX, y: centerY, w: centerSize.w, h: centerSize.h, lines: centerSize.lines, hub: true }

  const columnWidth = (list) => Math.max(...list.map((n) => sizes.get(n.id).w), 0)
  const columnHeight = (list) => list.reduce((a, n) => a + sizes.get(n.id).h, 0) + Math.max(0, list.length - 1) * ROW_GAP

  const placeColumn = (list, x) => {
    let y = PAD + Math.max(0, (centerSize.h - columnHeight(list)) / 2)
    for (const n of list) {
      const s = sizes.get(n.id)
      positions[n.id] = { x, y, w: s.w, h: s.h, lines: s.lines }
      y += s.h + ROW_GAP
    }
  }
  placeColumn(left, PAD)
  placeColumn(right, centerX + centerSize.w + COL_GAP)

  const width = centerX + centerSize.w + COL_GAP + columnWidth(right) + PAD
  const height = PAD * 2 + Math.max(centerSize.h, columnHeight(left), columnHeight(right))
  return { positions, width, height }
}

// Disposition mobile : une seule colonne, blocs pleine largeur, couloir de
// retour à droite. Chaque lien suit un couloir vertical libre.
export function layoutNarrow(nodes, graph) {
  // Colonne unique, mais ordonnée par la CHAÎNE D'APPARTENANCE : les blocs
  // d'une même chaîne d'énergie se suivent, et chaque chaîne est annoncée par
  // un intertitre. Un simple tri par profondeur entrelaçait le moteur
  // thermique, la batterie et la machine électrique : la colonne ne montrait
  // plus deux chaînes, seulement une liste.
  const POWER_FLOWS = new Set(['mechanical', 'energy', 'fluid', 'heat'])
  const powerEdges = graph.valid.filter((e) => POWER_FLOWS.has(e.flow))
  const powered = new Set(powerEdges.map((e) => e.to))
  const sources = nodes.filter((n) => !powered.has(n.id) && powerEdges.some((e) => e.from === n.id))

  const chainOf = (id) => {
    const found = []
    const stack = [id]
    const seen = new Set([id])
    while (stack.length) {
      const cur = stack.pop()
      if (sources.some((s) => s.id === cur)) found.push(cur)
      for (const e of powerEdges) {
        if (e.to === cur && !seen.has(e.from)) {
          seen.add(e.from)
          stack.push(e.from)
        }
      }
    }
    return found
  }

  // Ordre : chaîne par chaîne, du plus en amont au plus en aval, puis les
  // nœuds partagés (convergences) et enfin les retours.
  const order = []
  const seen = new Set()
  const index = new Map(sources.map((s, i) => [s.id, i]))
  for (const s of sources) {
    const chain = nodes
      .filter((n) => chainOf(n.id).includes(s.id))
      .sort((a, b) => (graph.fwdDepth ?? graph.depth).get(a.id) - (graph.fwdDepth ?? graph.depth).get(b.id))
    for (const n of chain) {
      if (seen.has(n.id)) continue
      // Les nœuds partagés par deux chaînes vont à la fin : ce sont les
      // convergences.
      if (chainOf(n.id).length > 1 && sources.length > 1) continue
      seen.add(n.id)
      order.push(n.id)
    }
  }
  const rest = nodes
    .filter((n) => !seen.has(n.id))
    .sort((a, b) => graph.fwdDepth.get(a.id) - graph.fwdDepth.get(b.id))
  order.push(...rest.map((n) => n.id))
  return { order, index }
}

// ---------------------------------------------------------------------------
// 4. ROUTAGE DES LIENS
// ---------------------------------------------------------------------------
// Chaque lien part d'un point d'ancrage choisi par géométrie et rejoint sa
// cible par une courbe de Bézier dont les poignées sortent perpendiculairement
// au bord du bloc. Aucune ligne ne traverse un bloc.
// Construit un tracé orthogonal à angles arrondis à partir d'une liste de
// points. Aucun segment diagonal : la lecture d'un flux reste « côté → couloir
// → côté ».
export function orthPath(points, r = 8) {
  const pts = points.filter((p, i) => i === 0 || Math.hypot(p.x - points[i - 1].x, p.y - points[i - 1].y) > 1)
  if (pts.length < 2) return `M ${pts[0]?.x ?? 0} ${pts[0]?.y ?? 0}`
  let d = `M ${pts[0].x} ${pts[0].y}`
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = pts[i - 1]
    const cur = pts[i]
    const next = pts[i + 1]
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
    const rr = Math.min(r, inLen / 2, outLen / 2)
    const a = { x: cur.x + ((prev.x - cur.x) / (inLen || 1)) * rr, y: cur.y + ((prev.y - cur.y) / (inLen || 1)) * rr }
    const b = { x: cur.x + ((next.x - cur.x) / (outLen || 1)) * rr, y: cur.y + ((next.y - cur.y) / (outLen || 1)) * rr }
    d += ` L ${a.x.toFixed(1)} ${a.y.toFixed(1)} Q ${cur.x} ${cur.y} ${b.x.toFixed(1)} ${b.y.toFixed(1)}`
  }
  const last = pts[pts.length - 1]
  d += ` L ${last.x} ${last.y}`
  return d
}

const samplePolyline = (pts, step = 6) => {
  const out = []
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]
    const b = pts[i + 1]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const n = Math.max(1, Math.round(len / step))
    for (let k = 0; k <= n; k++) out.push({ x: a.x + ((b.x - a.x) * k) / n, y: a.y + ((b.y - a.y) * k) / n })
  }
  return out
}

// Un tracé est VALIDE s'il ne traverse aucun bloc. C'est le critère qui décide
// du choix du chemin : on essaie les tracés du plus direct au plus détourné, et
// on garde le premier qui ne coupe rien.
function pathIsClean(points, boxes, from, to) {
  if (!boxes?.length) return true
  const samples = samplePolyline(points, 5)
  for (const p of samples) {
    for (const b of boxes) {
      if (b.id === from || b.id === to) continue
      if (p.x > b.x + 2.5 && p.x < b.x + b.w - 2.5 && p.y > b.y + 2.5 && p.y < b.y + b.h - 2.5) return false
    }
  }
  return true
}

// ROUTAGE. Chaque lien choisit son chemin parmi des tracés orthogonaux
// candidats, en vérifiant qu'aucun ne traverse un composant. Les couloirs
// (entre deux rangées, sous le schéma) sont utilisés quand le tracé direct est
// obstrué : c'est ainsi qu'un flux de retour contourne les blocs au lieu de les
// traverser.
export function routeEdge(from, to, index, ctx = {}) {
  const boxes = ctx.boxes ?? []
  const fcx = from.x + from.w / 2
  const fcy = from.y + from.h / 2
  const tcx = to.x + to.w / 2
  const tcy = to.y + to.h / 2
  const dx = tcx - fcx
  const dy = tcy - fcy
  const right = dx >= 0
  const down = dy >= 0
  const xOut = right ? from.x + from.w : from.x
  const xIn = right ? to.x : to.x + to.w
  const sameRow = Math.abs(dy) < Math.max(from.h, to.h) * 0.5
  const corridor = ctx.corridor

  const candidates = []
  const M = 8 // écart entre un bloc et le couloir emprunté

  // 1. Aligné sur la même voie : un trait franc, c'est la lecture la plus nette.
  if (sameRow) {
    candidates.push({
      points: [
        { x: xOut, y: fcy },
        { x: xIn, y: tcy },
      ],
      label: { x: (xOut + xIn) / 2, y: fcy - 12 },
      dir: 'right',
    })
  }

  // 2. Coude simple : sortie latérale, couloir vertical, entrée latérale.
  const midX = xOut + (right ? 1 : -1) * Math.max(16, Math.min(COL_GAP * 0.5, Math.abs(xIn - xOut) * 0.5))
  candidates.push({
    points: [
      { x: xOut, y: fcy },
      { x: midX, y: fcy },
      { x: midX, y: tcy },
      { x: xIn, y: tcy },
    ],
    label: { x: midX, y: (fcy + tcy) / 2 },
    dir: 'elbow',
  })

  // 3. Vertical franc, même colonne.
  candidates.push({
    points: [
      { x: fcx, y: down ? from.y + from.h : from.y },
      { x: tcx, y: down ? to.y : to.y + to.h },
    ],
    label: { x: (fcx + tcx) / 2, y: (fcy + tcy) / 2 },
    dir: down ? 'down' : 'up',
  })

  // 4. Par le couloir inférieur : on descend sous les blocs, on longe, on
  //    remonte par le bas de la cible. C'est le trajet d'un flux de retour.
  if (typeof corridor === 'number') {
    const yc = Math.max(corridor, Math.max(from.y + from.h, to.y + to.h) + M)
    candidates.push({
      points: [
        { x: fcx, y: from.y + from.h },
        { x: fcx, y: yc },
        { x: tcx, y: yc },
        { x: tcx, y: to.y + to.h },
      ],
      label: { x: (fcx + tcx) / 2, y: yc - 11 },
      dir: 'corridor-low',
    })
    candidates.push({
      points: [
        { x: xOut, y: fcy },
        { x: xOut + (right ? M : -M), y: fcy },
        { x: xOut + (right ? M : -M), y: yc },
        { x: tcx, y: yc },
        { x: tcx, y: to.y + to.h },
      ],
      label: { x: (fcx + tcx) / 2, y: yc - 11 },
      dir: 'corridor-low',
    })
  }

  // 5. Par un canal latéral libre.
  const leftX = Math.min(...boxes.map((b) => b.x), from.x) - 14
  const rightX = Math.max(...boxes.map((b) => b.x + b.w), from.x + from.w) + 14
  for (const cx of [leftX, rightX]) {
    candidates.push({
      points: [
        { x: cx > fcx ? from.x + from.w : from.x, y: fcy },
        { x: cx, y: fcy },
        { x: cx, y: tcy },
        { x: cx > tcx ? to.x + to.w : to.x, y: tcy },
      ],
      label: { x: cx, y: (fcy + tcy) / 2 },
      dir: 'channel',
    })
  }

  const chosen = candidates.find((c) => pathIsClean(c.points, boxes, from, to)) ?? candidates[candidates.length - 1]
  const route = { d: orthPath(chosen.points), points: chosen.points, dir: chosen.dir }
  route.start = chosen.points[0]
  route.end = chosen.points[chosen.points.length - 1]
  route.mid = route.points[Math.floor(route.points.length / 2)]
  if (chosen.label) route.label = chosen.label
  return route
}

// ---------------------------------------------------------------------------
// 5. PLACEMENT DES ÉTIQUETTES DE LIEN
// ---------------------------------------------------------------------------
// Une étiquette ne doit jamais recouvrir un bloc ni une autre étiquette. On
// balaie des positions le long du couloir, on écarte celles qui collisionnent,
// et on retient la première qui passe.
export function placeEdgeLabels(edges, positions, routes, opts = {}) {
  // Les blocs sont pris avec une marge : une étiquette posée au ras du cadre
  // semble le toucher. 5 px de dégagement valent mieux qu'un chevauchement.
  const M = 8
  const boxes = Object.entries(positions).map(([id, p]) => ({
    id,
    x: p.x - M,
    y: p.y - M,
    w: p.w + M * 2,
    h: p.h + M * 2,
  }))
  const placed = []
  const out = {}
  const overlaps = (a, b) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y

  // --- Mobile : une étiquette par couloir vertical, alignée dans la gouttière
  // de droite. C'est la seule zone libre d'une colonne unique.
  if (opts.narrow) {
    const perGap = new Map()
    for (const edge of edges) {
      const key = `${edge.from}|${edge.to}`
      if (!edge.label || !routes[key]) continue
      const target = positions[edge.to]
      const source = positions[edge.from]
      if (!target || !source) continue
      const lines = wrapEdgeLabel(edge.label, 13)
      const w = Math.max(...lines.map((l) => l.length)) * 5.5 + 14
      const h = lines.length > 1 ? 27 : 17
      // Ancrage dans le couloir situé AU-DESSUS du bloc cible : c'est
      // exactement l'espace que le trait vertical traverse.
      const base = target.y - 20
      const k = Math.round(base)
      const n = perGap.get(k) ?? 0
      perGap.set(k, n + 1)
      out[key] = { x: (opts.gutterX ?? 0) + w / 2, y: base + n * (h + 3), w, h, lines }
    }
    return out
  }

  for (const edge of edges) {
    const key = `${edge.from}|${edge.to}`
    if (!edge.label || !routes[key]) continue
    const route = routes[key]
    // On essaie d'abord une découpe large, puis plus étroite : une étiquette de
    // lien doit tenir DANS le couloir entre deux blocs, jamais sur un bloc.
    const lines = wrapEdgeLabel(edge.label, 12)
    const w = Math.max(...lines.map((l) => l.length)) * 5.5 + 14
    const h = lines.length > 1 ? 27 : 17
    // Point d'ancrage fourni par le tracé quand il traverse un couloir libre
    // (cas des arcs horizontaux : l'étiquette va AU-DESSUS du trait, centrée
    // dans le couloir entre deux blocs). Sinon on balaie autour du milieu.
    const anchor = route.label ? [{ x: route.label.x, y: route.label.y }] : []
    const candidates = [
      ...anchor,
      { x: route.mid.x, y: route.mid.y },
      { x: route.mid.x, y: route.mid.y - 24 },
      { x: route.mid.x, y: route.mid.y + 24 },
      { x: route.start.x + (route.end.x - route.start.x) * 0.3, y: route.start.y + (route.end.y - route.start.y) * 0.3 },
      { x: route.start.x + (route.end.x - route.start.x) * 0.7, y: route.start.y + (route.end.y - route.start.y) * 0.7 },
      { x: route.mid.x, y: route.mid.y - 46 },
      { x: route.mid.x, y: route.mid.y + 46 },
      // Décalages le long du couloir : l'étiquette glisse jusqu'à trouver un
      // intervalle libre entre deux blocs plutôt que de mordre sur l'un d'eux.
      { x: route.mid.x - w / 2 - 6, y: route.mid.y - 13 },
      { x: route.mid.x + w / 2 + 6, y: route.mid.y - 13 },
      { x: route.mid.x, y: route.mid.y - h / 2 - 6 },
    ]
    let chosen = null
    for (const c of candidates) {
      const box = { x: c.x - w / 2, y: c.y - h / 2, w, h }
      const hitsNode = boxes.some((b) => overlaps(box, b))
      const hitsLabel = placed.some((b) => overlaps(box, b))
      if (!hitsNode && !hitsLabel) {
        chosen = { ...c, w, h, lines }
        placed.push(box)
        break
      }
    }
    if (!chosen) {
      // Aucune position essayée n'est libre : on balaie autour de l'ancre
      // (décalages croissants) avant de se résoudre au repli. Une étiquette
      // qui chevauche une autre est un défaut visible ; un léger décalage ne
      // l'est pas.
      const base = candidates[0]
      const STEP = 13
      for (let ring = 1; ring <= 6 && !chosen; ring++) {
        for (const [ox, oy] of [
          [0, -ring * STEP],
          [0, ring * STEP],
          [-ring * STEP, 0],
          [ring * STEP, 0],
        ]) {
          const c = { x: base.x + ox, y: base.y + oy }
          const box = { x: c.x - w / 2, y: c.y - h / 2, w, h }
          if (boxes.some((b) => overlaps(box, b))) continue
          if (placed.some((b) => overlaps(box, b))) continue
          chosen = { ...c, w, h, lines }
          placed.push(box)
          break
        }
      }
    }
    if (!chosen) {
      // Dernier recours : on garde l'ancre et on dégage l'étiquette du bloc le
      // plus proche pour qu'elle ne le recouvre pas.
      const c = candidates[0]
      chosen = { ...c, w, h, lines }
      placed.push({ x: c.x - w / 2, y: c.y - h / 2, w, h })
    }
    // Une étiquette posée hors du cadre est rognée par le conteneur : on la
    // ramène à l'intérieur, quitte à la décaler du tracé.
    const b = opts.bounds
    if (b) {
      const halfW = chosen.w / 2
      const halfH = chosen.h / 2
      chosen.x = Math.min(Math.max(chosen.x, halfW + 2), Math.max(halfW + 2, b.w - halfW - 2))
      chosen.y = Math.min(Math.max(chosen.y, halfH + 2), Math.max(halfH + 2, b.h - halfH - 2))
    }
    out[key] = chosen
  }
  return out
}

export default memo(function SystemDiagram({ spec }) {
  const { nodes, edges, title, notes } = spec
  const wrapRef = useRef(null)
  const containerWidth = useWidth(wrapRef)
  const [activeId, setActiveId] = useState(nodes[0]?.id ?? null)
  const [hoverFlow, setHoverFlow] = useState(null)

  const narrow = containerWidth < 560

  const model = useMemo(() => {
    if (narrow) {
      // --- Mobile : une colonne, blocs pleine largeur, ordonnée par chaîne.
      const graph = analyzeGraph(nodes, edges)
      const { order } = layoutNarrow(nodes, graph)
      const byIdm = Object.fromEntries(nodes.map((n) => [n.id, n]))
      // Gouttière de droite réservée aux étiquettes de lien : sans elle, les
      // étiquettes se posaient SUR le trait vertical et se recouvraient.
      const GUTTER = 92
      const innerW = Math.max(150, containerWidth - PAD * 2 - 26 - GUTTER)
      const positions = {}
      let y = PAD
      let prevChain = null
      for (const id of order) {
        const n = byIdm[id]
        const chain = n.tier === 'source' ? id : null
        // Intertitre de chaîne : un peu d'air au-dessus, jamais au milieu d'une
        // suite de blocs.
        const gap = chain && prevChain !== null ? 54 : prevChain === null ? 34 : 40
        if (chain) prevChain = id
        // Le libellé est découpé d'après la largeur RÉELLE disponible : à
        // 390 px, 30 caractères ne tenaient pas dans le bloc.
        const maxChars = Math.max(10, Math.floor((innerW - 20) / CHAR_W))
        const lines = wrapLabel(n.label, maxChars)
        const h = NODE_H + (lines.length - 1) * 16
        positions[id] = { x: PAD, y: y + gap, w: innerW, h, lines }
        y = positions[id].y + positions[id].h
      }
      return {
        positions,
        width: containerWidth,
        height: y + PAD,
        narrow: true,
        graph,
        kind: 'narrow',
      }
    }
    const { kind, graph } = chooseLayout(nodes, edges, false)
    // Largeur cible : celle de la carte, pour que le schéma tienne d'un regard.
    const maxWidth = Math.max(520, Math.min(containerWidth - 10, 900))
    const base =
      kind === 'lanes'
        ? layoutLanes(nodes, graph)
        : kind === 'star'
          ? layoutStar(nodes, edges, graph)
          : kind === 'loop'
            ? layoutLoop(nodes, graph)
            : layoutChain(nodes, graph, { maxWidth })
    return { ...base, narrow: false, graph, kind }
  }, [nodes, edges, containerWidth, narrow])

  const { positions, width, height, graph, kind } = model

  // ÉCHELLE DE RENDU. Un schéma large ne doit pas être écrasé : en dessous de
  // 86 % de sa taille de dessin, la police du libellé passe sous 11 px et
  // devient illisible. Dans ce cas le schéma garde sa taille et son conteneur
  // défile horizontalement — un défilement se maîtrise, une police de 7 px non.
  const MIN_SCALE = 0.86
  const available = Math.max(200, containerWidth - 8)
  const natural = Math.max(model.width, 1)
  const renderWidth = Math.round(
    Math.max(natural * MIN_SCALE, Math.min(natural, available))
  )

  // Liens : routage géométrique + étiquettes sans collision.
  const routes = useMemo(() => {
    const result = {}
    const indexBySource = new Map()
    for (const e of edges) {
      const from = positions[e.from]
      const to = positions[e.to]
      if (!from || !to) continue
      const i = indexBySource.get(e.from) ?? 0
      indexBySource.set(e.from, i + 1)
      result[`${e.from}|${e.to}`] = routeEdge(from, to, i, {
        corridor: model.corridors?.back,
        narrow,
        boxes: Object.entries(positions).map(([id, p]) => ({ id, x: p.x, y: p.y, w: p.w, h: p.h })),
      })
    }
    return result
  }, [edges, positions])

  const labelPositions = useMemo(
    () =>
      placeEdgeLabels(edges, positions, routes, {
        narrow,
        gutterX: PAD + (positions[nodes[0]?.id]?.w ?? 0) + 8,
        bounds: { w: model.width, h: model.height },
      }),
    [edges, positions, routes, narrow, nodes, model.width, model.height]
  )

  const nature = useMemo(() => diagramNature(nodes, graph), [nodes, graph])

  // Intertitres mobiles : premier bloc de chaque chaîne d'énergie. Une seule
  // colonne sans repère ne distinguerait plus le chemin thermique du chemin
  // électrique, qui est justement ce que le schéma doit montrer.
  const mobileCaptions = useMemo(() => {
    if (!model.narrow) return []
    const bands = new Map()
    for (const n of nodes) {
      if (n.tier !== 'source') continue
      const chain = /batterie|accumulateur/i.test(n.label) ? 'electrique' : 'thermique'
      if (!bands.has(chain)) bands.set(chain, n.id)
    }
    if (bands.size < 2) return []
    return [...bands.entries()].map(([chain, id]) => ({
      id,
      y: (positions[id]?.y ?? PAD) - 6,
      title: chain === 'electrique' ? 'Chaîne électrique' : 'Chaîne thermique',
    }))
  }, [model.narrow, nodes, positions])

  // Bandeaux de voie : quand deux chaînes d'énergie coexistent, chaque chaîne
  // porte un nom. C'est ce qui rend la distinction « thermique / électrique »
  // visible sans lire les libellés.
  const laneBands = useMemo(() => {
    // En disposition chaîne, les deux chemins sont déjà séparés par les
    // libellés d'arc (« couple thermique » / « couple électrique ») et par la
    // couleur du flux. Un bandeau par chaîne recouvrait les blocs de l'autre
    // chaîne : on ne l'affiche que dans la disposition en voies, où chaque voie
    // est une rangée et où le bandeau n'a rien à recouvrir.
    if (!model.lanes || model.lanes.length < 2) return []
    return model.lanes.map((lane, i) => {
      const ids = nodes.filter((n) => positions[n.id]?.lane === i).map((n) => n.id)
      const flows = new Set(edges.filter((e) => ids.includes(e.from) || ids.includes(e.to)).map((e) => e.flow))
      return {
        y: lane.y - 10,
        h: lane.h + 20,
        caption: laneCaption(lane, flows),
      }
    })
  }, [model.lanes, nodes, edges, positions])
  const usedFlows = useMemo(() => {
    const order = ['mechanical', 'energy', 'fluid', 'heat', 'information', 'control', 'recovery', 'gas', 'ignition']
    return order.filter((f) => edges.some((e) => e.flow === f))
  }, [edges])

  const markers = useMemo(
    () =>
      usedFlows.map((flow) => ({
        id: `sr-arrow-${flow}`,
        color: styleOf(flow).color,
      })),
    [usedFlows]
  )

  const active = nodes.find((n) => n.id === activeId) ?? nodes[0]
  const activeEdges = edges.filter((e) => e.from === active?.id || e.to === active?.id)
  const byId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.id, n])), [nodes])

  return (
    <div className="sr-system" ref={wrapRef}>
      {title && <h4 className="sr-visual-title">{formatTitle(title)}</h4>}

      <div className={`sr-system-stage${renderWidth > available ? ' is-scrollable' : ''}`}>
        <svg
          viewBox={`0 0 ${Math.max(model.width, 1)} ${Math.max(model.height, 1)}`}
          width={renderWidth}
          className={`sr-system-svg${narrow ? ' is-narrow' : ''} is-${kind}${
            natural > available ? ' is-scroll' : ''
          }`}
          style={{ width: renderWidth, maxWidth: renderWidth, height: 'auto' }}
          role="group"
          aria-label={`${title ?? 'Diagramme'} — ${nature.label}`}
        >
          <defs>
            {markers.map((m) => (
              <marker
                key={m.id}
                id={m.id}
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="5.5"
                markerHeight="5.5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0.8 L 7.4 4 L 0 7.2 z" fill={m.color} />
              </marker>
            ))}
            {usedFlows.includes('heat') && (
              <pattern id="sr-heat-pattern" width="6" height="6" patternUnits="userSpaceOnUse">
                <circle cx="1.5" cy="1.5" r="1.1" fill={FLOW_STYLE.heat.color} opacity="0.75" />
              </pattern>
            )}
          </defs>

          {/* Bandeaux de voie : au fond, ils regroupent visuellement la chaîne
              thermique et la chaîne électrique sans masquer les flèches. */}
          <g className="sr-system-lanes">
            {laneBands.map((band, i) => (
              <g key={`lane-${i}`}>
                <rect
                  className="sr-system-lane-band"
                  x={band.x ?? PAD - 12}
                  y={band.y}
                  width={Math.max(0, band.w ?? model.width - (PAD - 12) * 2)}
                  height={band.h}
                  rx="14"
                />
                <text className="sr-system-lane-caption" x={(band.x ?? PAD - 12) + 8} y={band.y + 13}>
                  {band.caption}
                </text>
              </g>
            ))}
          </g>

          {/* Couloirs de retour : dessinés en premier, sous tout le reste. */}
          <g className="sr-system-edges">
            {edges.map((edge, i) => {
              const route = routes[`${edge.from}|${edge.to}`]
              if (!route) return null
              const style = styleOf(edge.flow)
              const dimmed = hoverFlow && hoverFlow !== edge.flow
              const highlighted = activeId === edge.from || activeId === edge.to
              return (
                <g
                  key={`${edge.from}|${edge.to}|${i}`}
                  className={`sr-system-edge is-${edge.flow}${highlighted ? ' is-active' : ''}${dimmed ? ' is-dimmed' : ''}`}
                  onMouseEnter={() => setHoverFlow(edge.flow)}
                  onMouseLeave={() => setHoverFlow(null)}
                >
                  <path
                    d={route.d}
                    fill="none"
                    stroke={style.color}
                    strokeWidth={highlighted ? style.width + 0.9 : style.width}
                    strokeDasharray={style.dash === 'none' ? undefined : style.dash}
                    strokeLinecap="round"
                    markerEnd={`url(#sr-arrow-${edge.flow})`}
                    opacity={dimmed ? 0.2 : highlighted ? 1 : 0.78}
                  />
                </g>
              )
            })}
          </g>

          {/* Mobile : la disposition est une colonne, mais la lecture des deux
              chaînes reste la même qu'en desktop. Chaque changement de voie est
              annoncé par un intertitre, sinon la colonne redevient une simple
              liste de blocs. */}
          {model.narrow && mobileCaptions.length > 0 && (
            <g className="sr-system-lanes">
              {mobileCaptions.map((cap) => (
                // Sur mobile, l'intertitre est posé dans l'espace libre au-dessus
                // du premier bloc de la chaîne : un fond coloré recouvrirait les
                // blocs voisins d'une colonne unique.
                <text key={`mcap-${cap.id}`} className="sr-system-lane-caption" x={PAD - 2} y={cap.y - 10}>
                  {cap.title}
                </text>
              ))}
            </g>
          )}

          {/* Étiquettes de liens, dans un groupe rendu APRÈS les nœuds pour rester
              au premier plan (correctif antérieur conservé). */}
          <g className="sr-system-nodes">
            {nodes.map((node) => {
              const p = positions[node.id]
              if (!p) return null
              const isActive = node.id === active?.id
              const lines = p.lines
              const tierLabel = TIER_LABELS[node.tier]
              const labelY = p.y + p.h / 2 - ((lines.length - 1) * 15) / 2
              return (
                <g
                  key={node.id}
                  className={`sr-system-node is-${node.tier}${isActive ? ' is-active' : ''}${node.added ? ' is-added' : ''}`}
                  tabIndex={0}
                  role="button"
                  aria-label={`${node.label}${tierLabel ? `. ${tierLabel}` : ''}${node.detail ? `. ${node.detail}` : ''}`}
                  aria-pressed={isActive}
                  onClick={() => setActiveId(node.id)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setActiveId(node.id)
                    }
                  }}
                >
                  <rect x={p.x} y={p.y} width={p.w} height={p.h} rx="10" />
                  <rect className="sr-system-node-accent" x={p.x} y={p.y} width="3" height={p.h} rx="1.5" />
                  {(() => {
                    // Bloc du libellé = hauteur totale MOINS la mention de rôle.
                    // Le libellé est centré dans cet espace, et non dans le
                    // bloc entier : sinon il chevauchait la mention.
                    const blockH = p.h - (tierLabel ? 13 : 0)
                    const firstY = p.y + blockH / 2 - ((lines.length - 1) * 15) / 2
                    return lines.map((line, li) => (
                      <text
                        key={li}
                        x={p.x + p.w / 2}
                        y={firstY + li * 15}
                        textAnchor="middle"
                        dominantBaseline="middle"
                        className="sr-system-node-label"
                      >
                        {line}
                      </text>
                    ))
                  })()}
                  {tierLabel && (
                    <text
                      x={p.x + p.w / 2}
                      y={p.y + p.h - 9}
                      textAnchor="middle"
                      className="sr-system-node-tier"
                    >
                      {tierLabel}
                    </text>
                  )}
                </g>
              )
            })}
          </g>

          <g className="sr-system-labels">
            {edges.map((edge, i) => {
              const lp = labelPositions[`${edge.from}|${edge.to}`]
              if (!lp) return null
              const dimmed = hoverFlow && hoverFlow !== edge.flow
              return (
                <g
                  key={`lbl-${edge.from}|${edge.to}|${i}`}
                  className={`sr-system-edge-label-group${dimmed ? ' is-dimmed' : ''}`}
                >
                  <rect
                    x={lp.x - lp.w / 2}
                    y={lp.y - lp.h / 2}
                    width={lp.w}
                    height={lp.h}
                    rx="7"
                    className="sr-system-edge-label-bg"
                  />
                  {lp.lines.map((line, li, arr) => (
                    <text
                      key={li}
                      x={lp.x}
                      y={lp.y + (li - (arr.length - 1) / 2) * 12 + 3.4}
                      textAnchor="middle"
                      className="sr-system-edge-label"
                    >
                      {line}
                    </text>
                  ))}
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      {/* Légende : la nature du schéma, puis chaque flux réellement employé. */}
      <div className="sr-system-legend-block">
        <p className="sr-system-nature">{nature.label}</p>
        <ul className="sr-system-legend" aria-label="Types de flux">
          {usedFlows.map((flow) => {
            const style = styleOf(flow)
            return (
              <li
                key={flow}
                className={hoverFlow === flow ? 'is-active' : ''}
                onMouseEnter={() => setHoverFlow(flow)}
                onMouseLeave={() => setHoverFlow(null)}
              >
                <span
                  className="sr-system-legend-line"
                  style={
                    style.dash === 'none'
                      ? { background: style.color, height: 3 }
                      : {
                          background: `repeating-linear-gradient(90deg, ${style.color} 0 5px, transparent 5px 9px)`,
                          height: 3,
                        }
                  }
                  aria-hidden="true"
                />
                {style.label}
              </li>
            )
          })}
        </ul>
      </div>

      {active && (
        <div className="sr-system-detail">
          <div className="sr-system-detail-head">
            <strong>{active.label}</strong>
            {TIER_LABELS[active.tier] && (
              <span className={`sr-system-badge is-${active.tier}`}>{TIER_LABELS[active.tier]}</span>
            )}
            {active.added && <span className="sr-system-badge is-added">ajouté</span>}
          </div>
          {active.detail && <p>{active.detail}</p>}
          {activeEdges.length > 0 && (
            <ul className="sr-system-links">
              {activeEdges.map((edge, i) => {
                const outgoing = edge.from === active.id
                const other = byId[outgoing ? edge.to : edge.from]
                if (!other) return null
                return (
                  <li key={i}>
                    <span className={`sr-system-arrow is-${edge.flow}`} aria-hidden="true">
                      {outgoing ? '→' : '←'}
                    </span>
                    <span className="sr-system-link-flow">{styleOf(edge.flow).label.toLowerCase()}</span>
                    {edge.label ? ` · ${edge.label} ` : ' '}
                    <strong>{other.label}</strong>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}

      {notes?.length > 0 && (
        <ul className="sr-system-notes">
          {notes.map((note, i) => (
            <li key={i}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  )
})
