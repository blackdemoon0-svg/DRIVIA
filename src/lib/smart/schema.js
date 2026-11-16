// Validation stricte des blocs visuels ```veyvro.
// Principe : liste blanche de clés, types vérifiés, tailles bornées.
// Tout ce qui n'est pas conforme est rejeté → repli markdown.
// Aucune chaîne n'est jamais interprétée comme du HTML.

const MAX_NODES = 12
const MAX_POINTS = 60
const MAX_ROWS = 14
const MAX_COLS = 4
const MAX_TEXT = 220
const MAX_DETAIL = 900
const MAX_ITEMS = 8
// Type « cycle » : phases numérotées d'un cycle technique + pièces du mécanisme.
export const CYCLE_STATES = ['admission', 'compression', 'detente', 'echappement']
// Type « journey » : trajet bidirectionnel numéroté.
export const JOURNEY_LANES = ['request', 'response', 'side']
const MAX_JOURNEY_STEPS = 8
const MAX_PHASES = 6
const MAX_PART_NODES = 8
const MAX_PART_EDGES = 10
const PHASE_REQUIRED = ['number', 'name']

export const VISUAL_TYPES = ['flow', 'timeline', 'chart', 'comparison', 'steps', 'diagram', 'concept', 'pie', 'layers', 'system', 'cycle', 'journey']
export const FLOW_LABELS = {
  energy: 'Énergie',
  control: 'Commande',
  mechanical: 'Mécanique',
  recovery: 'Récupération',
  gas: 'Gaz / fluide',
  ignition: 'Allumage',
}

function str(value, max = MAX_TEXT) {
  if (typeof value !== 'string') return null
  const clean = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  if (!clean) return null
  return clean.slice(0, max)
}

function num(value) {
  const n = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(n) ? n : null
}

function arr(value, max) {
  return Array.isArray(value) ? value.slice(0, max) : null
}

function title(raw) {
  return str(raw, 120) ?? undefined
}

function flow(raw) {
  const nodes = arr(raw.nodes, MAX_NODES)
  if (!nodes || nodes.length < 2) return null
  const out = []
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || typeof n !== 'object') return null
    const label = str(n.label)
    if (!label) return null
    out.push({ id: str(n.id, 40) ?? `n${i}`, label, detail: str(n.detail, MAX_DETAIL) ?? undefined })
  }
  return { type: 'flow', title: title(raw.title), nodes: out, loop: raw.loop === true }
}

function timeline(raw) {
  const events = arr(raw.events, MAX_NODES)
  if (!events || events.length < 2) return null
  const out = []
  for (const e of events) {
    if (!e || typeof e !== 'object') return null
    const label = str(e.label)
    if (!label) return null
    out.push({ label, date: str(e.date, 40) ?? undefined, detail: str(e.detail, MAX_DETAIL) ?? undefined })
  }
  return { type: 'timeline', title: title(raw.title), events: out }
}

function steps(raw) {
  const list = arr(raw.steps, MAX_NODES)
  if (!list || list.length < 2) return null
  const out = []
  for (const s of list) {
    if (!s || typeof s !== 'object') return null
    const label = str(s.title ?? s.label)
    if (!label) return null
    out.push({ title: label, detail: str(s.detail, MAX_DETAIL) ?? undefined })
  }
  return { type: 'steps', title: title(raw.title), steps: out }
}

function chart(raw) {
  const variant = raw.variant === 'line' ? 'line' : raw.variant === 'bar' ? 'bar' : null
  if (!variant) return null
  const series = arr(raw.series, 3)
  if (!series || !series.length) return null
  const out = []
  for (const s of series) {
    if (!s || typeof s !== 'object') return null
    const points = arr(s.points, MAX_POINTS)
    if (!points || points.length < 2) return null
    const parsed = []
    for (const p of points) {
      if (!p || typeof p !== 'object') return null
      const y = num(p.y)
      const x = str(p.x, 40) ?? String(p.x ?? '')
      if (y === null || !x) return null
      parsed.push({ x, y })
    }
    out.push({ label: str(s.label, 60) ?? 'Série', points: parsed })
  }
  return { type: 'chart', variant, title: title(raw.title), unit: str(raw.unit, 16) ?? undefined, series: out }
}

