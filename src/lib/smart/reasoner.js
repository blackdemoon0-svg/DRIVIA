// Raisonneur de mécanismes — construit une représentation à partir de la
// STRUCTURE de la question, sans règle dédiée au sujet.
//
// Quatre étapes :
//   1. SEGMENTER et repérer les mentions de composants (catalogue
//      `mechanics.js`, formes abrégées, familles de fonction).
//   2. CLASSER chaque mention par famille, en tenant compte du CONTEXTE :
//      « moteur » dans un système de refroidissement est la source de chaleur,
//      pas un moteur électrique — c'est exactement la confusion qui produisait
//      un schéma d'onduleur pour une question de refroidissement.
//   3. TISSER les relations avec un squelette physique générique (chaleur →
//      fluide → pompe → échangeur → retour ; capteur → calculateur →
//      actionneur), puis ajouter les relations explicitement demandées.
//   4. DÉCIDER d'une représentation adaptée : graphe de régulation, chaîne de
//      puissance, ou refus explicite si la question n'est pas un mécanisme.
//
// Ce module n'invente jamais un composant absent de la question et du
// catalogue. Les seuls ajouts sont les rôles SANS LESQUELS la boucle décrite
// serait physiquement fausse (l'air qui reçoit la chaleur d'un radiateur), et
// ils sont marqués `added` pour être signalés à l'utilisateur.

import { COMPONENTS, DOMAIN_NAMING, INTENT_SIGNALS, ACTION_HEADS } from './mechanics'

const norm = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, "'")
    .trim()

