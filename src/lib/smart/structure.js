// Analyse STRUCTURELLE de la demande.
//
// Constat qui a motivé ce module : le planificateur ne déduisait jamais le type
// de visualisation. Il choisissait parmi des règles dont le `type` était écrit
// en dur, et la seule correspondance était un mot-clé (`/internet/` → gabarit
// « flow »). Résultat : deux sujets très différents recevaient la même structure.
//
// Ici, on lit la forme de la demande, indépendamment du domaine :
//   • un trajet aller-retour entre deux points  → journey
//   • une chronologie de faits datés            → timeline
//   • des proportions qui s'additionnent        → pie / chart
//   • une demande de comparaison                → comparison
//   • des étapes énumérées / un processus       → steps
//   • des sous-parties d'un tout                → diagram
//   • un mécanisme interne dont on décrit les organes → concept
//
// Aucun de ces signaux n'est un simple mot-clé de sujet : ce sont des marqueurs
// de STRUCTURE (allers-retours, énumérations, verbes de parcours, dates,
// pourcentages, « versus »…). Le catalogue de règles reste en repli quand aucun
// signal structurel n'est détecté.

const SIGNALS = [
  {
    // Aller-retour explicite : le sujet se déroule dans les deux sens.
    type: 'journey',
    min: 2,
    tests: [
      // « depuis X jusqu'à Y » : un trajet orienté.
      { re: /\b(?:depuis|de)\b[^.!?]{0,80}\b(?:jusqu'|jusque|vers|au serveur|à l'|a l')\b/i, weight: 2, label: 'trajet orienté depuis… jusqu\'à' },
      // Retour explicite du résultat vers l'émetteur.
      { re: /\bretour\b|\bretourn\w*|\brenvoi\w*|\br[ée]ponse\w*\b[^.!?]{0,60}\b(?:vers|à|a)\b|\bsens inverse\b/i, weight: 2, label: 'retour de la réponse' },
      // Requête / réponse.
      { re: /\brequ[êe]te\w*\b|\baller[- ]retour\b|\bbidirectionnel\w*/i, weight: 1.5, label: 'requête' },
      // Vocabulaire de parcours réseau.
      { re: /\bparcours\b|\btrajet\b|\bchemin\w*\b|\btransit\w*|\bachemin\w*/i, weight: 1, label: 'parcours' },
      // Point de départ personnel + destination distante.
      { re: /\bmon appareil\b|\bma box\b|\bmon ordinateur\b|\bmon t[ée]l[ée]phone\b/i, weight: 1, label: 'point de départ personnel' },
    ],
  },
  {
    type: 'timeline',
    min: 2.5,
    tests: [
      { re: /\b(?:en\s+)?(?:1[0-9]{3}|20[0-9]{2})\b/g, weight: 1.5, label: 'dates' },
      { re: /\bchronolog\w*|\bhistoire de\b|\b[ée]volution de\b|\bapr[èe]s la Premi[èe]re Guerre\b/i, weight: 2, label: 'chronologie' },
    ],
  },
  {
    type: 'comparison',
    min: 2,
    tests: [
      { re: /\bcompar\w*|\bversus\b|\bvs\.?\b|\bdiff[ée]rence\w*\b|\bavantages?\b|\binconv[ée]nients?\b|\bmieux que\b|\bface [àa]\b/i, weight: 2, label: 'comparaison explicite' },
      { re: /\bou\b[^.!?]{0,40}\bou\b/i, weight: 0.5, label: 'alternative' },
    ],
  },
  {
    type: 'pie',
    min: 2,
    tests: [
      { re: /\br[ée]parti\w*|\bproportion\w*|\bpourcentage\w*|\bpart de\b|\bse compose de\b/i, weight: 1.5, label: 'répartition' },
      { re: /\d+\s?%/g, weight: 1.5, label: 'pourcentages' },
    ],
  },
  {
    type: 'steps',
    min: 2,
    tests: [
      { re: /\b[ée]tapes?\b|\bproc[ée]dure\b|\bprocessus\b|\bm[ée]thode\b|\bcomment (?:faire|proc[ée]der)\b|\bguide\b|\btutoriel\b/i, weight: 1.5, label: 'étapes / procédure' },
      { re: /(?:^|\s)\d+[.)]\s+\S/g, weight: 1.5, label: 'énumération numérotée' },
      { re: /\bpuis\b|\bensuite\b|\benfin\b|\bd'?abord\b/i, weight: 0.5, label: 'enchaînement' },
    ],
  },
  {
    type: 'diagram',
    min: 2,
    tests: [
      { re: /\bcompos[ée]\w* de\b|\bse compose\b|\bconstitu[ée]\w* de\b|\bsous[- ]parties?\b|\borganigramme\b|\bhi[ée]rarchie\b|\bstructure de\b/i, weight: 2, label: 'décomposition en parties' },
    ],
  },
  {
    type: 'concept',
    min: 2.5,
    tests: [
      { re: /\borganes?\b|\borganites?\b|\bpi[èe]ces?\b|\b[ée]l[ée]ments? (?:d'un|de l')\b|\banatomie\b|\bcomposants? (?:d'un|de l')\b/i, weight: 1.5, label: 'organes / pièces' },
      { re: /\br[ôo]le\b|\bfonction de chaque\b|\bchaque (?:pi[èe]ce|organne|organite|[ée]l[ée]ment)\b/i, weight: 1, label: 'rôle de chaque partie' },
    ],
  },
]

// Normalise pour compter sans se soucier de la casse ou des accents.
function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
}

// Analyse la structure de la demande et retourne les types pressentis, du plus
// probable au moins probable, avec le détail des signaux qui ont voté.
export function analyzeStructure(question) {
  const text = String(question ?? '')
  const flat = normalize(text)
  const votes = []

  for (const signal of SIGNALS) {
    let score = 0
    const hits = []
    for (const test of signal.tests) {
      // Les expressions avec /g comptent leurs occurrences ; les autres, 1.
      const global = test.re.global
      test.re.lastIndex = 0
      const matches = text.match(test.re)
      const count = matches ? (global ? matches.length : 1) : 0
      if (count > 0) {
        score += test.weight * Math.min(count, 3)
        hits.push(`${test.label}${count > 1 ? ` ×${count}` : ''}`)
      }
    }
    if (score >= signal.min) {
      votes.push({ type: signal.type, score: Number(score.toFixed(1)), hits })
    }
  }

  votes.sort((a, b) => b.score - a.score)
  return {
    best: votes[0]?.type ?? null,
    votes,
    hasSignal: votes.length > 0,
    normalizedLength: flat.length,
  }
}