function comparison(raw) {
  const columns = arr(raw.columns, MAX_COLS)
  if (!columns || columns.length < 2) return null
  const cols = columns.map((c) => str(c, 60))
  if (cols.some((c) => !c)) return null
  const rows = arr(raw.rows, MAX_ROWS)
  if (!rows || !rows.length) return null
  const parsedRows = []
  for (const r of rows) {
    if (!r || typeof r !== 'object') return null
    const label = str(r.label, 80)
    const values = arr(r.values, cols.length)
    if (!label || !values || values.length !== cols.length) return null
    const cells = values.map((v) => str(v, 120) ?? '—')
    parsedRows.push({ label, values: cells })
  }
  const lists = (obj, key) => {
    const source = obj?.[key]
    if (!source || typeof source !== 'object') return undefined
    const result = {}
    for (const col of cols) {
      const items = arr(source[col], MAX_ITEMS)
      if (!items) continue
      const clean = items.map((i) => str(i, 140)).filter(Boolean)
      if (clean.length) result[col] = clean
    }
    return Object.keys(result).length ? result : undefined
  }
  return {
    type: 'comparison',
    title: title(raw.title),
    columns: cols,
    rows: parsedRows,
    pros: lists(raw, 'pros'),
    cons: lists(raw, 'cons'),
    conclusion: str(raw.conclusion, MAX_DETAIL) ?? undefined,
  }
}

// Diagramme hiérarchique (organigramme) : arbre récursif borné.
const MAX_TREE_NODES = 24
const MAX_TREE_DEPTH = 4

function treeNode(raw, depth, counter) {
  if (!raw || typeof raw !== 'object' || depth > MAX_TREE_DEPTH) return null
  const label = str(raw.label)
  if (!label) return null
  counter.count++
  if (counter.count > MAX_TREE_NODES) return null
  const node = { id: str(raw.id, 40) ?? `n${counter.count}`, label, detail: str(raw.detail, MAX_DETAIL) ?? undefined }
  // Au-delà de 8 enfants, le diagramme est refusé plutôt que tronqué :
  // on ne masque jamais silencieusement une partie de l'arbre.
  if (Array.isArray(raw.children) && raw.children.length > 8) return null
  const children = arr(raw.children, 8)
  if (children) {
    const parsed = []
    for (const child of children) {
      const parsedChild = treeNode(child, depth + 1, counter)
      if (!parsedChild) return null
      parsed.push(parsedChild)
    }
    if (parsed.length) node.children = parsed
  }
  return node
}

function diagram(raw) {
  const counter = { count: 0 }
  const root = treeNode(raw.root, 0, counter)
  if (!root || counter.count < 2) return null
  return { type: 'diagram', title: title(raw.title), root }
}

// Carte conceptuelle : nœuds + relations nommées.
function concept(raw) {
  const nodes = arr(raw.nodes, 10)
  if (!nodes || nodes.length < 2) return null
  const out = []
  const ids = new Set()
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i]
    if (!n || typeof n !== 'object') return null
    const label = str(n.label)
    if (!label) return null
    const id = str(n.id, 40) ?? `n${i}`
    ids.add(id)
    out.push({ id, label, detail: str(n.detail, MAX_DETAIL) ?? undefined })
  }
  const edgesRaw = arr(raw.edges, 20) ?? []
  const edges = []
  for (const e of edgesRaw) {
    if (!e || typeof e !== 'object') return null
    const from = str(e.from, 40)
    const to = str(e.to, 40)
    if (!from || !to || !ids.has(from) || !ids.has(to)) return null
    edges.push({ from, to, label: str(e.label, 60) ?? undefined })
  }
  return { type: 'concept', title: title(raw.title), nodes: out, edges }
}