// ---------------------------------------------------------------------------
// 0. Domaines : ils donnent le VOCABULAIRE et le NOM des organes.
// ---------------------------------------------------------------------------
export const DOMAINS = [
  // L'hybride passe AVANT les domaines d'organes : une question sur une
  // propulsion hybride nomme forcément un moteur thermique et un moteur
  // électrique, et les domaines `air` / `ev` la captaient au premier mot venu
  // (Mercedes-AMG C 63 S E PERFORMANCE finissait en « admission d'air »).
  // Un domaine est un SYSTÈME, pas un mot : dès que deux chaînes d'énergie
  // coexistent, c'est l'hybride qui décide de la lecture.
  {
    id: 'hybrid',
    re: /hybride|hybrid|rechargeable|plug-in|phev|\bmhev\b|micro.?hybride|cha[îi]ne de propulsion|cha[îi]ne cin[ée]matique|groupe motopropulseur|powertrain|propulsion|4matic|4x4|transmission int[ée]grale|batterie haute tension|r[ée]cup[ée]ration d'[ée]nergie|moteur [ée]lectrique.*(?:arri[èe]re|essieu)/i,
  },
  { id: 'cooling', re: /refroidissement|refroidir|surchauffe|thermostat|pompe a eau|liquide de refroidissement|radiateur|thermique du moteur|echange thermique/i, heat: true },
  { id: 'lubrication', re: /lubrification|huile moteur|pompe a huile|filtre a huile|coussinets|graissage|carter/i, heat: true },
  { id: 'traction', re: /controle de traction|motricite|antipatinage|patinage|\basr\b|\btcs\b|freinage selectif/i },
  { id: 'steering', re: /direction assistee|cremaillere|angle de volant|biellettes de direction|roues directrices|assistance de direction/i },
  { id: 'braking', re: /freinage|etriers?|disques? de frein|plaquettes?|antiblocage|\babs\b|maitre.cylindre/i },
  { id: 'air', re: /admission|suralimentation|turbo|intercooler|papillon|filtre a air|air comprime/i },
  { id: 'fuel', re: /carburant|injection|injecteurs?|rampe d'injection|pompe a carburant/i },
  { id: 'ignition', re: /allumage|bougies?|bobines? d'allumage|etincelle/i },
  { id: 'exhaust', re: /echappement|catalyseur|pot catalytique/i },
  { id: 'ev', re: /voiture electrique|vehicule electrique|batterie de traction|onduleur/i },
]

export function detectDomain(question) {
  const q = norm(question)
  // Le domaine le plus SPÉCIFIQUE gagne : on compte les marqueurs, puis on
  // départage sur la longueur du marqueur trouvé (un terme technique précis
  // pèse plus qu'un mot général).
  let best = null
  for (const d of DOMAINS) {
    const hits = q.match(new RegExp(d.re.source, 'gi')) ?? []
    if (!hits.length) continue
    const weight = hits.reduce((n, h) => n + h.length, 0)
    if (!best || weight > best.weight) best = { domain: d.id, heat: Boolean(d.heat), weight, hits }
  }
  return best ?? { domain: 'unknown', heat: false, weight: 0, hits: [] }
}

// ---------------------------------------------------------------------------
// 1. Segmentation
// ---------------------------------------------------------------------------
export function segments(question) {
  const text = String(question ?? '')
  const m = text.match(/\s(?:notamment|comprenant|incluant|dont|avec|y compris)\s+|:\s+/i)
  if (!m) return { head: text.trim(), items: [] }
  const head = text.slice(0, m.index)
  const tail = text.slice(m.index + m[0].length)
  const items = tail
    .split(/[,;]|\bet\b|\bpuis\b|\bainsi que\b/i)
    .map((s) => s.trim().replace(/^(?:la|le|les|l'|une|un|des|du)\s+/i, '').replace(/[.?!]+$/, ''))
    .filter((s) => s.length > 2 && s.split(/\s+/).length <= 6)
  return { head: head.trim(), items }
}

// ---------------------------------------------------------------------------
// 2. Mentions de composants
// ---------------------------------------------------------------------------
// Un terme qui commence par un verbe d'action nominalisé n'est PAS un organe :
// « circulation du liquide » est une relation, pas un nœud.
function isAction(term) {
  return ACTION_HEADS.test(term.trim())
}

function catalogueMatches(term) {
  const t = norm(term)
  if (!t) return []
  const out = []
  for (const [id, def] of Object.entries(COMPONENTS)) {
    const forms = [def.label, ...(def.alts ?? [])].map(norm)
    for (const f of forms) {
      if (!f) continue
      // Correspondance sur mot entier : « pompe » ne doit pas matcher
      // « pompe à huile » quand on cherche « pompe à eau ».
      const re = new RegExp(`(^|[^a-z0-9])${f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
      if (re.test(t)) {
        out.push({ id, def, form: f })
        break
      }
    }
  }
  // Le terme le plus SPÉCIFIQUE d'abord : « pompe à eau » avant « pompe ».
  return out.sort((a, b) => b.form.length - a.form.length)
}

// Alias dépendants du DOMAINE : « le liquide » dans un circuit de
// refroidissement désigne le liquide de refroidissement ; « l'huile » dans un
// circuit de lubrification désigne l'huile moteur. Sans cette lecture, la
// question « circulation du liquide » ne nommait aucun fluide et le graphe
// perdait son axe principal.
const CONTEXT_ALIASES = {
  cooling: [{ id: 'coolant', re: /\bliquide\b/i }],
  lubrication: [{ id: 'oil', re: /\bhuile\b/i }],
}

// Résolution des chevauchements : quand plusieurs composants du catalogue
// correspondent au même passage du texte, le plus LONG gagne.
// Sans cette règle, « moteur électrique » produisait à la fois le composant
// « Moteur électrique » et « Moteur », et « roues directrices » produisait
// aussi « Roues » : deux systèmes se retrouvaient dans un même schéma.
function spanMatches(text, domainId) {
  const t = norm(text)
  const found = []
  for (const [id, def] of Object.entries(COMPONENTS)) {
    const forms = [def.label, ...(def.alts ?? [])].map(norm)
    for (const f of forms) {
      if (!f) continue
      let from = 0
      for (;;) {
        const i = t.indexOf(f, from)
        if (i < 0) break
        const before = i === 0 ? ' ' : t[i - 1]
        const after = i + f.length >= t.length ? ' ' : t[i + f.length]
        if (!/[a-z0-9]/.test(before) && !/[a-z0-9]/.test(after)) {
          found.push({ id, def, form: f, start: i, end: i + f.length })
        }
        from = i + 1
      }
    }
  }
  for (const alias of CONTEXT_ALIASES[domainId] ?? []) {
    const re = new RegExp(alias.re.source, 'gi')
    let m
    while ((m = re.exec(t)) !== null) {
      const def = COMPONENTS[alias.id]
      found.push({ id: alias.id, def, form: norm(m[0]), start: m.index, end: m.index + m[0].length, contextual: true })
    }
  }
  found.sort((a, b) => b.form.length - a.form.length || a.start - b.start)
  const taken = []
  const out = []
  for (const f of found) {
    if (taken.some(([s, e]) => f.start < e && f.end > s)) continue
    taken.push([f.start, f.end])
    out.push(f)
  }
  return out.sort((a, b) => a.start - b.start)
}

// Mots qui ne désignent JAMAIS un organe : marques, appellations commerciales,
// sigles de finition. Les promouvoir en nœuds produisait des blocs parasites
// sans aucune relation physique (« PERFORMANCE » relié au turbocompresseur).
const NOT_A_COMPONENT =
  /^(performance|competition|sport|amg|mercedes|benz|bmw|audi|porsche|volkswagen|renault|peugeot|citroen|toyota|ford|tesla|ferrari|lamborghini|edition|excellence|line|plus|pro|premium|evolution|trophy|lineup)$/i

export function mentions(question) {
  const q = String(question ?? '')
  const dom = detectDomain(q)
  const { head, items } = segments(q)
  const out = []
  const used = new Set()
  const add = (m) => {
    if (!m.key || used.has(m.key)) return
    used.add(m.key)
    out.push(m)
  }

  // a) Éléments énumérés par l'utilisateur — priorité absolue.
  for (const item of items ?? []) {
    const spans = spanMatches(item, dom.domain)
    if (spans.length) {
      const best = spans[0]
      add({
        key: best.id,
        id: best.id,
        label: best.def.label,
        fn: best.def.fn,
        families: best.def.families ?? [],
        source: 'declared',
        raw: item,
      })
      continue
    }
    if (isAction(item)) {
      // Action nominalisée : ce n'est pas un organe, c'est une relation. Mais
      // elle porte souvent un OBJET qu'il faut représenter : « réduction du
      // couple moteur » nomme le moteur comme cible de la régulation.
      add({ key: `action:${norm(item)}`, id: `action:${norm(item)}`, label: cleanLabel(item), fn: null, families: [], source: 'action', raw: item })
      for (const span of spanMatches(item, dom.domain)) {
        add({ key: span.id, id: span.id, label: span.def.label, fn: span.def.fn, families: span.def.families ?? [], source: 'action-object', raw: item })
      }
      continue
    }
    if (item.length > 3 && /[a-zà-ÿ]{4,}/i.test(item)) {
      add({ key: norm(item), id: `custom:${norm(item)}`, label: cleanLabel(item), fn: null, families: [], source: 'declared', raw: item })
    }
  }

  // b) Composants du catalogue reconnus dans toute la question, sans
  //    chevauchement (le plus spécifique l'emporte).
  for (const span of spanMatches(q, dom.domain)) {
    add({
      key: span.id,
      id: span.id,
      label: span.def.label,
      fn: span.def.fn,
      families: span.def.families ?? [],
      source: 'question',
      raw: span.form,
    })
  }

  // c) Termes techniques du sujet, hors catalogue : on reprend les mots de
  //    l'utilisateur, on n'invente rien.
  for (const word of (head ?? '').split(/[^a-zA-Zà-ÿ'-]+/)) {
    const w = word.trim()
    if (w.length < 6 || used.has(norm(w)) || isAction(w)) continue
    // Les mots du MÉTA-discours (« fonctionnement », « description »…) ne
    // désignent aucun organe : les traiter comme composants produisait un nœud
    // « Fonctionnement » dans le schéma.
    if (/^(fonctionnement|description|explication|detail|principe|presentation|resume|analyse|comparaison)$/.test(norm(w))) continue
    // Un NOM DE MARQUE ou de finition n'est pas un composant : « PERFORMANCE »
    // était promu nœud du schéma parce qu'il finissait en « ance ».
    if (NOT_A_COMPONENT.test(w)) continue
    if (!/(eur|euse|ier|ière|oire|ateur|ement|ance|ence)s?$/i.test(w)) continue
    if (spanMatches(w, dom.domain).length) continue
    add({ key: norm(w), id: `custom:${norm(w)}`, label: cleanLabel(w), fn: null, families: [], source: 'inferred', raw: w })
  }

  return out
}

function cleanLabel(raw) {
  return titleCase(String(raw).replace(/[.;:!?]+$/, '').trim())
}

function titleCase(raw) {
  const s = String(raw).trim().replace(/^(?:la|le|les|l'|une|un|des|du)\s+/i, '')
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// ---------------------------------------------------------------------------
// 3. Rôle contextuel de chaque mention
// ---------------------------------------------------------------------------
// Le squelette d'un domaine est une suite ordonnée de RÔLES, pas de noms.
// Le placement d'une mention dépend de sa famille ET du domaine.
const SKELETONS = {
  cooling: ['heatSource', 'pump', 'fluid', 'valve', 'exchanger', 'sensor', 'control', 'air'],
  lubrication: ['heatSource', 'reservoir', 'pump', 'filter', 'fluid', 'air', 'sensor', 'control'],
  traction: ['wheel', 'sensor', 'control', 'engineTorque', 'absModule', 'freinSelectif'],
  steering: ['steeringWheel', 'sensor', 'control', 'assist', 'column', 'rack', 'tieRod', 'steeredWheels'],
  braking: ['pedal', 'masterCylinder', 'absModule', 'caliper', 'disc', 'wheel'],
  air: ['airFilter', 'turbo', 'intercooler', 'engine', 'exhaust'],
  fuel: ['fuelTank', 'fuelPump', 'injector', 'cylinders', 'exhaust'],
  ignition: ['battery', 'coil', 'sparkPlug', 'cylinders', 'control'],
  exhaust: ['cylinders', 'exhaust', 'catalyst'],
  ev: ['battery', 'inverter', 'electricMotor', 'gearbox', 'wheel'],
  // Deux chaînes d'énergie, une convergence : c'est la topologie du système,
  // pas l'ordre d'une liste de composants.
  hybrid: ['engine', 'gearbox', 'engineChain', 'tractionBattery', 'rearMotor', 'electricChain', 'recovery', 'awd', 'wheel'],
}

// Un composant peut occuper plusieurs rôles selon le domaine.
function rolesOf(mention, domainId, heatDomain) {
  const id = mention.id
  const fam = mention.families ?? []
  const label = norm(mention.label)

  // --- Moteur : son rôle dépend ENTIÈREMENT du système.
  //   refroidissement/lubrification → source de chaleur
  //   contrôle de traction          → source de couple à réduire
  //   direction assistée            → actionneur d'assistance
  //   chaîne électrique             → moteur de traction
  // C'est cette lecture contextuelle qui empêche de confondre deux systèmes.
  if (id === 'engine') {
    if (heatDomain) return ['heatSource']
    if (domainId === 'traction') return ['engineTorque']
    if (domainId === 'steering') return ['assist']
    return ['engineTorque', 'engine']
  }
  if (id === 'electricMotor' && domainId === 'steering') return ['assist']
  if (id === 'cylinders') return heatDomain ? ['heatSource'] : ['cylinders']

  // --- Chaîne hybride : chaque organe reçoit SA chaîne.
  // Le moteur électrique arrière n'est PAS un organe de la boîte thermique :
  // il est placé dans la branche électrique, et c'est le schéma qui doit le
  // montrer sur la voie arrière.
  if (domainId === 'hybrid') {
    if (id === 'engine') return ['engine']
    if (id === 'gearbox') return ['gearbox']
    if (id === 'tractionBattery' || id === 'battery') return ['tractionBattery']
    if (id === 'rearMotor' || id === 'electricMotor') return ['rearMotor']
    if (id === 'regen') return ['recovery']
    if (id === 'awd') return ['awd']
    if (id === 'wheel') return ['wheel']
    if (id === 'inverter') return ['inverter']
  }

  // --- Rôles nommés (direction, freinage).
  // Actions nominalisées : elles ne sont pas des organes, mais elles désignent
  // un RÔLE du squelette. Les ignorer faisait perdre « réduction du couple » et
  // « freinage sélectif », donc le levier d'action du contrôle de traction.
  const label2 = norm(mention.label)
  if (/detection|mesure|analyse/.test(label2) && /patinage|vitesse|temperature|pression/.test(label2)) return ['mesure']
  if (/reduction|regulation|commande|pilotage/.test(label2) && /couple|carburant|pression|debit/.test(label2)) return ['regulation']
  if (/freinage selectif|freinage cible/.test(label2)) return ['freinSelectif']
  if (/transmission|liaison/.test(label2) && /mouvement|rotation|debit|chaleur/.test(label2)) return ['flux']

  const named = {
    steeringWheel: 'steeringWheel', steeringColumn: 'column', rack: 'rack', tieRod: 'tieRod',
    steeredWheels: 'steeredWheels', assistMotor: 'assist', caliper: 'caliper', disc: 'disc',
    pads: 'pad', brakePedal: 'pedal', masterCylinder: 'masterCylinder', wheel: 'wheel',
    wheelSensor: 'sensor', turbo: 'turbo', intercooler: 'intercooler', airFilter: 'airFilter',
    injector: 'injector', fuelPump: 'fuelPump', fuelTank: 'fuelTank', sparkPlug: 'sparkPlug',
    coil: 'coil', catalyst: 'catalyst', exhaust: 'exhaust', inverter: 'inverter',
    electricMotor: 'electricMotor', gearbox: 'gearbox', battery: 'battery', absModule: 'absModule',
    tractionBattery: 'tractionBattery', rearMotor: 'rearMotor', regen: 'recovery', awd: 'awd',
    thermostat: 'valve', wastegate: 'valve', throttle: 'valve', fan: 'pump',
    waterPump: 'pump', oilPump: 'pump', oilFilter: 'filter', oilPan: 'reservoir',
    coolant: 'fluid', oil: 'fluid', tempSensor: 'sensor',
  }
  if (named[id]) return [named[id]]

  // --- Familles génériques : sensor / control / valve / pump / exchanger...
  if (fam.includes('sensor')) return ['sensor']
  if (fam.includes('control')) return ['control']
  if (fam.includes('valve')) return ['valve', 'absModule'].filter((r) => SKELETONS[domainId]?.includes(r))
  if (fam.includes('pump')) return ['pump']
  if (fam.includes('exchanger')) return ['exchanger']
  if (fam.includes('fluid')) return ['fluid']
  if (fam.includes('reservoir')) return ['reservoir']
  if (fam.includes('filter')) return ['filter']
  if (fam.includes('source')) return ['battery']



  // --- Terme inconnu : le mot lui-même décide.
  if (/capteur|sonde|detecteur/.test(label)) return ['sensor']
  if (/calculateur|module|centrale/.test(label)) return ['control']
  if (/pompe|compresseur|ventilateur/.test(label)) return ['pump']
  if (/radiateur|echangeur/.test(label)) return ['exchanger']
  if (/vanne|thermostat|papillon/.test(label)) return ['valve']
  if (/reservoir|carter/.test(label)) return ['reservoir']
  if (/filtre/.test(label)) return ['filter']
  if (/circuit|canalisation|durite|rampe/.test(label)) return ['fluid']
  return ['part']
}

// Rôles qu'il est légitime d'ajouter pour que la physique soit juste.
// Chacun est marqué `added` et signalé dans les notes : rien n'est présenté
// comme venant de la question.
const FILLERS = {
  air: { label: 'Air ambiant', fn: 'Milieu qui reçoit la chaleur évacuée par l\'échangeur.' },
  fluid: { label: 'Circuit de circulation', fn: 'Relie les organes et ramène le fluide vers la source de chaleur.' },
  control: { label: 'Calculateur', fn: 'Reçoit les mesures et commande les actionneurs de la régulation.' },
}

// ---------------------------------------------------------------------------
// 4. Construction
// ---------------------------------------------------------------------------
export function reason(question) {
  const q = String(question ?? '')
  if (q.length < 8) return { supported: false, reason: 'question trop courte' }

  const dom = detectDomain(q)
  const skeleton = SKELETONS[dom.domain]
  if (!skeleton) {
    return { supported: false, reason: 'domaine non modélisé', domain: dom.domain }
  }

  const raw = mentions(q)
  // Deux passes : les ORGANES d'abord, les ACTIONS ensuite. L'ordre des mots
  // dans la question ne doit pas décider du rôle d'une action : « détection du
  // patinage » était traitée avant que le calculateur existe, donc affichée
  // comme un composant au lieu d'étiqueter l'arc mesure → calculateur.
  const ms = [...raw.filter((m) => m.source !== 'action'), ...raw.filter((m) => m.source === 'action')]
  // Une question n'est un mécanisme que si elle nomme au moins deux organes.
  if (ms.length < 2) {
    return { supported: false, reason: 'moins de deux composants identifiés', domain: dom.domain, mentions: ms }
  }

  // --- Placement
  let nodes = []
  const taken = new Set()
  const absorbed = []
  const actionLabels = {}
  for (const m of ms) {
    // Une action nominalisée sans rôle identifiable est une RELATION, pas un
    // organe. La poser comme nœud produisait des schémas faux (« Échange
    // thermique » dessiné comme composant). Elle reste exprimée par les arcs.
    if (m.source === 'action') {
      const r = rolesOf(m, dom.domain, dom.heat)
      const target = { mesure: 'control', regulation: 'engineTorque', freinSelectif: 'absModule' }[r?.[0]]
      const hasTarget = target === 'control'
        ? nodes.some((n) => n.role === 'control')
        : nodes.some((n) => n.role === target)
      // L'action est absorbée (représentée par un arc étiqueté) uniquement si
      // son organe cible existe déjà. Sinon c'est une FONCTION que l'utilisateur
      // a explicitement demandée : elle mérite son propre nœud, avec un libellé
      // honnête (« Freinage sélectif »), et non un accès inventé.
      if (!r || !r[0] || r[0] === 'part' || (['mesure', 'regulation', 'freinSelectif'].includes(r[0]) && hasTarget)) {
        absorbed.push(m.label)
        if (r?.[0]) actionLabels[r[0]] = m.label
        continue // relation, pas un organe : elle s'exprimera par les arcs
      }
      // Action conservée comme nœud fonctionnel : on lui associe le rôle cible.
      if (r?.[0] && target) {
        m.families = [target === 'control' ? 'control' : 'mechanical']
        m.forcedRole = r[0]
      }
    }
    const roles = rolesOf(m, dom.domain, dom.heat)
    const isActionMention = m.source === 'action'
    if (m.forcedRole) {
      nodes.push({
        id: `n${nodes.length}`,
        role: m.forcedRole,
        label: namingFor(m, dom.domain),
        fn: m.fn,
        source: 'action',
        families: m.families,
      })
      continue
    }
    const role = isActionMention
      ? roles[0] // une action garde SON rôle propre, elle ne prend pas celui d'un organe
      : roles.find((r) => skeleton.includes(r) && !taken.has(r)) ?? roles.find((r) => skeleton.includes(r)) ?? roles[0]
    if (!role || role === 'part') {
      nodes.push({ id: `n${nodes.length}`, role: 'part', label: namingFor(m, dom.domain), fn: m.fn, source: m.source })
      continue
    }
    const isSecondary = taken.has(role)
    taken.add(role)
    nodes.push({
      id: `n${nodes.length}`,
      role,
      label: namingFor(m, dom.domain),
      fn: m.fn,
      source: m.source,
      families: m.families,
      secondary: isSecondary,
    })
  }

  // --- Compléments physiquement nécessaires (boucles uniquement)
  const isLoop = ['cooling', 'lubrication', 'traction'].includes(dom.domain)
  // Un circuit thermique sans fluide nommé n'aurait ni axe ni sens de
  // circulation : on nomme le fluide du domaine, marqué comme ajouté.
  if ((dom.domain === 'cooling' || dom.domain === 'lubrication') && !taken.has('fluid')) {
    const fluidDef = dom.domain === 'cooling' ? COMPONENTS.coolant : COMPONENTS.oil
    nodes.push({
      id: `n${nodes.length}`,
      role: 'fluid',
      label: fluidDef.label,
      fn: fluidDef.fn,
      families: ['fluid'],
      source: 'added',
      added: true,
    })
    taken.add('fluid')
  }
  if (dom.domain === 'traction' && !taken.has('wheel')) {
    nodes.push({
      id: `n${nodes.length}`,
      role: 'wheel',
      label: 'Roues motrices',
      fn: 'Seul contact avec la route : c\'est leur adhérence qui limite la motricité.',
      families: ['mechanical'],
      source: 'added',
      added: true,
    })
    taken.add('wheel')
  }
  if (isLoop) {
    // Un échangeur sans milieu qui reçoit la chaleur serait faux : on nomme l'air.
    if (taken.has('exchanger') && !taken.has('air') && FILLERS.air) {
      const hasAir = nodes.some((n) => n.role === 'air')
      if (!hasAir) {
        nodes.push({ id: `n${nodes.length}`, role: 'air', label: FILLERS.air.label, fn: FILLERS.air.fn, added: true })
        taken.add('air')
      }
    }
    // Une mesure sans circuit à mesurer n'a pas de sens : on ne l'ajoute pas.
  }

  // --- Filtrer les mentions hors SYSTÈME
  //
  // Un composant du catalogue peut être nommé sans appartenir au système
  // décrit : « le moteur thermique 2.0 turbo » nomme un turbocompresseur, mais
  // le turbo n'est pas un maillon de la chaîne de propulsion. Il était
  // conservé puis rattaché à tout le reste par un lien générique — c'est ce
  // mécanisme qui fabriquait les schémas en étoile sans signification.
  // Règle : un nœud reste s'il a un rôle du squelette du domaine, ou s'il
  // participe à une relation physique connue de ce domaine. Sinon il est
  // écarté, et le schéma ne le montre pas.
  const flowRoles = new Set((FLOW_ORDER[dom.domain] ?? []).flatMap(([a, b]) => [a, b]))
  const kept = nodes.filter((n) => skeleton.includes(n.role) || flowRoles.has(n.role))
  if (kept.length >= 3) nodes = kept

  if (nodes.length < 3) {
    return { supported: false, reason: 'graphe trop pauvre', domain: dom.domain, mentions: ms }
  }

  const edges = buildEdges(nodes, dom.domain, actionLabels)

  if (!edges.length) {
    return { supported: false, reason: 'aucune relation fiable', domain: dom.domain, mentions: ms }
  }

  // Vocabulaire de l'utilisateur : quand la question nomme une désignation
  // précise (MCT, DCT, DSG… pour la boîte ; 4MATIC, xDrive, quattro… pour la
  // transmission intégrale), le schéma l'affiche. C'est la même information
  // que celle demandée, sans invention : le libellé générique reste le repli.
  applyUserDesignations(nodes, q)

  const hasFeedback = edges.some((e) => e.flow === 'information') && edges.some((e) => e.flow === 'control')

  return {
    supported: true,
    representedActions: absorbed,
    domain: dom.domain,
    type: 'system',
    looped: hasFeedback,
    title: titleFor(dom.domain, q, nodes),
    nodes: nodes.map((n) => ({
      id: n.id,
      label: n.label,
      detail: detailFor(n, dom.domain),
      tier: tierFor(n),
      added: n.added,
      role: n.role,
    })),
    edges,
    notes: notesFor(dom.domain, hasFeedback, nodes),
    // Le graphe porte plusieurs chaînes d'énergie parallèles : le planificateur
    // ne doit pas le remplacer par un gabarit qui n'en montrerait qu'une.
    multiChain: hasParallelChains(nodes, edges),
    meta: { domain: dom.domain, absorbed, mentions: ms.map((m) => ({ label: m.label, source: m.source })) },
  }
}

// Deux chaînes parallèles = deux sources de nature DIFFÉRENTE qui alimentent
// chacune leur branche : une source d'énergie électrique et une source de
// couple mécanique. Un circuit de refroidissement a bien une pompe et une
// source de chaleur, mais les deux poussent le MÊME fluide dans la même
// boucle : ce n'est pas une architecture à deux chaînes.
function hasParallelChains(nodes, edges) {
  const flowsOf = (id) => new Set(edges.filter((e) => e.from === id).map((e) => e.flow))
  const sources = nodes.filter((n) => tierFor(n) === 'source' && edges.some((e) => e.from === n.id))
  const electric = sources.filter((n) => flowsOf(n.id).has('energy'))
  const mechanical = sources.filter((n) => flowsOf(n.id).has('mechanical') || flowsOf(n.id).has('heat'))
  const distinct = electric.some((e) => mechanical.some((m) => m.id !== e.id))
  return distinct && new Set(edges.map((e) => e.flow)).size >= 2
}

// Désignations commerciales reconnues dans la question, associées au rôle
// qu'elles précisent. Aucune n'est inventée : elles ne s'appliquent que si la
// question les contient.
const DESIGNATIONS = [
  { role: 'gearbox', re: /\b(MCT|DCT|DSG|CVT|SPEEDSHIFT|tiptronic|EAT8)\b/i, prefix: 'Transmission' },
  { role: 'awd', re: /\b(4MATIC\+|4MATIC|4x4|xDrive|quattro|4MOTION)/i, prefix: 'Transmission intégrale' },
]

function applyUserDesignations(nodes, question) {
  for (const d of DESIGNATIONS) {
    const m = String(question).match(d.re)
    if (!m) continue
    const node = nodes.find((n) => n.role === d.role)
    if (!node) continue
    const tag = m[1].toUpperCase().startsWith('SPEEDSHIFT') ? m[1].toUpperCase() : m[1].toUpperCase()
    node.label = `${d.prefix} ${tag}`
  }
}

// Niveau de rendu : le schéma colore les nœuds par nature (source, commande,
// puissance, mécanique). Sans ce champ, tous les nœuds sortaient en « autre ».
function tierFor(node) {
  const role = node.role
  const fam = node.families ?? []
  if (role === 'control' || role === 'sensor' || role === 'valve' || role === 'assist' || role === 'mesure' || role === 'regulation') return 'control'
  if (role === 'freinSelectif') return 'mechanical'
  if (role === 'flux') return 'power'
  // Hiérarchie propre à une propulsion hybride : deux sources, deux chaînes,
  // un répartiteur, la récupération en retour.
  if (role === 'tractionBattery') return 'source'
  if (role === 'engine') return 'source'
  if (role === 'gearbox' || role === 'rearMotor' || role === 'awd' || role === 'inverter') return 'power'
  if (role === 'recovery') return 'recovery'
  if (role === 'wheel') return 'mechanical'
  if (fam.includes('control') || fam.includes('sensor')) return 'control'
  if (role === 'heatSource' || role === 'engineTorque' || role === 'pump' || role === 'reservoir' || fam.includes('source')) return 'source'
  if (role === 'exchanger' || role === 'air') return 'recovery'
  if (role === 'fluid') return 'power'
  return 'mechanical'
}

function detailFor(node, domainId) {
  if (node.fn) return node.fn
  const byRole = {
    sensor: 'Mesure une grandeur physique et la transmet au calculateur.',
    control: 'Compare les mesures à une consigne et commande les actionneurs.',
    valve: 'Règle le débit ou la pression qui le traverse ; son ouverture est pilotée.',
    pump: 'Met le fluide en mouvement et maintient le débit dans le circuit.',
    exchanger: 'Cède la chaleur du fluide au milieu qui le traverse.',
    reservoir: 'Stocke le fluide et absorbe ses variations de volume.',
    filter: 'Retient les particules en suspension dans le fluide.',
    fluid: 'Transporte la chaleur ou la matière entre les organes, en boucle.',
    air: 'Milieu qui reçoit la chaleur évacuée par l\'échangeur.',
    heatSource: 'Produit la chaleur que le circuit doit évacuer.',
    engineTorque: 'Fournit le couple aux roues ; le réduire fait cesser le patinage.',
    assist: 'Applique un couple qui s\'ajoute à celui du conducteur.',
    absModule: 'Module la pression de freinage roue par roue, sans action du conducteur.',
    mesure: 'Compare deux mesures (vitesses, températures, pressions) pour détecter l\'écart qui révèle le phénomène.',
    regulation: 'Corrige l\'écart mesuré en réduisant l\'effort demandé, sans action brutale sur le conducteur.',
    freinSelectif: 'Freine la seule roue concernée, via le bloc ABS, sans agir sur les autres.',
    mesure: 'Compare deux mesures (vitesses, températures, pressions) pour détecter l\'écart révélateur.',
    regulation: 'Corrige l\'écart mesuré en réduisant l\'effort demandé au moteur, sans à-coup.',
    flux: 'Trajet suivi par le fluide ou la chaleur entre les organes.',
    gearbox: 'Adapte le régime du moteur thermique à la vitesse du véhicule ; ici une transmission à embrayages multiples, sans convertisseur de couple.',
    rearMotor: 'Machine électrique de l\'essieu arrière : elle entraîne les roues arrière sans passer par la boîte thermique.',
    tractionBattery: 'Réserve d\'énergie électrique de traction : elle alimente la machine arrière et absorbe l\'énergie de récupération.',
    recovery: 'Phase où la machine électrique fonctionne en génératrice : l\'énergie cinétique des roues retourne vers la batterie au lieu de partir en chaleur dans les freins.',
    awd: 'Répartiteur de couple entre les essieux : c\'est le point de convergence des deux chaînes avant les roues.',
    part: `Élément nommé dans votre question (${domainId}).`,
  }
  return byRole[node.role] ?? `Élément nommé dans votre question (${domainId}).`
}

function namingFor(mention, domainId) {
  if (mention.id && mention.id.startsWith('custom:')) return mention.label
  const specific = DOMAIN_NAMING[domainId]?.[mention.id]
  return specific ?? mention.label
}

// --- Relations -------------------------------------------------------------
// Ordre physique par domaine : c'est de la connaissance générale, pas une
// réponse pré-écrite. Le graphe suit cet ordre et le sens réel du flux.
const FLOW_ORDER = {
  cooling: [
    ['heatSource', 'fluid', 'heat', 'chaleur cédée'],
    ['pump', 'fluid', 'fluid', 'mise en circulation'],
    ['fluid', 'valve', 'fluid', 'liquide vers la vanne'],
    ['valve', 'exchanger', 'fluid', 'débit régulé'],
    ['fluid', 'exchanger', 'fluid', 'liquide chaud'],
    ['exchanger', 'air', 'heat', 'chaleur évacuée'],
    ['exchanger', 'fluid', 'fluid', 'liquide refroidi'],
    ['fluid', 'heatSource', 'fluid', 'retour au moteur'],
    // boucle d'information
    ['heatSource', 'sensor', 'information', 'température mesurée'],
    ['sensor', 'control', 'information', 'mesure transmise'],
    ['control', 'valve', 'control', 'ouverture pilotée'],
    ['control', 'pump', 'control', 'débit commandé'],
  ],
  lubrication: [
    ['reservoir', 'fluid', 'fluid', 'huile puisée'],
    ['pump', 'fluid', 'fluid', 'huile mise sous pression'],
    ['fluid', 'filter', 'fluid', 'huile chargée'],
    ['filter', 'heatSource', 'fluid', 'huile propre vers les organes'],
    ['heatSource', 'air', 'heat', 'chaleur évacuée'],
    ['heatSource', 'sensor', 'information', 'pression et température'],
    ['sensor', 'control', 'information', 'mesures transmises'],
  ],
  traction: [
    ['wheel', 'sensor', 'information', 'vitesse de roue'],
    ['sensor', 'control', 'information', 'écart de vitesse = patinage'],
    ['control', 'engineTorque', 'control', 'couple réduit'],
    ['control', 'freinSelectif', 'control', 'freinage demandé'],
    ['freinSelectif', 'wheel', 'mechanical', 'frein sélectif'],
    ['control', 'absModule', 'control', 'freinage sélectif'],
    ['absModule', 'wheel', 'mechanical', 'frein sélectif'],
  ],
  steering: [
    ['steeringWheel', 'column', 'mechanical', 'rotation du volant'],
    ['column', 'rack', 'mechanical', 'rotation transmise'],
    ['rack', 'tieRod', 'mechanical', 'translation'],
    ['tieRod', 'steeredWheels', 'mechanical', 'orientation'],
    ['steeringWheel', 'sensor', 'information', 'angle de volant'],
    ['sensor', 'control', 'information', 'angle et couple mesurés'],
    ['control', 'assist', 'control', 'assistance calculée'],
    ['assist', 'column', 'control', 'couple ajouté'],
    // L'angle réel des roues n'est mesuré que par un capteur dédié : cet arc
    // est filtré plus bas si le capteur présent est celui du volant.
  ],
  braking: [
    ['pedal', 'masterCylinder', 'mechanical', 'effort du conducteur'],
    ['masterCylinder', 'absModule', 'fluid', 'pression hydraulique'],
    ['absModule', 'caliper', 'fluid', 'pression modulée'],
    ['caliper', 'disc', 'mechanical', 'serrage'],
    ['disc', 'wheel', 'mechanical', 'couple de freinage'],
    ['wheel', 'sensor', 'information', 'vitesse de roue'],
    ['sensor', 'control', 'information', 'mesure transmise'],
  ],
  air: [
    ['airFilter', 'turbo', 'fluid', 'air filtré'],
    ['turbo', 'intercooler', 'fluid', 'air comprimé'],
    ['intercooler', 'engine', 'fluid', 'air refroidi, plus dense'],
    ['engine', 'exhaust', 'fluid', 'gaz brûlés'],
    ['exhaust', 'turbo', 'heat', 'gaz qui entraînent la turbine'],
  ],
  fuel: [
    ['fuelTank', 'fuelPump', 'fluid', 'carburant puisé'],
    ['fuelPump', 'injector', 'fluid', 'carburant sous pression'],
    ['injector', 'cylinders', 'fluid', 'carburant pulvérisé'],
    ['cylinders', 'exhaust', 'fluid', 'gaz brûlés'],
  ],
  ignition: [
    ['battery', 'coil', 'energy', 'basse tension'],
    ['coil', 'sparkPlug', 'energy', 'haute tension'],
    ['sparkPlug', 'cylinders', 'ignition', 'étincelle'],
    ['control', 'coil', 'control', 'avance à l\'allumage'],
  ],
  exhaust: [
    ['cylinders', 'exhaust', 'fluid', 'gaz brûlés'],
    ['exhaust', 'catalyst', 'fluid', 'gaz à traiter'],
  ],
  // --- Hybridation : deux chaînes qui CONVERGENT.
  // La flèche thermique et la flèche électrique restent parallèles jusqu'au
  // répartiteur (transmission intégrale), puis se rejoignent aux roues : c'est
  // exactement ce que la question demande de distinguer.
  hybrid: [
    // chaîne thermique
    ['engine', 'gearbox', 'mechanical', 'couple thermique'],
    ['gearbox', 'awd', 'mechanical', 'couple transmis'],
    // chaîne électrique
    ['tractionBattery', 'rearMotor', 'energy', 'courant de traction'],
    // Le moteur arrière entraîne l'essieu arrière ; la transmission intégrale
    // répartit le couple entre les essieux. Les deux chaînes restent distinctes.
    ['rearMotor', 'awd', 'mechanical', 'couple électrique'],
    // convergence
    ['awd', 'wheel', 'mechanical', 'couple aux quatre roues'],
    // récupération : l'énergie revient des roues vers la batterie
    ['wheel', 'recovery', 'mechanical', 'énergie cinétique'],
    ['recovery', 'tractionBattery', 'recovery', 'énergie récupérée'],
  ],
  ev: [
    ['battery', 'inverter', 'energy', 'courant continu'],
    ['inverter', 'electricMotor', 'energy', 'courant alternatif'],
    ['electricMotor', 'gearbox', 'mechanical', 'couple'],
    ['gearbox', 'wheel', 'mechanical', 'rotation'],
  ],
}

// Chaîne mécanique par domaine : rôles qui transmettent un EFFORT, dans
// l'ordre. Sert à relier les étapes présentes quand un intermédiaire manque
// (une crémaillère sans biellettes reste reliée aux roues directrices).
const MECH_CHAIN = {
  steering: ['steeringWheel', 'column', 'rack', 'tieRod', 'steeredWheels'],
  braking: ['pedal', 'masterCylinder', 'absModule', 'caliper', 'disc', 'wheel'],
  fuel: ['fuelTank', 'fuelPump', 'injector', 'cylinders'],
  air: ['airFilter', 'turbo', 'intercooler', 'engine'],
  ignition: ['battery', 'coil', 'sparkPlug', 'cylinders'],
  exhaust: ['cylinders', 'exhaust', 'catalyst'],
  ev: ['battery', 'inverter', 'electricMotor', 'gearbox', 'wheel'],
  // Volontairement absente : en hybride, les deux chaînes sont parallèles.
  // Une « chaîne mécanique » unique relierait le moteur électrique à la boîte
  // thermique, exactement l'erreur d'architecture que le schéma doit éviter.
}

function buildEdges(nodes, domainId, actionLabels = {}) {
  const order = FLOW_ORDER[domainId] ?? []
  const byRole = new Map()
  for (const n of nodes) if (!byRole.has(n.role)) byRole.set(n.role, n)

  const edges = []
  const add = (from, to, flow, label) => {
    if (!from || !to || from === to) return
    if (edges.some((e) => e.from === from.id && e.to === to.id)) return
    // Deux arcs opposés sont légitimes s'ils transportent des flux DIFFÉRENTS :
    // la chaleur va du moteur au liquide, le liquide revient au moteur. On ne
    // bloque donc que le doublon exact (même sens, même flux).
    if (edges.some((e) => e.from === to.id && e.to === from.id && e.flow === flow)) return
    edges.push({ from: from.id, to: to.id, flow, label })
  }

  for (const [a, b, flow, label] of order) {
    // Garde sémantique : ne pas attribuer à un capteur d'angle de volant une
    // mesure d'angle de roue.
    const to = byRole.get(b)
    if (a === 'steeredWheels' && to && /volant/i.test(norm(to.label))) continue
    add(byRole.get(a), to, flow, label)
  }

  // Chaîne mécanique : on relie les étapes PRÉSENTES, dans l'ordre, même si un
  // intermédiaire n'a pas été nommé. Aucun nœud n'est créé : on raccourcit
  // seulement l'arc manquant.
  const chain = MECH_CHAIN[domainId] ?? []
  const present = chain.map((r) => byRole.get(r)).filter(Boolean)
  for (let i = 0; i < present.length - 1; i++) {
    const a = present[i]
    const b = present[i + 1]
    if (edges.some((e) => (e.from === a.id && e.to === b.id) || (e.from === b.id && e.to === a.id))) continue
    add(a, b, 'mechanical', 'transmission du mouvement')
  }

  // L'assistance s'ajoute à la chaîne mécanique : sans colonne, elle agit
  // directement sur la crémaillère.
  if (byRole.get('assist')) {
    const target = byRole.get('column') ?? byRole.get('rack') ?? byRole.get('steeringWheel')
    if (target) add(byRole.get('assist'), target, 'mechanical', 'couple assisté')
  }

  // Lubrification : les surfaces de glissement reçoivent l'huile sous pression.
  const fluidNode = byRole.get('fluid')
  if (fluidNode) {
    for (const n of nodes) {
      if (n.role === 'part' && /coussinet|palier|surface|bague/i.test(norm(n.label))) {
        add(fluidNode, n, 'fluid', 'film d\'huile')
      }
    }
  }

  // Les rôles d'ACTION (mesure, régulation, freinage sélectif, flux) sont des
  // relations, pas des organes : ils prennent la place de l'arc correspondant
  // sans créer de nœud supplémentaire.
  const REWIRE = [
    // rôle d'action conservé comme nœud (le trajet du fluide, lui, se voit)
    ['flux', [['pump', 'fluid', 'fluid', 'met le fluide en mouvement'], ['heatSource', 'fluid', 'heat', 'chaleur cédée au fluide'], ['fluid', 'exchanger', 'fluid', 'liquide chaud'], ['column', 'rack', 'mechanical', 'rotation transmise']]],
  ]
  // Les actions mesurées (« détection du patinage », « réduction du couple »)
  // étiquettent l'arc correspondant au lieu d'apparaître comme un organe.
  const ACTION_ARC = [
    ['mesure', 'sensor', 'control', 'information'],
    ['regulation', 'control', 'engineTorque', 'control'],
    ['regulation', 'control', 'valve', 'control'],
    ['freinSelectif', 'control', 'absModule', 'control'],
  ]
  for (const [roleId, a, b, flow] of ACTION_ARC) {
    if (!actionLabels[roleId]) continue
    const from = byRole.get(a)
    const to = byRole.get(b)
    if (!from || !to) continue
    const idx = edges.findIndex((e) => e.from === from.id && e.to === to.id)
    if (idx >= 0) edges[idx].label = actionLabels[roleId].toLowerCase()
  }

  for (const [roleId, arcs] of REWIRE) {
    const actionNode = byRole.get(roleId)
    if (!actionNode) continue
    for (const [a, b, flow, label] of arcs) {
      const from = byRole.get(a)
      const to = byRole.get(b)
      if (!from || !to) continue
      // On retire l'arc nominal et on le remplace par deux arcs passant par
      // l'action, ce qui rend le mécanisme lisible : entrée → action → sortie.
      const idx = edges.findIndex((e) => e.from === from.id && e.to === to.id)
      if (idx >= 0) edges.splice(idx, 1)
      add(from, actionNode, flow === 'control' ? 'information' : flow, label)
      add(actionNode, to, flow, label)
    }
    // Une action sans arc nominal trouvé reste reliée au calculateur.
    if (!edges.some((e) => e.from === actionNode.id || e.to === actionNode.id)) {
      const anchor = byRole.get('control') ?? byRole.get('wheel') ?? nodes.find((n) => n.id !== actionNode.id)
      if (anchor) add(anchor, actionNode, 'control', 'fonction du système')
    }
  }

  // Rôles hors squelette : on les rattache au nœud le plus proche de leur
  // famille, jamais en bloc orphelin.
  const connected = new Set(edges.flatMap((e) => [e.from, e.to]))
  const skel = SKELETONS[domainId] ?? []
  for (const n of nodes) {
    if (connected.has(n.id)) continue
    // On relie l'élément isolé à son VOISIN DE CHAÎNE, et le SENS suit l'ordre
    // physique du squelette : un capteur de roue est en aval de la roue qu'il
    // mesure, pas l'inverse. L'ancien code produisait « Capteurs de vitesse de
    // roue — entraîne → Moteur » : une relation fausse, fabriquée pour combler
    // un trou du graphe.
    const idx = skel.indexOf(n.role)
    let anchor = null
    for (let i = idx - 1; i >= 0 && !anchor; i--) anchor = byRole.get(skel[i]) ?? null
    if (!anchor) for (let i = idx + 1; i < skel.length && !anchor; i++) anchor = byRole.get(skel[i]) ?? null
    if (!anchor) anchor = byRole.get('fluid') ?? byRole.get('heatSource') ?? nodes.find((x) => x.id !== n.id)
    if (!anchor) continue
    const anchorIdx = skel.indexOf(anchor.role)
    const isSensor = n.role === 'sensor' || n.role === 'mesure'
    const flow = isSensor ? 'information' : 'mechanical'
    // Le sens va de l'amont vers l'aval. Un capteur, lui, reçoit de l'organe
    // qu'il observe : l'arc part de l'organe.
    if (isSensor) {
      // Un calculateur ne mesure pas : il reçoit. Si le voisin est le
      // calculateur, l'arc va du capteur vers lui.
      if (anchor.role === 'control') add(n, anchor, 'information', 'mesure transmise')
      else add(anchor, n, 'information', 'mesure')
    } else if (anchorIdx >= 0 && idx >= 0 && anchorIdx > idx) {
      add(n, anchor, flow, linkLabelFor(n, anchor))
    } else {
      add(anchor, n, flow, linkLabelFor(anchor, n))
    }
  }

  return edges
}

// Libellé d'un arc de rattachement : il doit DÉCRIRE la relation réelle, et
// non plaquer un générique. Un générique (« liaison fonctionnelle ») reliait
// n'importe quoi à n'importe quoi et suffisait à faire accepter un schéma faux.
// Le libellé est déduit du rôle du voisin et du flux ; s'il n'est pas
// défendable, l'arc n'est pas créé et le nœud est écarté.
function linkLabelFor(anchor, node) {
  const a = anchor.role
  const n = node.role
  if (n === 'sensor' || n === 'mesure') return 'mesure'
  if (a === 'control') return 'commande'
  if (a === 'engine' || a === 'gearbox' || a === 'rearMotor') return 'entraîne'
  if (a === 'fluid' || a === 'pump') return 'alimente'
  if (a === 'wheel') return 'agit sur'
  if (a === 'tractionBattery') return 'fournit l\'énergie'
  return 'entraîne'
}

// --- Rendu textuel ---------------------------------------------------------
function titleFor(domainId, question, nodes) {
  const subject = {
    cooling: 'Refroidissement moteur',
    lubrication: 'Circuit de lubrification',
    traction: 'Contrôle de traction',
    steering: 'Direction assistée électrique',
    braking: 'Système de freinage',
    air: 'Admission d\'air et suralimentation',
    fuel: 'Alimentation en carburant',
    ignition: 'Circuit d\'allumage',
    exhaust: 'Ligne d\'échappement',
    ev: 'Chaîne de traction électrique',
    hybrid: 'Propulsion hybride',
  }[domainId] ?? 'Mécanisme'

  // Le modèle cité reste dans le titre : c'est la preuve visible que la réponse
  // traite la question posée et pas une autre.
  // Le nom complet est repris tel que l'utilisateur l'écrit : « Mercedes-AMG
  // C 63 S E PERFORMANCE » désigne un modèle précis, « Mercedes » n'en désigne
  // aucun. On s'arrête au premier mot qui n'appartient plus à l'appellation.
  const model = question.match(
    /\b(?:BMW|Mercedes|Audi|Porsche|Renault|Peugeot|Citro[ëe]n|Volkswagen|Toyota|Ford|Ferrari|Lamborghini|Tesla)(?:[- ][A-Z0-9][A-Z0-9+-]*){0,6}/
  )
  const roles = new Set(nodes.map((n) => n.role))
  const feedback = (roles.has('sensor') || roles.has('mesure')) && roles.has('control')
  // Chaque domaine a une formulation qui décrit son mécanisme, pas un gabarit
  // unique « chaîne fonctionnelle ».
  const phrase = {
    cooling: feedback ? 'circulation, échange thermique et régulation' : 'circulation et échange thermique',
    lubrication: 'circulation, filtration et lubrification',
    traction: 'détection du patinage, réduction du couple et freinage sélectif',
    steering: 'chaîne mécanique et boucle d\'assistance',
    braking: 'de la pédale à la roue',
    air: 'admission, compression et refroidissement de l\'air',
    fuel: 'du réservoir à la chambre de combustion',
    ignition: 'de la batterie à l\'étincelle',
    exhaust: 'évacuation et traitement des gaz',
    ev: 'de la batterie aux roues',
    // Titre COURT À DESSEIN : la distinction des deux chaînes est portée par
    // les bandeaux du schéma et la légende, pas par une phrase de 130 signes
    // qui finissait tronquée dans le validateur.
    hybrid: 'deux chaînes d\'énergie vers les roues',
  }[domainId]
  const what = phrase ?? (feedback ? 'boucle de régulation' : 'chaîne fonctionnelle')
  return `${subject}${model ? ` — ${model[0].trim()}` : ''} : ${what}`
}

function notesFor(domainId, hasFeedback, nodes) {
  const base = {
    cooling: [
      'La chaleur ne disparaît pas : elle passe du moteur au liquide, puis du liquide à l\'air.',
      'Le thermostat ne refroidit pas : il décide à partir de quelle température le liquide passe par le radiateur.',
    ],
    lubrication: [
      'L\'huile ne lubrifie pas seulement : elle évacue une part de la chaleur et transporte les impuretés jusqu\'au filtre.',
      'Un film d\'huile insuffisant détruit les coussinets en quelques secondes, bien avant toute surchauffe visible.',
    ],
    traction: [
      'Le patinage se mesure par un écart de vitesse entre roues motrices : aucun capteur de sol n\'est nécessaire.',
      'Deux leviers complémentaires : réduire le couple moteur (action progressive) et freiner la roue qui patine (action rapide et localisée).',
    ],
    steering: [
      'L\'assistance n\'impose pas la trajectoire : elle ajoute un couple à celui du conducteur.',
      'Le capteur de couple dose l\'effort, le capteur d\'angle indique où vont les roues : deux informations différentes.',
    ],
    braking: [
      'La pression est le fluide porteur : elle naît au maître-cylindre et ne devient un effort qu\'au piston d\'étrier.',
    ],
    air: ['L\'air comprimé s\'échauffe en se comprimant : le refroidir le rend plus dense, donc plus riche en oxygène.'],
    fuel: ['La pression d\'injection conditionne la finesse du brouillard de carburant, donc la qualité de la combustion.'],
    ignition: ['L\'avance à l\'allumage déplace l\'instant de l\'étincelle : trop tard, la combustion se termine dans l\'échappement.'],
    exhaust: ['Le catalyseur n\'élimine pas les gaz : il les transforme, à condition d\'atteindre sa température de fonctionnement.'],
    ev: ['Le rendement élevé vient de l\'absence de combustion : très peu d\'énergie part en chaleur.'],
    hybrid: [
      'Les deux sources ne sont pas en série : le chemin thermique passe par la boîte, le chemin électrique attaque directement l\'essieu arrière. Ils ne se rejoignent qu\'à la transmission intégrale.',
      'La batterie haute tension ne sert pas qu\'à démarrer le moteur thermique : elle alimente le moteur arrière et se recharge au freinage par récupération.',
    ],
  }[domainId] ?? []

  if (hasFeedback) {
    base.push(
      'Boucle fermée : une mesure alimente le calculateur, qui commande un actionneur — la mesure suivante valide l\'effet obtenu.'
    )
  }
  if (nodes.some((n) => n.added)) {
    base.push('Les éléments marqués « ajouté » complètent la physique du système : ils ne figuraient pas dans votre question.')
  }
  return base
}

// --- API pour les tests et l'audit ---------------------------------------
export function reasonNodes(question) {
  const r = reason(question)
  return r.supported ? r.nodes.map((n) => n.label) : []
}
