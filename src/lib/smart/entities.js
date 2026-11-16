// Extraction des entités explicitement demandées par l'utilisateur.
//
// Cause du bug corrigé ici : le planificateur choisissait la PREMIÈRE règle qui
// correspondait à la question. La règle « moteur » (5 organes internes) gagnait
// sur toute question contenant le mot « moteur », même quand la question
// demandait explicitement six éléments d'un système plus large.
//
// Désormais : on lit d'abord la liste demandée, puis on choisit le visuel qui
// couvre le mieux cette liste. Une entité demandée n'est jamais silencieusement
// ignorée : si elle n'est pas modélisée, elle est tout de même représentée.

// --- Vocabulaire : identifiant canonique → libellé + variantes reconnues ----
export const ENTITIES = {
  // Système voiture électrique
  battery: { label: 'Batterie', aliases: ['batterie', 'batterie haute tension', 'pack batterie', 'accumulateur'], role: 'source', domain: 'ev' },
  charger: { label: 'Chargeur embarqué', aliases: ['chargeur', 'chargeur embarqué', 'prise de recharge', 'bornes de recharge'], role: 'source', domain: 'ev' },
  bms: { label: 'Gestionnaire batterie (BMS)', aliases: ['bms', 'gestionnaire de batterie', 'gestion batterie'], role: 'control', domain: 'ev' },
  inverter: {
    label: 'Onduleur',
    // 'convertisseur' retiré : il attrapait « convertisseur de couple » et
    // faisait apparaître un onduleur dans une boîte automatique.
    aliases: ['onduleur', 'onduleur de traction', 'inverter'],
    role: 'process',
    domain: 'ev',
    exclude: /convertisseur de couple/,
  },
  motor: {
    label: 'Moteur électrique',
    aliases: ['moteur électrique', 'moteur', 'moteur de traction', 'machine électrique'],
    role: 'process',
    domain: 'ev',
    // Faux positif corrigé : « moteur à combustion interne » n'est pas un
    // moteur électrique. La garde s'applique avant toute correspondance.
    exclude: /moteur\s+(?:a|à)\s+combustion|moteur\s+thermique|moteur\s+diesel|moteur\s+essence|moteur\s+v\s?\d|\bv\s?\d\s+cylindres|cylindres en v/,
  },
  transmission: {
    label: 'Transmission',
    aliases: ['transmission', 'réducteur', 'transmission mécanique'],
    role: 'mechanical',
    domain: 'ev',
    // « boîte de vitesses » et « différentiel » ne sont plus des alias du
    // réducteur électrique : ils désignent des organes traités à part.
    exclude: /bo[îi]te (?:automatique|de vitesses|de transfert)|diff[ée]rentiel|convertisseur de couple|train [ée]picyclo[ïi]dal/,
  },
  wheels: { label: 'Roues', aliases: ['roues', 'roue', 'roues motrices'], role: 'mechanical', domain: 'ev' },
  regen: { label: 'Freinage régénératif', aliases: ['freinage régénératif', 'freinage regeneratif', 'récupération d\'énergie', 'freinage par récupération', 'regen'], role: 'mechanism', domain: 'ev' },
  // « plaquettes » retiré de cette entité de la chaîne électrique : c'est une
  // pièce du freinage, traitée par `brakePad`. Le doublon faisait compter deux
  // fois la même pièce dans la couverture.
  brakes: { label: 'Freins mécaniques', aliases: ['freins mécaniques'], role: 'mechanical', domain: 'ev' },
  pedal: { label: 'Pédale d\'accélérateur', aliases: ['pédale', 'accélérateur', 'pédale d\'accélérateur'], role: 'control', domain: 'ev' },
  // Système moteur (sous-parties)
  stator: { label: 'Stator', aliases: ['stator'], role: 'process', domain: 'motor' },
  rotor: { label: 'Rotor', aliases: ['rotor'], role: 'mechanical', domain: 'motor' },
  controller: { label: 'Contrôleur', aliases: ['contrôleur', 'controleur'], role: 'control', domain: 'motor' },
  // ---------------------------------------------------------------------
  // Transmission intégrale (xDrive et équivalents)
  // ---------------------------------------------------------------------
  awd: { label: 'Transmission intégrale', aliases: ['transmission intégrale', 'transmission integrale', 'xdrive', 'quattro', '4matic', '4x4', 'awd', 'intégrale'], role: 'mechanism', domain: 'awd' },
  transferCase: { label: 'Boîte de transfert', aliases: ['boîte de transfert', 'boite de transfert', 'transfer case', 'répartiteur de couple', 'repartiteur de couple'], role: 'process', domain: 'awd' },
  frontDiff: { label: 'Différentiel avant', aliases: ['différentiel avant', 'differentiel avant', 'pont avant'], role: 'process', domain: 'awd' },
  rearDiff: { label: 'Différentiel arrière', aliases: ['différentiel arrière', 'differentiel arriere', 'pont arrière'], role: 'process', domain: 'awd' },
  differential: { label: 'Différentiels', aliases: ['différentiels', 'différentiel', 'differentiel'], role: 'process', domain: 'awd' },
  torqueSplit: { label: 'Répartition du couple', aliases: ['répartition du couple', 'repartition du couple', 'couple entre les quatre roues', 'répartition du couple entre les quatre roues'], role: 'control', domain: 'awd' },
  clutchPack: { label: 'Embrayage multidisque', aliases: ['embrayage multidisque', 'embrayage multidisques', 'embrayage à lamelles'], role: 'control', domain: 'awd' },
  // ---------------------------------------------------------------------
  // Architecture moteur (V8 et autres dispositions)
  // ---------------------------------------------------------------------
  v8: { label: 'Moteur V8', aliases: ['v8', 'moteur v8', 'huit cylindres', 'v 8'], role: 'source', domain: 'engine' },
  bank: { label: 'Deux bancs de cylindres', aliases: ['banc de cylindres', 'bancs de cylindres', 'disposition des cylindres', 'cylindres en v', 'deux bancs'], role: 'process', domain: 'engine' },
  cylinders: { label: 'Cylindres', aliases: ['cylindres', 'huit cylindres', 'cylindre'], role: 'process', domain: 'engine' },
  camshaft: { label: 'Arbres à cames', aliases: ['arbre à cames', 'arbres à cames', 'arbre a cames', 'arbres a cames', 'aac'], role: 'control', domain: 'engine' },
  valves: { label: 'Soupapes', aliases: ['soupapes', 'soupape'], role: 'mechanism', domain: 'engine' },
  firingOrder: { label: "Ordre d'allumage", aliases: ["ordre d'allumage", "ordre d allumage", 'ordre de fonctionnement', "ordre d'explosion"], role: 'phase', domain: 'engine' },
  // ---------------------------------------------------------------------
  // Boîte de vitesses automatique
  // ---------------------------------------------------------------------
  autoGearbox: { label: 'Boîte automatique', aliases: ['boîte automatique', 'boite automatique', 'boîte auto', 'bva', 'transmission automatique', 'boîte de vitesses automatique'], role: 'process', domain: 'gearbox' },
  torqueConverter: { label: 'Convertisseur de couple', aliases: ['convertisseur de couple', 'convertisseur hydraulique', 'turbine de convertisseur'], role: 'process', domain: 'gearbox' },
  planetary: { label: 'Trains épicycloïdaux', aliases: ['train épicycloïdal', 'trains épicycloïdaux', 'train epicycloidal', 'trains epicycloidaux', 'épicycloïdal', 'planétaire', 'planetaires'], role: 'process', domain: 'gearbox' },
  gearboxClutch: { label: 'Embrayages multidisques', aliases: ['embrayages', 'embrayage', 'embrayages multidisques', 'freins de train'], role: 'control', domain: 'gearbox' },
  gearRatio: { label: 'Rapports de transmission', aliases: ['rapports', 'rapport de transmission', 'rapports de transmission', 'démultiplication', 'demultiplication'], role: 'control', domain: 'gearbox' },
  valveBody: { label: 'Distributeur hydraulique', aliases: ['distributeur hydraulique', 'valve body', 'bloc hydraulique', 'mécatronique', 'mecatronique'], role: 'control', domain: 'gearbox' },
  outputShaft: { label: 'Arbre de sortie', aliases: ['arbre de sortie', 'arbre secondaire'], role: 'mechanical', domain: 'gearbox' },
  // ---------------------------------------------------------------------
  // Freinage hydraulique et ABS
  // ---------------------------------------------------------------------
  brakePedal: { label: 'Pédale de frein', aliases: ['pédale de frein', 'pedale de frein', 'pédale', 'course de pédale'], role: 'control', domain: 'brake' },
  masterCylinder: { label: 'Maître-cylindre', aliases: ['maître-cylindre', 'maitre-cylindre', 'maître cylindre', 'maitre cylindre'], role: 'source', domain: 'brake' },
  brakeCircuit: { label: 'Circuit hydraulique', aliases: ['circuit hydraulique', 'circuit de freinage', 'liquide de frein', 'durites de frein', 'canalisations'], role: 'process', domain: 'brake' },
  brakeCaliper: { label: 'Étriers', aliases: ['étrier', 'étriers', 'etrier', 'etriers'], role: 'process', domain: 'brake' },
  brakeDisc: { label: 'Disques', aliases: ['disque', 'disques', 'disque de frein', 'disques de frein'], role: 'mechanical', domain: 'brake' },
  brakePad: { label: 'Plaquettes', aliases: ['plaquette', 'plaquettes', 'plaquettes de frein'], role: 'mechanical', domain: 'brake' },
  abs: { label: 'ABS', aliases: ['abs', 'antiblocage', 'anti-blocage', 'système abs', 'freinage abs'], role: 'control', domain: 'brake' },
  absPump: { label: "Unité hydraulique ABS", aliases: ['unité hydraulique', 'unite hydraulique', 'groupe hydraulique', 'pompe abs', 'pompe de freinage'], role: 'process', domain: 'brake' },
  absValve: { label: 'Électrovannes', aliases: ['électrovanne', 'électrovannes', 'electrovanne', 'electrovannes', 'vanne de régulation'], role: 'control', domain: 'brake' },
  absModule: { label: 'Calculateur ABS', aliases: ["calculateur abs", 'calculateur de freinage', 'calculateur esp', 'module abs'], role: 'control', domain: 'brake' },
  wheelSensor: { label: 'Capteurs de vitesse de roue', aliases: ['capteur de roue', 'capteurs de roue', 'capteur de vitesse de roue', 'capteurs de vitesse de roue', 'capteur abs'], role: 'control', domain: 'brake' },
  // ---------------------------------------------------------------------
  // Suspension adaptative
  // ---------------------------------------------------------------------
  suspension: { label: 'Suspension', aliases: ['suspension', 'suspension adaptative', 'suspension pilotée', 'amortissement piloté'], role: 'mechanism', domain: 'suspension' },
  damper: { label: 'Amortisseurs pilotés', aliases: ['amortisseur', 'amortisseurs', 'amortisseurs pilotés', 'amortisseur piloté', 'amortisseurs adaptatifs'], role: 'process', domain: 'suspension' },
  spring: { label: 'Ressorts', aliases: ['ressort', 'ressorts', 'ressort hélicoïdal', 'ressort pneumatique'], role: 'mechanical', domain: 'suspension' },
  damperValve: { label: 'Électrovannes d\'amortisseur', aliases: ['électrovannes d\'amortisseur', 'vanne d\'amortisseur', 'clapet piloté', 'électrovanne pilotée'], role: 'control', domain: 'suspension' },
  suspensionEcu: { label: 'Calculateur de châssis', aliases: ['calculateur de châssis', 'calculateur de suspension', 'centrale de suspension', 'calculateur de train roulant'], role: 'control', domain: 'suspension' },
  accelerometer: { label: 'Capteurs d\'accélération', aliases: ['capteur d\'accélération', 'capteurs d\'accélération', 'accéléromètre', 'accéléromètres', 'capteur trois axes'], role: 'control', domain: 'suspension' },
  rideHeightSensor: { label: 'Capteurs de hauteur de caisse', aliases: ['capteur de hauteur', 'capteurs de hauteur', 'capteur de débattement', 'capteur de niveau'], role: 'control', domain: 'suspension' },
  // Trajet d'une requête sur Internet (domaine « net »). Ces entités manquaient
  // totalement : la question Internet donnait `asked = 0`, donc un score nul,
  // donc un départage par ordre de règle au lieu d'une couverture mesurée.
  device: { label: 'Mon appareil', aliases: ['mon appareil', 'appareil', 'ordinateur', 'téléphone', 'telephone', 'smartphone', 'pc'], role: 'source', domain: 'net' },
  wifiRouter: { label: 'Routeur Wi-Fi', aliases: ['routeur wi-fi', 'routeur wifi', 'box internet', 'box', 'routeur', 'modem', 'livebox'], role: 'process', domain: 'net' },
  isp: { label: "Fournisseur d'accès", aliases: ["fournisseur d'accès", "fournisseur d'acces", 'fai', 'opérateur', 'operateur', 'fibre optique'], role: 'process', domain: 'net' },
  dns: { label: 'DNS', aliases: ['dns', 'résolution dns', 'resolution dns', 'annuaire', 'nom de domaine'], role: 'mechanism', domain: 'net' },
  server: { label: 'Serveurs', aliases: ['serveurs', 'serveur', 'serveur web', 'datacenter', 'hébergeur', 'hebergeur'], role: 'process', domain: 'net' },
  https: { label: 'Protocole HTTPS', aliases: ['https', 'protocole https', 'tls', 'ssl', 'chiffrement', 'certificat'], role: 'mechanism', domain: 'net' },
  response: { label: 'Retour des données', aliases: ['retour des données', 'retour des donnees', 'retour', 'réponse', 'reponse', 'sens inverse'], role: 'phase', domain: 'net' },
  // Moteur à combustion interne (quatre temps) : pièces mécaniques
  piston: { label: 'Piston', aliases: ['piston', 'pistons'], role: 'mechanical', domain: 'ice' },
  intakeValve: { label: "Soupape d'admission", aliases: ["soupape d'admission", 'soupapes d\'admission', "soupape d admission", 'soupape admission', 'admission'], role: 'mechanism', domain: 'ice' },
  exhaustValve: { label: "Soupape d'échappement", aliases: ["soupape d'échappement", 'soupapes d\'échappement', 'soupape echappement', "d'échappement", "d'echappement"], role: 'mechanism', domain: 'ice' },
  sparkPlug: { label: 'Bougie', aliases: ['bougie', 'bougies', 'bougie d\'allumage', 'allumage'], role: 'control', domain: 'ice' },
  crankshaft: { label: 'Vilebrequin', aliases: ['vilebrequin'], role: 'mechanical', domain: 'ice' },
  connectingRod: { label: 'Bielle', aliases: ['bielle', 'bielles'], role: 'mechanical', domain: 'ice' },
  cylinder: { label: 'Cylindre', aliases: ['cylindre', 'chambre de combustion'], role: 'process', domain: 'ice' },
  // Moteur à combustion interne : les quatre temps (étapes du cycle, reconnues
  // comme des étapes demandées et non comme des pièces).
  phaseIntake: { label: 'Admission', aliases: ['admission', 'temps d\'admission', 'phase d\'admission'], role: 'phase', domain: 'ice' },
  phaseCompression: { label: 'Compression', aliases: ['compression', 'temps de compression', 'phase de compression'], role: 'phase', domain: 'ice' },
  phaseCombustion: { label: 'Combustion et détente', aliases: ['combustion et détente', 'combustion et detente', 'combustion', 'détente', 'detente', 'explosion'], role: 'phase', domain: 'ice' },
  phaseExhaust: { label: 'Échappement', aliases: ['échappement', 'echappement', 'temps d\'échappement', 'phase d\'échappement'], role: 'phase', domain: 'ice' },
  // Divers systèmes
  sun: { label: 'Le Soleil', aliases: ['soleil'], role: 'source' },
  planet: { label: 'Planètes', aliases: ['planètes', 'planète', 'planetes'], role: 'process' },
  nucleus: { label: 'Noyau', aliases: ['noyau'], role: 'control' },
  mito: { label: 'Mitochondries', aliases: ['mitochondries', 'mitochondrie'], role: 'process' },
  membrane: { label: 'Membrane plasmique', aliases: ['membrane', 'membrane plasmique'], role: 'mechanical' },
}