// Diagramme circulaire (camembert / donut).
function pie(raw) {
  const slices = arr(raw.slices, 8)
  if (!slices || slices.length < 2) return null
  const out = []
  let total = 0
  for (const s of slices) {
    if (!s || typeof s !== 'object') return null
    const label = str(s.label, 60)
    const value = num(s.value)
    if (!label || value === null || value < 0) return null
    total += value
    out.push({ label, value })
  }
  if (total <= 0) return null
  return { type: 'pie', title: title(raw.title), unit: str(raw.unit, 16) ?? undefined, slices: out }
}

// Couches superposées (ex. couches de l'atmosphère).
function layers(raw) {
  const items = arr(raw.items, 8)
  if (!items || items.length < 2) return null
  const out = []
  for (const item of items) {
    if (!item || typeof item !== 'object') return null
    const label = str(item.label)
    if (!label) return null
    out.push({ label, value: str(item.value, 60) ?? undefined, detail: str(item.detail, MAX_DETAIL) ?? undefined })
  }
  return { type: 'layers', title: title(raw.title), items: out }
}


// Diagramme système : nœuds typés + liens typés (énergie, commande, mécanique,
// récupération). C'est ce qui permet de distinguer visuellement un flux
// d'énergie d'un signal de commande et d'un mouvement mécanique.
const MAX_SYSTEM_NODES = 14
const MAX_SYSTEM_EDGES = 24
// `fluid`, `heat` et `information` ont été ajoutés pour les schémas produits par
// le raisonneur : sans eux, un flux de liquide ou de chaleur serait rendu comme
// un flux d'énergie, ce qui efface la distinction entre matière et énergie.
const FLOW_KINDS = ['energy', 'control', 'mechanical', 'recovery', 'gas', 'ignition', 'fluid', 'heat', 'information']
const TIERS = ['source', 'control', 'power', 'mechanical', 'recovery', 'other']

function system(raw) {
  const nodesRaw = arr(raw.nodes, MAX_SYSTEM_NODES)
  if (!nodesRaw || nodesRaw.length < 3) return null
  const nodes = []
  const ids = new Set()
  for (const n of nodesRaw) {
    if (!n || typeof n !== 'object') return null
    const label = str(n.label, 80)
    if (!label) return null
    const id = str(n.id, 40) ?? `s${nodes.length}`
    if (ids.has(id)) return null
    ids.add(id)
    nodes.push({
      id,
      label,
      detail: str(n.detail, MAX_DETAIL) ?? undefined,
      tier: TIERS.includes(n.tier) ? n.tier : 'other',
    })
  }
  const edgesRaw = arr(raw.edges, MAX_SYSTEM_EDGES) ?? []
  const edges = []
  const seenPairs = new Set()
  for (const e of edgesRaw) {
    if (!e || typeof e !== 'object') return null
    const from = str(e.from, 40)
    const to = str(e.to, 40)
    if (!from || !to || from === to) return null
    if (!ids.has(from) || !ids.has(to)) return null
    const pairKey = `${from}->${to}`
    // Un doublon de direction est refusé : deux flèches opposées entre les
    // mêmes nœuds sont légitimes (aller / retour), la même direction non.
    if (seenPairs.has(pairKey)) return null
    seenPairs.add(pairKey)
    edges.push({
      from,
      to,
      label: str(e.label, 60) ?? undefined,
      flow: FLOW_KINDS.includes(e.flow) ? e.flow : 'energy',
    })
  }
  if (!edges.length) return null
  const notes = arr(raw.notes, 6)
  return {
    type: 'system',
    title: title(raw.title),
    nodes,
    edges,
    notes: notes ? notes.map((n) => str(n, 200)).filter(Boolean) : undefined,
  }
}


// Type « cycle » — un mécanisme dont le fonctionnement se déroule en phases
// successives (moteur à quatre temps, cycle de Rankine, cycle de l'eau…).
//
// Deux représentations coexistent, et c'est volontaire :
//   • `phases`  : le déroulé numéroté (admission → compression → détente →
//                 échappement). C'est ce que l'utilisateur suit du regard.
//   • `parts`   : les pièces et leurs liens orientés typés, qui répondent à
//                 « qui entraîne qui » (bielle → vilebrequin, came → soupape).
// Les fusionner produirait un graphe illisible ; les séparer garde chaque
// niveau de lecture exact.
function cycle(raw) {
  const phasesRaw = arr(raw.phases, MAX_PHASES)
  if (!phasesRaw || phasesRaw.length < 3) return null
  const phases = []
  const nums = new Set()
  for (let i = 0; i < phasesRaw.length; i++) {
    const p = phasesRaw[i]
    if (!p || typeof p !== 'object') return null
    const name = str(p.name, 80)
    if (!name) return null
    const number = num(p.number)
    const n = number === null ? i + 1 : Math.trunc(number)
    if (n < 1 || n > 20 || nums.has(n)) return null
    nums.add(n)
    phases.push({
      number: n,
      name,
      state: CYCLE_STATES.includes(p.state) ? p.state : undefined,
      piston: str(p.piston, 40) ?? undefined,
      valves: str(p.valves, 60) ?? undefined,
      detail: str(p.detail, MAX_DETAIL) ?? undefined,
      media: str(p.media, 40) ?? undefined,
    })
  }
  // La progression doit être continue : 1, 2, 3… sinon la numérotation ment.
  const sorted = [...nums].sort((a, b) => a - b)
  if (sorted[0] !== 1 || sorted.some((n, i) => n !== i + 1)) return null

  let parts
  if (raw.parts) {
    const nodesRaw = arr(raw.parts.nodes, MAX_PART_NODES)
    if (!nodesRaw || nodesRaw.length < 2) return null
    const nodes = []
    const ids = new Set()
    for (const n of nodesRaw) {
      if (!n || typeof n !== 'object') return null
      const label = str(n.label, 80)
      if (!label) return null
      const id = str(n.id, 40) ?? `p${nodes.length}`
      if (ids.has(id)) return null
      ids.add(id)
      nodes.push({
        id,
        label,
        detail: str(n.detail, MAX_DETAIL) ?? undefined,
        // Grille explicite facultative : le producteur du schéma peut placer
        // les pièces (colonne / ligne) pour obtenir une disposition exacte.
        // Sans coordonnées, le rendu retombe sur un rangement automatique.
        col: Number.isInteger(n.col) ? Math.max(0, Math.min(5, n.col)) : undefined,
        row: Number.isInteger(n.row) ? Math.max(0, Math.min(4, n.row)) : undefined,
      })
    }
    // Deux pièces ne peuvent pas occuper la même case : sinon le schéma ment.
    const cells = new Set()
    for (const n of nodes) {
      if (n.col === undefined || n.row === undefined) continue
      const key = `${n.col}:${n.row}`
      if (cells.has(key)) return null
      cells.add(key)
    }
    const edgesRaw = arr(raw.parts.edges, MAX_PART_EDGES) ?? []
    const edges = []
    const seenPairs = new Set()
    for (const e of edgesRaw) {
      if (!e || typeof e !== 'object') return null
      const from = str(e.from, 40)
      const to = str(e.to, 40)
      if (!from || !to || from === to) return null
      if (!ids.has(from) || !ids.has(to)) return null
      const key = `${from}->${to}`
      if (seenPairs.has(key)) return null
      seenPairs.add(key)
      edges.push({
        from,
        to,
        label: str(e.label, 60) ?? undefined,
        flow: FLOW_KINDS.includes(e.flow) ? e.flow : 'mechanical',
      })
    }
    if (!edges.length) return null
    parts = { nodes, edges, caption: str(raw.parts.caption, 160) ?? undefined }
  }

  const notes = arr(raw.notes, 6)
  return {
    type: 'cycle',
    title: title(raw.title),
    cycleName: str(raw.cycleName, 80) ?? undefined,
    phases,
    parts,
    notes: notes ? notes.map((n) => str(n, 200)).filter(Boolean) : undefined,
  }
}