// Tri des alias du plus long au plus court : « moteur électrique » doit gagner
// sur « moteur ».
const ALIAS_INDEX = Object.entries(ENTITIES)
  .flatMap(([id, def]) => (def.aliases ?? []).map((alias) => ({ id, alias: alias.toLowerCase() })))
  .sort((a, b) => b.alias.length - a.alias.length)

const LEADING_NOISE = /^(?:en\s+)?(?:comprenant|incluant|avec|dont|notamment|entre\s+autres|y\s+compris|et|puis|ou|ainsi\s+que|d\'?abord|pour\s+finir)\s+/i
const TRAILING_NOISE = /[\s,;:.!?]+$/

function normalize(value) {
  return String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['’]/g, '\'')
    .trim()
}

function stripNoise(fragment) {
  let out = fragment.trim()
  let guard = 0
  while (LEADING_NOISE.test(out) && guard++ < 4) out = out.replace(LEADING_NOISE, '')
  return out.replace(TRAILING_NOISE, '').trim()
}

// Retourne les entités mentionnées, dans l'ordre où elles apparaissent.
// `declared` indique si l'utilisateur les a listées (après « comprenant », etc.).
export function extractEntities(question) {
  const text = String(question ?? '')
  if (!text.trim()) return []

  // 1. On isole les fragments d'une éventuelle énumération.
  const segments = text
    .split(/[,;()]|\bet\b|\bainsi que\b|\bcomprenant\b|\bincluant\b/gi)
    .map(stripNoise)
    .filter(Boolean)

  const found = []
  const seen = new Set()
  const wholeRef = normalize(text)
  const declaredList = /(?:comprenant|incluant|avec|dont|y compris|notamment)/i.test(text)

  for (const segment of segments) {
    const haystack = normalize(segment)
    for (const { id, alias } of ALIAS_INDEX) {
      if (seen.has(id)) continue
      if (ENTITIES[id].exclude?.test(wholeRef)) continue
      // Correspondance sur mot entier pour éviter « roue » dans « roulement ».
      const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
      if (pattern.test(haystack)) {
        seen.add(id)
        found.push({ id, label: ENTITIES[id].label, role: ENTITIES[id].role, domain: ENTITIES[id].domain, declared: declaredList })
        break
      }
    }
  }

  // 2. Rattrapage sur le texte entier. La première passe découpe la question et
  //    ne retient qu'une entité par segment : « le piston, les soupapes
  //    d'admission et d'échappement » ne donnait que le piston, « les quatre
  //    phases : 1. Admission 2. Compression » ne donnait que la compression.
  //    On complète donc sans jamais écraser l'ordre déjà trouvé.
  //    Les rôles « phase » en sont exclus : « admission » y est un temps du
  //    cycle, pas une pièce, et ne doit pas être déduit du mot « admission »
  //    employé dans « soupape d'admission ».
  const whole = normalize(text)
  for (const { id, alias } of ALIAS_INDEX) {
    if (seen.has(id) || ENTITIES[id].role === 'phase') continue
    if (ENTITIES[id].exclude?.test(whole)) continue
    const pattern = new RegExp(`(^|[^a-z0-9])${alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`)
    if (pattern.test(whole)) {
      seen.add(id)
      found.push({ id, label: ENTITIES[id].label, role: ENTITIES[id].role, domain: ENTITIES[id].domain, declared: declaredList })
    }
  }
  return found
}

// Entités de type « étape » (phases d'un cycle) demandées explicitement.
// Elles ne servent pas à choisir un visuel de pièces, mais à vérifier qu'aucune
// phase demandée n'est omise.
export function extractPhases(question) {
  return extractEntities(question).filter((e) => e.role === 'phase')
}

// Nombre d'entités demandées ET couvertes par un visuel donné.
export function coverage(question, visual) {
  // Les entités du catalogue historique ne décrivent pas les sujets construits
  // par le raisonneur (freinage sélectif, refroidissement…). Ce dernier fournit
  // sa propre lecture : on l'utilise, sinon la couverture serait nulle par
  // construction et le visuel rejeté à tort.
  if (visual?.reasonedCoverage) return visual.reasonedCoverage
  const asked = extractEntities(question)
  if (!asked.length || !visual) return { asked: asked.length, covered: 0, ratio: 0 }
  // Un visuel peut exposer ses entités à plusieurs endroits selon son type :
  // nœuds (system / concept), items (layers), phases et pièces (cycle).
  const labels = new Set([
    ...(visual.nodes ?? []).map((n) => normalize(n.label)),
    ...(visual.items ?? []).map((n) => normalize(n.label)),
    ...(visual.parts?.nodes ?? []).map((n) => normalize(n.label)),
    ...(visual.phases ?? []).map((p) => normalize(p.name)),
    // Un « journey » expose ses éléments à la fois comme étapes et comme
    // composants : la couverture doit lire les deux, sinon elle vaut 0 et le
    // score retombe sur l'ordre de la liste de règles.
    ...(visual.steps ?? []).map((st) => normalize(st.label)),
    ...(visual.components ?? []).map((c) => normalize(c.label)),
    // Les notes font partie du visuel affiché : un élément expliqué dans une
    // note est représenté, et ne doit pas compter comme manquant.
    ...(visual.notes ?? []).map((n) => normalize(n)),
    normalize(visual.title ?? ''),
  ])
  // Correspondance par mots significatifs et non par libellé exact.
  // Pourquoi : les entités demandées sont nommées au pluriel ou autrement que
  // dans le visuel (« Répartition du couple » vs « répartition du couple entre
  // les quatre roues », « Différentiels » vs « Différentiel avant »). La
  // comparaison stricte annonçait une couverture de 2/4 alors que les sept
  // éléments utiles étaient bien affichés.
  const STOP = new Set(['des', 'les', 'une', 'aux', 'pour', 'mon', 'mes', 'entre', 'vers', 'dans', 'avec'])
  const words = (text) =>
    normalize(text)
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3 && !STOP.has(w))

  const labelWords = [...labels].flatMap((label) => words(label))
  let covered = 0
  for (const entity of asked) {
    const target = normalize(entity.label)
    const exact = [...labels].some((label) => label.includes(target) || target.includes(label))
    if (exact) {
      covered++
      continue
    }
    const tokens = words(entity.label)
    if (tokens.length && tokens.some((t) => labelWords.includes(t))) covered++
  }
  return { asked: asked.length, covered, ratio: asked.length ? covered / asked.length : 0 }
}