// Type « journey » — un trajet de données dans les deux sens.
//
// Cas d'usage typique : « ce qui se passe quand j'ouvre une page web ». Le sujet
// n'est ni une séquence linéaire (le retour est une information de premier plan)
// ni un graphe de composants (l'ordre chronologique compte). On modélise donc :
//   • des étapes numérotées, chacune rattachée à une voie (`lane`) :
//       request  = voie aller   (de l'utilisateur vers le serveur)
//       response = voie retour  (du serveur vers l'utilisateur)
//       side     = hors trajet  (résolution DNS : elle n'achemine pas la donnée)
//   • des composants avec leur rôle, indépendamment de l'ordre des étapes.
// Le rendu dessine les deux voies en vis-à-vis, ce qui rend le demi-tour évident.
function journey(raw) {
  const stepsRaw = arr(raw.steps, MAX_JOURNEY_STEPS)
  if (!stepsRaw || stepsRaw.length < 3) return null
  const steps = []
  const numbers = new Set()
  for (let i = 0; i < stepsRaw.length; i++) {
    const s = stepsRaw[i]
    if (!s || typeof s !== 'object') return null
    const label = str(s.label, 90)
    if (!label) return null
    const number = num(s.number)
    const n = number === null ? i + 1 : Math.trunc(number)
    if (n < 1 || n > 20 || numbers.has(n)) return null
    numbers.add(n)
    steps.push({
      number: n,
      label,
      lane: JOURNEY_LANES.includes(s.lane) ? s.lane : 'request',
      detail: str(s.detail, MAX_DETAIL) ?? undefined,
      protocol: str(s.protocol, 40) ?? undefined,
    })
  }
  const sorted = [...numbers].sort((a, b) => a - b)
  if (sorted[0] !== 1 || sorted.some((n, i) => n !== i + 1)) return null
  // Le trajet doit avoir un aller ET un retour : sinon ce n'est pas un journey.
  if (!steps.some((s) => s.lane === 'request') || !steps.some((s) => s.lane === 'response')) return null

  let components
  if (raw.components) {
    const nodesRaw = arr(raw.components, 10)
    if (!nodesRaw) return null
    components = []
    for (const c of nodesRaw) {
      if (!c || typeof c !== 'object') return null
      const label = str(c.label, 80)
      if (!label) return null
      components.push({
        label,
        role: str(c.role, 40) ?? undefined,
        detail: str(c.detail, MAX_DETAIL) ?? undefined,
      })
    }
    if (!components.length) components = undefined
  }

  const notes = arr(raw.notes, 6)
  return {
    type: 'journey',
    title: title(raw.title),
    from: str(raw.from, 60) ?? undefined,
    to: str(raw.to, 60) ?? undefined,
    steps,
    components,
    encryption: str(raw.encryption, 240) ?? undefined,
    notes: notes ? notes.map((n) => str(n, 200)).filter(Boolean) : undefined,
  }
}

const BUILDERS = { flow, timeline, chart, comparison, steps, diagram, concept, pie, layers, system, cycle, journey }

// Retourne un spec valide, ou null (repli markdown).
export function validateVisual(input) {
  let raw = input
  if (typeof input === 'string') {
    if (input.length > 20000) return null
    try { raw = JSON.parse(input) } catch { return null }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  if (!VISUAL_TYPES.includes(raw.type)) return null
  try {
    return BUILDERS[raw.type](raw)
  } catch {
    return null
  }
}
