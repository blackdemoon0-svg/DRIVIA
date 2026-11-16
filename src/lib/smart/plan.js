// Planificateur visuel : décide quels visuels AJOUTER à une réponse textuelle
// qui n'en contient pas encore. Le contenu des visuels est une structuration
// des notions attendues pour le sujet — jamais une invention de chiffres.
// Le texte du modèle reste la source de vérité pédagogique.

import { extractEntities, coverage } from './entities'
import { analyzeStructure } from './structure'
import { reason } from './reasoner'

const has = (q, re) => re.test(q)

// Candidats, du plus spécifique au plus général.
const RULES = [
  {
    id: 'ev-car',
    // Couvre la voiture électrique complète, pas seulement le moteur.
    match: (q) => has(q, /voiture [ée]lectrique|v[ée]hicule [ée]lectrique|v[ée]hicule [ée]lectrique|[ée]lectrique.*(batterie|onduleur|transmission)|(batterie|onduleur|freinage r[ée]g[ée]n[ée]ratif)/i) &&
      !has(q, /compar|versus|vs\.|thermique/i),
    visual: {
      type: 'system',
      title: 'Chaîne de traction d\'une voiture électrique',
      nodes: [
        { id: 'battery', label: 'Batterie', detail: 'Réserve d\'énergie chimique sous forme de courant continu (200 à 800 V selon le modèle). Sa capacité, en kWh, détermine l\'autonomie.', tier: 'source' },
        { id: 'bms', label: 'Gestion batterie', detail: 'Surveille tension et température de chaque cellule, équilibre les charges et protège le pack en coupant le courant si nécessaire.', tier: 'control' },
        { id: 'inverter', label: 'Onduleur', detail: 'Convertit le courant continu de la batterie en courant alternatif triphasé, dont il règle la fréquence pour piloter la vitesse du moteur.', tier: 'power' },
        { id: 'motor', label: 'Moteur électrique', detail: 'Convertit l\'énergie électrique en énergie mécanique grâce au champ magnétique tournant du stator qui entraîne le rotor.', tier: 'power' },
        { id: 'transmission', label: 'Transmission', detail: 'Réducteur à rapport fixe (parfois un différentiel) : adapte la vitesse de rotation du moteur à celle des roues et répartit le couple.', tier: 'mechanical' },
        { id: 'wheels', label: 'Roues', detail: 'Transmettent la force au sol : c\'est le seul contact avec la route, donc le point où le couple devient mouvement.', tier: 'mechanical' },
        { id: 'regen', label: 'Freinage régénératif', detail: 'Le moteur fonctionne en générateur : il freine les roues et renvoie l\'énergie cinétique vers la batterie en repassant par l\'onduleur.', tier: 'recovery' },
      ],
      // Chaque lien porte un type de flux : énergie, commande, mécanique, récupération.
      edges: [
        { from: 'battery', to: 'inverter', label: 'courant continu', flow: 'energy' },
        { from: 'bms', to: 'battery', label: 'surveille', flow: 'control' },
        { from: 'bms', to: 'inverter', label: 'autorise', flow: 'control' },
        { from: 'inverter', to: 'motor', label: 'courant alternatif', flow: 'energy' },
        { from: 'motor', to: 'transmission', label: 'couple', flow: 'mechanical' },
        { from: 'transmission', to: 'wheels', label: 'rotation', flow: 'mechanical' },
        { from: 'wheels', to: 'regen', label: 'inertie', flow: 'mechanical' },
        { from: 'regen', to: 'inverter', label: 'énergie récupérée', flow: 'recovery' },
        { from: 'inverter', to: 'battery', label: 'recharge', flow: 'recovery' },
      ],
      notes: [
        'Le flux d\'énergie va de la batterie vers les roues (flèches pleines violettes).',
        'Les signaux de commande pilotent sans transporter d\'énergie (pointillés).',
        'En freinage, le flux s\'inverse : les roues entraînent le moteur, qui recharge la batterie.',
      ],
    },
  },
  {
    id: 'ice-engine',
    // Moteur à combustion interne à quatre temps. La garde exclut le moteur
    // électrique : « moteur » seul ne doit pas déclencher ce cycle.
    // La règle ne doit PAS capturer une question d'ARCHITECTURE (V8, disposition
    // des cylindres, arbres à cames, ordre d'allumage) : celle-ci relève de la
    // règle `v8-engine`. Sans cette exclusion, « moteur V8 » tombait sur le
    // schéma des quatre temps, qui ne montre ni les bancs ni l'ordre d'allumage.
    match: (q) =>
      has(q, /combustion|quatre[- ]temps|4[- ]temps|moteur thermique|cycle (?:de )?beau de rochas|admission.*compression|piston|vilebrequin|bielle|soupape/i) &&
      !has(q, /moteur [ée]lectrique|[ée]lectrique.*batterie/i) &&
      !has(q, /\bv\s?\d\b|disposition des cylindres|arbres? [àa] cames|ordre d'allumage|huit cylindres/i),
    visual: {
      type: 'cycle',
      title: 'Moteur à combustion interne à quatre temps',
      cycleName: 'Cycle de Beau de Rochas (quatre temps)',
      // Les quatre phases : ce que l'utilisateur suit du regard, dans l'ordre.
      phases: [
        {
          number: 1,
          name: 'Admission',
          state: 'admission',
          piston: 'Descend : du PMH vers le PMB',
          valves: 'Admission ouverte, échappement fermée',
          detail: 'Le piston descend et crée une dépression : le mélange air-carburant est aspiré dans le cylindre par la soupape d\'admission.',
          media: 'Air + carburant',
        },
        {
          number: 2,
          name: 'Compression',
          state: 'compression',
          piston: 'Monte : du PMB vers le PMH',
          valves: 'Les deux soupapes fermées',
          detail: 'Les soupapes se ferment et le piston remonte : le mélange est comprimé jusqu\'à environ 1/10 de son volume initial (rapport volumétrique 10:1).',
          media: 'Mélange comprimé',
        },
        {
          number: 3,
          name: 'Combustion et détente',
          state: 'detente',
          piston: 'Redescend : du PMH vers le PMB',
          valves: 'Les deux soupapes fermées',
          detail: 'La bougie enflamme le mélange juste avant le PMH. La pression des gaz brûlants repousse le piston : c\'est le seul temps qui fournit du travail.',
          media: 'Gaz brûlants',
        },
        {
          number: 4,
          name: 'Échappement',
          state: 'echappement',
          piston: 'Remonte : du PMB vers le PMH',
          valves: 'Échappement ouverte, admission fermée',
          detail: 'La soupape d\'échappement s\'ouvre et le piston remonte pour chasser les gaz brûlés vers l\'échappement.',
          media: 'Gaz brûlés',
        },
      ],
      // Les pièces et leurs liens : qui entraîne qui, et dans quel sens.
      parts: {
        caption: 'Chaîne cinématique : la pression des gaz pousse le piston, la bielle transforme ce mouvement rectiligne en rotation du vilebrequin.',
        nodes: [
          { id: 'spark', label: 'Bougie', detail: 'Produit l\'étincelle qui enflamme le mélange, quelques degrés avant le point mort haut en fin de compression.', col: 0, row: 0 },
          { id: 'in-valve', label: 'Soupape d\'admission', detail: 'S\'ouvre pendant le 1er temps pour laisser entrer le mélange air-carburant.', col: 1, row: 0 },
          { id: 'ex-valve', label: 'Soupape d\'échappement', detail: 'S\'ouvre pendant le 4e temps pour évacuer les gaz brûlés.', col: 3, row: 0 },
          { id: 'piston', label: 'Piston', detail: 'Pièce mobile du cylindre : il descend en admission, remonte en compression, est repoussé en détente et remonte en échappement.', col: 2, row: 2 },
          { id: 'rod', label: 'Bielle', detail: 'Relie le piston au vilebrequin et transforme le mouvement rectiligne alternatif en rotation.', col: 2, row: 3 },
          { id: 'crank', label: 'Vilebrequin', detail: 'Convertit le mouvement de la bielle en rotation continue, transmise ensuite à la boîte de vitesses.', col: 3, row: 4 },
          { id: 'cylinder', label: 'Cylindre', detail: 'Volume fermé où se déroulent les quatre temps ; sa paroi guide le piston.', col: 2, row: 1 },
        ],
        edges: [
          { from: 'in-valve', to: 'cylinder', label: 'mélange admis', flow: 'gas' },
          { from: 'cylinder', to: 'ex-valve', label: 'gaz évacués', flow: 'gas' },
          { from: 'spark', to: 'cylinder', label: 'étincelle', flow: 'ignition' },
          { from: 'cylinder', to: 'piston', label: 'pression des gaz', flow: 'energy' },
          { from: 'piston', to: 'rod', label: 'poussée axiale', flow: 'mechanical' },
          { from: 'rod', to: 'crank', label: 'couple moteur', flow: 'mechanical' },
          { from: 'crank', to: 'piston', label: 'mouvement de retour', flow: 'mechanical' },
        ],
      },
      notes: [
        'Un cycle complet du piston correspond à exactement deux tours de vilebrequin (720°).',
        'Sur les quatre temps, un seul produit du travail : la combustion-détente. Les trois autres sont des temps « résistants » entraînés par l\'inertie du volant moteur.',
        'La distribution (arbre à cames) ouvre et ferme les soupapes en synchronisation avec la position du piston.',
      ],
    },
  },
  {
    id: 'awd',
    // Transmission intégrale : quatre roues, une boîte de transfert, deux
    // différentiels et une répartition de couple variable. Structure en graphe
    // (qui alimente qui), pas une chronologie : d'où le type `system`.
    match: (q) =>
      has(q, /xdrive|quattro|4matic|transmission int[ée]grale|transmission integrale|\b4x4\b|\bawd\b|bo[îi]te de transfert|diff[ée]rentiel/i) &&
      !has(q, /bo[îi]te (?:automatique|de vitesses)|convertisseur de couple|[ée]picyclo[ïi]dal/i),
    visual: {
      type: 'system',
      title: 'Transmission intégrale : répartition du couple vers les quatre roues',
      nodes: [
        { id: 'engine', label: 'Moteur', detail: 'Fournit le couple à la boîte de vitesses, qui le transmet à l\'arbre de transmission.', tier: 'source' },
        { id: 'gearbox', label: 'Boîte de vitesses', detail: 'Adapte le régime et le couple du moteur avant de les envoyer vers la transmission intégrale.', tier: 'control' },
        { id: 'transfer', label: 'Boîte de transfert', detail: 'Prélève le couple sur l\'arbre principal et le répartit entre les essieux avant et arrière, via un embrayage multidisque piloté.', tier: 'power' },
        { id: 'rearDiff', label: 'Différentiel arrière', detail: 'Répartit le couple entre les deux roues arrière et autorise des vitesses de rotation différentes en virage.', tier: 'power' },
        { id: 'frontDiff', label: 'Différentiel avant', detail: 'Répartit le couple entre les deux roues avant ; le pont avant est entraîné par l\'arbre de transmission.', tier: 'power' },
        { id: 'rearWheels', label: 'Roues arrière', detail: 'Reçoivent la part arrière du couple (majoritaire sur un xDrive à propulsion), modulée roue par roue si un différentiel piloté est présent.', tier: 'mechanical' },
        { id: 'frontWheels', label: 'Roues avant', detail: 'Reçoivent la part avant du couple, transmise par le pont avant.', tier: 'mechanical' },
      ],
      edges: [
        { from: 'engine', to: 'gearbox', label: 'couple moteur', flow: 'mechanical' },
        { from: 'gearbox', to: 'transfer', label: 'couple total', flow: 'mechanical' },
        { from: 'transfer', to: 'rearDiff', label: 'part arrière', flow: 'mechanical' },
        { from: 'transfer', to: 'frontDiff', label: 'part avant', flow: 'mechanical' },
        { from: 'rearDiff', to: 'rearWheels', label: 'couple roue par roue', flow: 'mechanical' },
        { from: 'frontDiff', to: 'frontWheels', label: 'couple roue par roue', flow: 'mechanical' },
        { from: 'transfer', to: 'gearbox', label: 'vitesse réelle des roues', flow: 'control' },
      ],
      notes: [
        'La boîte de transfert ne crée pas de couple : elle répartit celui qui existe entre les deux essieux.',
        'Un différentiel autorise des vitesses différentes entre roues gauche et droite — indispensable en virage, où la roue extérieure parcourt plus de chemin.',
        'Les capteurs de vitesse de roue renseignent le calculateur, qui ajuste l\'embrayage multidisque pour faire varier la part de couple envoyée à l\'avant.',
      ],
    },
  },
  {
    id: 'v8-engine',
    // Moteur V8 : architecture mécanique (bancs, vilebrequin, arbres à cames,
    // ordre d'allumage). Le type `concept` modélise les organes et leurs liens,
    // là où `cycle` ne décrit que les quatre temps d'un cylindre.
    match: (q) => has(q, /\bv\s?8\b|\bv\s?6\b|\bv\s?12\b|moteur v\d|huit cylindres|disposition des cylindres|ordre d'allumage|ordre de fonctionnement|arbres? [àa] cames/i) &&
      !has(q, /quatre temps|4 temps|admission|compression|échappement/i),
    visual: {
      type: 'concept',
      title: 'Moteur V8 : architecture, distribution et ordre d\'allumage',
      nodes: [
        { id: 'v8-bank', label: 'Deux bancs de cylindres', detail: 'Les huit cylindres sont répartis en deux rangées formant un V (souvent 90°). Cette architecture raccourcit le moteur tout en doublant la cylindrée.', tier: 'source' },
        { id: 'v8-crank', label: 'Vilebrequin', detail: 'Arbre à quatre manetons pour un V8 : il convertit la poussée des huit pistons en rotation continue.', tier: 'power' },
        { id: 'v8-pistons', label: 'Pistons et bielles', detail: 'Chaque piston est relié au vilebrequin par une bielle ; les deux rangées attaquent le même arbre, ce qui donne un couple élevé et régulier.', tier: 'mechanical' },
        { id: 'v8-cams', label: 'Arbres à cames', detail: 'Un ou deux arbres par banc (simple ou double arbre en culasse) commandent l\'ouverture des soupapes au rythme du vilebrequin, à mi-régime.', tier: 'control' },
        { id: 'v8-valves', label: 'Soupapes', detail: 'Admission et échappement : deux à quatre par cylindre selon la culasse, actionnées par les arbres à cames.', tier: 'mechanism' },
        { id: 'v8-firing', label: 'Ordre d\'allumage', detail: 'Un V8 croisé allume ses cylindres de façon alternée entre les deux bancs pour lisser le couple et limiter les vibrations.', tier: 'control' },
      ],
      edges: [
        { from: 'v8-bank', to: 'v8-pistons', label: 'poussée des gaz', flow: 'energy' },
        { from: 'v8-pistons', to: 'v8-crank', label: 'poussée axiale', flow: 'mechanical' },
        { from: 'v8-cams', to: 'v8-valves', label: 'ouverture commandée', flow: 'control' },
        { from: 'v8-crank', to: 'v8-cams', label: 'entraînement à mi-vitesse', flow: 'mechanical' },
        { from: 'v8-valves', to: 'v8-bank', label: 'admission et échappement', flow: 'gas' },
        { from: 'v8-firing', to: 'v8-bank', label: 'séquence d\'allumage', flow: 'ignition' },
      ],
      notes: [
        'Un cycle complet demande deux tours de vilebrequin : l\'ordre d\'allumage répartit donc huit allumages sur 720°.',
        'Le V8 « croisé » (cross-plane) produit le grondement caractéristique ; le V8 « plat » (flat-plane) monte plus haut en régime.',
        'Deux bancs sur un même vilebrequin : c\'est ce qui distingue un V8 d\'un moteur à cylindres en ligne.',
      ],
    },
  },
  {
    id: 'gearbox-auto',
    // Boîte automatique : chemin de puissance à travers convertisseur, trains
    // épicycloïdaux et embrayages. Le type `system` convient : graphe de
    // composants avec flux orientés et typés (mécanique, hydraulique, commande).
    match: (q) =>
      has(q, /bo[îi]te automatique|bo[îi]te auto|\bbva\b|convertisseur de couple|[ée]picyclo[ïi]dal|train plan[ée]taire|rapports? de transmission/i) &&
      !has(q, /xdrive|quattro|4matic|transmission int[ée]grale/i),
    visual: {
      type: 'system',
      title: 'Boîte automatique : chemin de puissance dans les trains épicycloïdaux',
      nodes: [
        { id: 'gbox-engine', label: 'Moteur', detail: 'Fournit le couple d\'entrée, à un régime variable.', tier: 'source' },
        { id: 'gbox-tc', label: 'Convertisseur de couple', detail: 'Couple hydrauliquement le moteur à la boîte : il multiplie le couple au démarrage et absorbe les à-coups, sans liaison mécanique rigide.', tier: 'power' },
        { id: 'gbox-planet', label: 'Trains épicycloïdaux', detail: 'Combinaison de planétaires, porte-satellites et couronnes : en bloquant ou libérant un élément, on obtient un rapport différent sans changer de pignon.', tier: 'power' },
        { id: 'gbox-clutches', label: 'Embrayages et freins', detail: 'Multidisques immergés : ils immobilisent ou solidarisent les éléments du train pour sélectionner le rapport.', tier: 'control' },
        { id: 'gbox-hydraulic', label: 'Distributeur hydraulique', detail: 'Applique la pression d\'huile aux embrayages concernés selon le rapport demandé, sur ordre du calculateur.', tier: 'control' },
        { id: 'gbox-ecu', label: 'Calculateur de boîte', detail: 'Choisit le rapport d\'après le régime, la charge, la vitesse et le mode de conduite, puis commande le distributeur.', tier: 'control' },
        { id: 'gbox-out', label: 'Arbre de sortie', detail: 'Transmet le couple au rapport final et aux roues motrices.', tier: 'mechanical' },
      ],
      edges: [
        { from: 'gbox-engine', to: 'gbox-tc', label: 'couple d\'entrée', flow: 'mechanical' },
        { from: 'gbox-tc', to: 'gbox-planet', label: 'couple multiplié', flow: 'mechanical' },
        { from: 'gbox-ecu', to: 'gbox-hydraulic', label: 'rapport demandé', flow: 'control' },
        { from: 'gbox-hydraulic', to: 'gbox-clutches', label: 'pression d\'huile', flow: 'control' },
        { from: 'gbox-clutches', to: 'gbox-planet', label: 'élément bloqué', flow: 'control' },
        { from: 'gbox-planet', to: 'gbox-out', label: 'rapport engagé', flow: 'mechanical' },
        { from: 'gbox-out', to: 'gbox-ecu', label: 'régime de sortie', flow: 'control' },
      ],
      notes: [
        'Le convertisseur multiplie le couple au démarrage ; un embrayage de pontage le verrouille ensuite pour supprimer le glissement et économiser du carburant.',
        'Un train épicycloïdal combine trois éléments : en bloquant un seul, on obtient un nouveau rapport — d\'où plusieurs vitesses avec peu de pièces.',
        'Le passage d\'un rapport à l\'autre se fait en croisant deux embrayages : l\'un s\'ouvre pendant que l\'autre se ferme, sans interruption de couple.',
      ],
    },
  },
  {
    id: 'brake-system',
    // Freinage hydraulique assisté, avec antiblocage. Structure en CHAÎNE DE
    // COMMANDE + CIRCUIT : la pédale crée une pression, le maître-cylindre la
    // transforme, le circuit la transporte, l'étrier la convertit en serrage,
    // et l'ABS peut moduler cette pression. C'est un graphe de composants
    // orientés — donc `system`, pas `steps` (le sujet n'est pas une procédure).
    // La garde exclut le freinage régénératif électrique, traité par `ev-car`.
    match: (q) =>
      has(q, /freinage|freins?\b|frein\b|[ée]triers?|plaquettes?|disques? de frein|ma[îi]tre[- ]cylindre|circuit (?:de freinage|hydraulique)/i) &&
      !has(q, /freinage r[ée]g[ée]n[ée]ratif|r[ée]cup[ée]ration d'[ée]nergie|voiture [ée]lectrique|v[ée]hicule [ée]lectrique/i) &&
      // « freinage sélectif » est le levier du contrôle de traction : le
      // traiter ici produisait un schéma de freinage complet pour une question
      // de motricité.
      !has(q, /freinage s[ée]lectif|contr[ôo]le de traction|antipatinage|patinage|motricit[ée]/i),
    visual: {
      type: 'system',
      title: 'Système de freinage : de la pédale à la roue, avec régulation ABS',
      nodes: [
        { id: 'brk-pedal', label: 'Pédale de frein', detail: 'Le conducteur exerce un effort. Un capteur de course renseigne le calculateur, et l\'assistance (servofrein) amplifie cet effort avant de l\'envoyer au maître-cylindre.', tier: 'source' },
        { id: 'brk-master', label: 'Maître-cylindre', detail: 'Deux pistons en série (montage à double circuit) transforment l\'effort de la pédale en pression hydraulique, avec une course morte initiale qui libère les orifices de compensation.', tier: 'power' },
        { id: 'brk-circuit', label: 'Circuit hydraulique', detail: 'Liquide de frein incompressible en canalisations rigides et flexibles : la pression est transmise quasi instantanément, sans perte. Deux circuits indépendants conservent un freinage en cas de fuite.', tier: 'mechanical' },
        { id: 'brk-abs', label: 'Unité hydraulique ABS', detail: 'Pompe et accumulateur : elle peut augmenter, maintenir ou relâcher la pression dans chaque circuit, indépendamment de l\'action du conducteur.', tier: 'control' },
        { id: 'brk-valves', label: 'Électrovannes', detail: 'Une paire d\'électrovannes par roue (isolement et décharge) : en cycles de quelques millisecondes, elles modulent la pression pour empêcher le blocage.', tier: 'control' },
        { id: 'brk-ecu', label: 'Calculateur ABS', detail: 'Compare la décélération des roues à la décélération du véhicule. Dès qu\'une roue se bloque, il relâche la pression puis la rétablit : c\'est le cycle régulation.', tier: 'control' },
        { id: 'brk-sensors', label: 'Capteurs de vitesse de roue', detail: 'Capteurs magnétiques ou à effet Hall sur chaque moyeu : ils comptent les dents d\'une cible tournante et donnent la vitesse de chaque roue au calculateur.', tier: 'control' },
        { id: 'brk-caliper', label: 'Étriers', detail: 'Le piston d\'étrier transforme la pression hydraulique en effort mécanique sur les plaquettes — c\'est la conversion hydraulique → mécanique du système.', tier: 'power' },
        { id: 'brk-pads', label: 'Plaquettes', detail: 'Elles pressent le disque. Leur coefficient de frottement, stable en température, définit la décélération pour une pression donnée.', tier: 'mechanical' },
        { id: 'brk-disc', label: 'Disques', detail: 'Solidaires de la roue, ils dissipent l\'énergie cinétique en chaleur. Sur une sportive, ils sont ventilés — parfois percés ou rainurés — pour évacuer cette chaleur et les gaz de friction.', tier: 'mechanical' },
        { id: 'brk-wheel', label: 'Roues et pneumatiques', detail: 'Seul contact avec la route : le freinage n\'existe que par l\'adhérence du pneu. Un pneu bloqué glisse et perd son adhérence latérale — d\'où l\'intérêt de l\'ABS.', tier: 'mechanical' },
      ],
      edges: [
        { from: 'brk-pedal', to: 'brk-master', label: 'effort amplifié', flow: 'mechanical' },
        { from: 'brk-master', to: 'brk-circuit', label: 'pression hydraulique', flow: 'energy' },
        { from: 'brk-circuit', to: 'brk-abs', label: 'pression', flow: 'energy' },
        { from: 'brk-abs', to: 'brk-valves', label: 'pression modulée', flow: 'energy' },
        { from: 'brk-sensors', to: 'brk-ecu', label: 'vitesse de chaque roue', flow: 'control' },
        { from: 'brk-ecu', to: 'brk-valves', label: 'cycle de régulation', flow: 'control' },
        { from: 'brk-valves', to: 'brk-caliper', label: 'pression maintenue ou relâchée', flow: 'energy' },
        { from: 'brk-caliper', to: 'brk-pads', label: 'serrage', flow: 'mechanical' },
        { from: 'brk-pads', to: 'brk-disc', label: 'frottement', flow: 'mechanical' },
        { from: 'brk-disc', to: 'brk-wheel', label: 'couple de freinage', flow: 'mechanical' },
      ],
      notes: [
        'La pression est le fluide porteur de tout le système : elle naît au maître-cylindre et ne se transforme en effort qu\'au piston d\'étrier.',
        'L\'ABS ne freine pas plus fort : il empêche le blocage pour conserver l\'adhérence et la direction. Le freinage reste l\'affaire des disques et des plaquettes.',
        'Les capteurs de roue sont partagés avec l\'ESP et l\'antipatinage : une même information sert au freinage, à la stabilité et à la motricité.',
      ],
    },
  },
  {
    id: 'abs-system',
    // Sous-système de régulation : capteurs → calculateur → électrovannes →
    // pression de roue, en boucle fermée. Utilisé quand la question porte sur
    // l'ABS lui-même et pas sur l'ensemble du freinage.
    // Réservée à l'ABS SEUL : dès que la question couvre aussi le freinage
    // lui-même (étriers, disques, maître-cylindre, circuit), c'est la règle
    // `brake-system` qui répond — l'ABS n'y est qu'un sous-système.
    match: (q) =>
      has(q, /antiblocage|anti-blocage|\babs\b/i) &&
      !has(q, /freinage|[ée]triers?|disques? de frein|plaquettes?|ma[îi]tre[- ]cylindre|circuit (?:de freinage|hydraulique)/i),
    visual: {
      type: 'system',
      title: 'ABS : la boucle de régulation qui empêche le blocage des roues',
      nodes: [
        { id: 'abs-sensors', label: 'Capteurs de vitesse de roue', detail: 'Un capteur par roue, sur le moyeu : il lit le passage des dents d\'une cible tournante et fournit une fréquence proportionnelle à la vitesse de la roue.', tier: 'source' },
        { id: 'abs-ecu', label: 'Calculateur ABS', detail: 'Il compare la vitesse de chaque roue et son taux de décélération. Un écart brutal avec les autres roues signale l\'approche du blocage, avant même l\'arrêt complet.', tier: 'control' },
        { id: 'abs-pump', label: 'Pompe de refoulement', detail: 'Elle renvoie vers le maître-cylindre le liquide prélevé pendant les phases de décharge : sans elle, la pédale s\'enfoncerait à chaque cycle.', tier: 'power' },
        { id: 'abs-accumulator', label: 'Accumulateur basse pression', detail: 'Il absorbe le liquide relâché et lisse les variations de pression, ce qui donne à la pédale ses pulsations caractéristiques.', tier: 'power' },
        { id: 'abs-inlet', label: 'Électrovanne d\'isolement', detail: 'Fermée : la pression de la roue est maintenue au niveau atteint, le conducteur ne peut plus l\'augmenter.', tier: 'control' },
        { id: 'abs-outlet', label: 'Électrovanne de décharge', detail: 'Ouverte : une partie du liquide repart vers l\'accumulateur et la pression chute, le blocage disparaît et la roue repart.', tier: 'control' },
        { id: 'abs-pressure', label: 'Pression de freinage à la roue', detail: 'Chaque roue dispose d\'une pression pilotée séparément : c\'est cette indépendance qui permet de freiner une roue pendant que l\'autre est relâchée.', tier: 'mechanical' },
        { id: 'abs-wheel', label: 'Roue et pneumatique', detail: 'Le but de la régulation est de maintenir un glissement de l\'ordre de 10 à 20 %, où l\'adhérence longitudinale est maximale tout en conservant l\'adhérence latérale.', tier: 'mechanical' },
      ],
      edges: [
        { from: 'abs-sensors', to: 'abs-ecu', label: 'vitesse de roue', flow: 'control' },
        { from: 'abs-ecu', to: 'abs-inlet', label: 'fermer', flow: 'control' },
        { from: 'abs-ecu', to: 'abs-outlet', label: 'ouvrir', flow: 'control' },
        { from: 'abs-ecu', to: 'abs-pump', label: 'refouler', flow: 'control' },
        { from: 'abs-inlet', to: 'abs-pressure', label: 'pression maintenue', flow: 'energy' },
        { from: 'abs-outlet', to: 'abs-accumulator', label: 'liquide relâché', flow: 'energy' },
        { from: 'abs-accumulator', to: 'abs-pump', label: 'liquide stocké', flow: 'energy' },
        { from: 'abs-pump', to: 'abs-pressure', label: 'pression rétablie', flow: 'energy' },
        { from: 'abs-pressure', to: 'abs-wheel', label: 'couple de freinage', flow: 'mechanical' },
      ],
      notes: [
        'Le cycle complet — maintenir, relâcher, rétablir — dure quelques millisecondes et se répète plusieurs fois par seconde.',
        'L\'ABS agit sur la pression, jamais sur l\'effort du conducteur : la pédale reste enfoncée pendant tout le freinage.',
        'Le même capteur alimente l\'ESP : la régulation de stabilité réutilise le bloc ABS pour freiner une roue isolée.',
      ],
    },
  },
  {
    id: 'adaptive-suspension',
    // Suspension pilotée : un ressort porte la masse, un amortisseur dissipe
    // l'énergie, une électrovanne règle la dissipation, un calculateur décide
    // d'après des capteurs. Boucle fermée complète, donc `system`.
    match: (q) => has(q, /suspension adaptable|suspension adaptative|suspension pilot[ée]e|amortissement pilot[ée]|amortisseurs? adaptatifs?|amortisseurs? pilot[ée]s?/i),
    visual: {
      type: 'system',
      title: 'Suspension adaptative : la boucle qui règle l\'amortissement en continu',
      nodes: [
        { id: 'susp-sensors', label: 'Capteurs d\'accélération', detail: 'Accéléromètres sur la caisse et parfois sur les roues : ils mesurent les mouvements verticaux, le tangage et le roulis, plusieurs centaines de fois par seconde.', tier: 'source' },
        { id: 'susp-height', label: 'Capteurs de hauteur de caisse', detail: 'Un capteur de débattement par roue : il donne la position de la suspension et la charge réelle du véhicule.', tier: 'source' },
        { id: 'susp-ecu', label: 'Calculateur de châssis', detail: 'Il distingue ce qui vient de la route (haute fréquence) de ce qui vient de la conduite (freinage, virages). Il en déduit la loi d\'amortissement à appliquer, roue par roue.', tier: 'control' },
        { id: 'susp-valve', label: 'Électrovannes d\'amortisseur', detail: 'Elles font varier la section de passage de l\'huile à l\'intérieur de l\'amortisseur : plus le passage est étroit, plus l\'amortissement est ferme.', tier: 'control' },
        { id: 'susp-damper', label: 'Amortisseurs pilotés', detail: 'Ils dissipent l\'énergie du mouvement de la caisse en convertissant la vitesse du piston en chaleur, via le laminage de l\'huile dans les clapets.', tier: 'process' },
        { id: 'susp-spring', label: 'Ressorts', detail: 'Ils portent la masse du véhicule et absorbent les irrégularités. Sur certaines versions, le ressort est pneumatique : la hauteur de caisse devient réglable.', tier: 'mechanical' },
        { id: 'susp-arms', label: 'Triangles et liaisons', detail: 'Ils guident la roue selon une trajectoire définie et transmettent les efforts du sol à la caisse, sans empêcher le débattement.', tier: 'mechanical' },
        { id: 'susp-body', label: 'Caisse et roues', detail: 'La masse non suspendue (roue, frein, une partie du triangle) suit la route ; la masse suspendue (caisse) est ce que la régulation cherche à stabiliser.', tier: 'mechanical' },
      ],
      edges: [
        { from: 'susp-sensors', to: 'susp-ecu', label: 'accélérations mesurées', flow: 'control' },
        { from: 'susp-height', to: 'susp-ecu', label: 'débattement par roue', flow: 'control' },
        { from: 'susp-ecu', to: 'susp-valve', label: 'loi d\'amortissement', flow: 'control' },
        { from: 'susp-valve', to: 'susp-damper', label: 'section de passage', flow: 'control' },
        { from: 'susp-spring', to: 'susp-damper', label: 'énergie à dissiper', flow: 'mechanical' },
        { from: 'susp-damper', to: 'susp-arms', label: 'effort amorti', flow: 'mechanical' },
        { from: 'susp-arms', to: 'susp-body', label: 'efforts transmis', flow: 'mechanical' },
        { from: 'susp-body', to: 'susp-sensors', label: 'mouvements de caisse', flow: 'mechanical' },
      ],
      notes: [
        'Un ressort seul oscillerait longtemps : l\'amortisseur est ce qui transforme cette oscillation en chaleur, donc ce qui stabilise la caisse.',
        'Le temps de réaction compte plus que l\'amplitude : sur une route dégradée, la régulation travaille en quelques millisecondes, bien plus vite qu\'un réglage manuel.',
        'Les modes « confort » et « sport » ne changent pas les ressorts sur la plupart des systèmes : ils changent la loi d\'amortissement appliquée aux électrovannes.',
      ],
    },
  },
  {
    id: 'internet',
    // Repli de CONTENU : conserve la connaissance du sujet (les composants),
    // mais le TYPE n'est plus imposé ici — il vient de analyzeStructure().
    // Sans cette séparation, une demande de trajet aller-retour recevait une
    // simple chaîne linéaire, et une demande chronologique aurait reçu la même.
    match: (q) => has(q, /internet|fournisseur d'acc[èe]s|routeur|fibre optique|adresse ip|r[ée]seau (mondial|informatique)/i),
    visual: {
      type: 'journey',
      title: 'Le trajet d\'une requête sur Internet',
      from: 'Mon appareil',
      to: 'Le serveur du site',
      steps: [
        { number: 1, lane: 'request', label: 'Mon appareil', protocol: 'HTTPS', detail: 'Le navigateur construit une requête HTTP. L\'URL est résolue et un canal chiffré TLS est ouvert avec le serveur.' },
        { number: 2, lane: 'request', label: 'Routeur Wi-Fi', detail: 'La box relaie les paquets du réseau local vers la ligne de l\'opérateur (NAT : elle traduit l\'adresse locale en adresse publique).' },
        { number: 3, lane: 'side', label: 'DNS', detail: 'Un annuaire traduit le nom de domaine en adresse IP. Cette étape ne transporte pas la donnée : elle fournit l\'adresse, puis s\'efface.' },
        { number: 4, lane: 'request', label: "Fournisseur d'accès", detail: 'Le FAI achemine les paquets vers l\'épine dorsale mondiale : fibre optique, câbles sous-marins, puis échange de trafic entre opérateurs.' },
        { number: 5, lane: 'request', label: 'Serveur du site', detail: 'Le serveur reçoit la requête, l\'authentifie, interroge sa base de données si besoin et prépare la page.' },
        { number: 6, lane: 'response', label: 'Retour par le réseau', detail: 'La réponse traverse le même chemin en sens inverse, découpée en paquets dont l\'ordre est reconstitué à l\'arrivée.' },
        { number: 7, lane: 'response', label: 'Affichage sur mon appareil', protocol: 'HTTPS', detail: 'Le navigateur déchiffre la réponse, analyse le HTML, télécharge les ressources et affiche la page.' },
      ],
      components: [
        { label: 'Mon appareil', role: 'Client', detail: 'Navigateur, système, carte réseau : il émet la requête et affiche le résultat.' },
        { label: 'Routeur Wi-Fi', role: 'Passerelle', detail: 'Relie le réseau local à Internet ; attribue les adresses locales et traduit les adresses (NAT).' },
        { label: "Fournisseur d'accès", role: 'Transport', detail: 'Achemine les paquets sur de longues distances jusqu\'aux réseaux des hébergeurs.' },
        { label: 'DNS', role: 'Annuaire', detail: 'Traduit le nom de domaine (ex. exemple.fr) en adresse IP routable.' },
        { label: 'Serveurs', role: 'Destination', detail: 'Servent la page demandée : serveur web, cache, base de données.' },
        { label: 'HTTPS', role: 'Chiffrement', detail: 'TLS chiffre et authentifie l\'échange de bout en bout, au-dessus de TCP.' },
      ],
      encryption: 'HTTPS = HTTP sur une connexion chiffrée TLS. Le certificat du serveur est vérifié par le navigateur ; les données deviennent illisibles pour tout intermédiaire (routeur, FAI, Wi-Fi public), qui ne voit que l\'adresse de destination.',
      notes: [
        'La requête et la réponse empruntent le même chemin : le trajet est un aller-retour, pas une chaîne à sens unique.',
        'Le DNS n\'est pas sur le trajet de la donnée : il fournit l\'adresse IP avant l\'envoi, comme un annuaire ne transporte pas la lettre.',
        'Chaque paquet est indépendant : il peut emprunter un autre chemin que ses voisins et être réassemblé à l\'arrivée.',
      ],
    },
  },
  {
    id: 'atmosphere',
    match: (q) => has(q, /couches? de l'atmosph[èe]re|atmosph[èe]re/i),
    visual: {
      type: 'layers',
      title: 'Les couches de l\'atmosphère',
      items: [
        { label: 'Troposphère', value: '0 – 12 km', detail: 'C\'est là que se produisent la météo, les nuages et la majorité de la vapeur d\'eau.' },
        { label: 'Stratosphère', value: '12 – 50 km', detail: 'Elle contient la couche d\'ozone qui filtre les rayons ultraviolets. Les avions de ligne y volent.' },
        { label: 'Mésosphère', value: '50 – 85 km', detail: 'La température y chute jusqu\'à −90 °C. Les météorites y brûlent et deviennent des étoiles filantes.' },
        { label: 'Thermosphère', value: '85 – 600 km', detail: 'Températures très élevées mais gaz raréfiés. Aurores polaires et orbite de la Station spatiale.' },
        { label: 'Exosphère', value: 'au-delà de 600 km', detail: 'Limite où l\'atmosphère se fond dans l\'espace. Les satellites y circulent.' },
      ],
    },
  },
  {
    id: 'solar',
    match: (q) => has(q, /syst[èe]me solaire|plan[èe]tes?/i),
    visual: {
      type: 'diagram',
      title: 'L\'organisation du système solaire',
      root: {
        id: 'sun', label: 'Le Soleil', detail: 'Une étoile qui concentre 99,8 % de la masse du système et maintient tout en orbite.',
        children: [
          {
            id: 'inner', label: 'Planètes rocheuses', detail: 'Mercure, Vénus, la Terre et Mars : petites, denses, proches du Soleil.', children: [
              { id: 'earth', label: 'La Terre', detail: 'La seule planète connue abritant la vie. Orbitée par la Lune.' },
            ],
          },
          {
            id: 'outer', label: 'Géantes gazeuses et glacées', detail: 'Jupiter, Saturne, Uranus et Neptune : volumineuses et éloignées.', children: [
              { id: 'saturn', label: 'Saturne', detail: 'Célèbre pour ses anneaux composés de glace et de roche.' },
            ],
          },
          { id: 'small', label: 'Petits corps', detail: 'Astéroïdes, comètes et planètes naines comme Pluton, reliquats de la formation du système.' },
        ],
      },
    },
  },
  {
    id: 'engine',
    // Fiche du MOTEUR ÉLECTRIQUE. Son motif ne doit plus capturer le mot
    // « moteur » seul : c'est ainsi qu'une question sur le REFROIDISSEMENT du
    // moteur d'une BMW M5 recevait « Les organes d'un moteur électrique » —
    // deux systèmes confondus. Il faut désormais une marque de moteur
    // électrique, et aucune marque d'un autre système.
    match: (q) =>
      has(q, /moteur [ée]lectrique|machine [ée]lectrique|stator|rotor|bobinage/i) &&
      !has(
        q,
        /refroidissement|lubrification|huile|radiateur|thermostat|pompe [àa] eau|freinage|[ée]triers?|direction assist[ée]e|transmission int[ée]grale|contr[ôo]le de traction|admission|échappement|injection|suralimentation|vilebrequin|bielle|soupape|piston/i
      ) &&
      !has(q, /voiture|v[ée]hicule/i),
    visual: {
      type: 'concept',
      title: "Les organes d'un moteur électrique",
      nodes: [
        { id: 'battery', label: 'Batterie', detail: 'Fournit le courant continu sous une tension donnée.' },
        { id: 'controller', label: 'Contrôleur', detail: "Module l'énergie : fréquence et intensité déterminent la vitesse et le couple." },
        { id: 'stator', label: 'Stator', detail: 'Bobines fixes qui créent un champ magnétique tournant.' },
        { id: 'rotor', label: 'Rotor', detail: "Aimants qui suivent le champ tournant et entraînent l'arbre moteur." },
        { id: 'gear', label: 'Transmission', detail: 'Réduit la vitesse de rotation et transmet la force aux roues.' },
      ],
      edges: [
        { from: 'battery', to: 'controller', label: 'alimente' },
        { from: 'controller', to: 'stator', label: 'commande' },
        { from: 'stator', to: 'rotor', label: 'entraîne' },
        { from: 'rotor', to: 'gear', label: 'transmet' },
      ],
    },
  },
  {
    id: 'ai',
    match: (q) => has(q, /intelligence artificielle|\bia\b|r[ée]seau(x)? neuronal|machine learning|apprentissage automatique|chatgpt|llm/i),
    visual: {
      type: 'diagram',
      title: 'Comment fonctionne une IA',
      root: {
        id: 'data', label: 'Données d\'entraînement', detail: 'Textes, images, sons : la matière première, nettoyée et mise en forme.',
        children: [
          {
            id: 'model', label: 'Modèle (réseau de neurones)', detail: 'Des millions de paramètres ajustés automatiquement par calcul de gradient.', children: [
              { id: 'layers', label: 'Couches de calcul', detail: 'Chaque couche transforme la représentation : des traits aux concepts.' },
              { id: 'weights', label: 'Paramètres', detail: 'Les valeurs apprises, figées après l\'entraînement.' },
            ],
          },
          { id: 'infer', label: 'Inférence', detail: 'Le modèle produit une réponse, mot après mot, à partir du prompt.' },
          { id: 'eval', label: 'Évaluation', detail: 'Mesure de la qualité : un mauvais score renvoie à l\'entraînement.' },
        ],
      },
    },
  },
  {
    id: 'cell',
    match: (q) => has(q, /cellule (humaine|animale|v[ée]g[ée]tale)|cellule\b.*organites?/i),
    visual: {
      type: 'concept',
      title: 'Les organites d\'une cellule',
      nodes: [
        { id: 'nucleus', label: 'Noyau', detail: 'Contient l\'ADN, programme de fonctionnement de la cellule.' },
        { id: 'mito', label: 'Mitochondries', detail: 'Produisent l\'énergie (ATP) par respiration cellulaire.' },
        { id: 'er', label: 'Réticulum endoplasmique', detail: 'Fabrique et achemine protéines et lipides.' },
        { id: 'golgi', label: 'Appareil de Golgi', detail: 'Trie et expédie les protéines vers leur destination.' },
        { id: 'membrane', label: 'Membrane plasmique', detail: 'Frontière sélective : elle contrôle les échanges avec l\'extérieur.' },
      ],
      edges: [
        { from: 'nucleus', to: 'er', label: 'instructions' },
        { from: 'er', to: 'golgi', label: 'protéines' },
        { from: 'mito', to: 'cell', label: 'énergie' },
        { from: 'membrane', to: 'nucleus', label: 'protège' },
      ].filter((e) => e.to !== 'cell'),
    },
  },
  {
    id: 'energy',
    match: (q) => has(q, /mix [ée]nerg[ée]tique|[ée]nergies renouvelables|part du nucl[ée]aire/i),
    visual: {
      type: 'pie',
      title: 'Répartition indicative des sources d\'électricité',
      unit: '%',
      slices: [
        { label: 'Fossiles', value: 60 },
        { label: 'Nucléaire', value: 9 },
        { label: 'Hydraulique', value: 15 },
        { label: 'Éolien', value: 8 },
        { label: 'Solaire', value: 8 },
      ],
    },
  },
]


// Conversion du graphe du RAISONNEUR en visuel validable.
// Le raisonneur produit des nœuds/arcs génériques ; ce passage leur donne le
// contrat exact du type `system` (tier, flow connu du rendu) et rejette ce qui
// ne serait pas affichable, plutôt que de laisser un visuel partiel.
const KNOWN_FLOWS = new Set(['energy', 'control', 'mechanical', 'recovery', 'gas', 'ignition', 'fluid', 'heat', 'information'])

function visualFromReason(question) {
  const r = reason(question)
  if (!r.supported || !r.nodes?.length || !r.edges?.length) return null
  if (r.nodes.length < 3 || r.edges.length < 2) return null
  const visual = {
    type: 'system',
    title: r.title,
    nodes: r.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      detail: n.detail,
      tier: n.tier,
      added: n.added === true || undefined,
    })),
    edges: r.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: e.label,
      flow: KNOWN_FLOWS.has(e.flow) ? e.flow : 'energy',
    })),
    notes: r.notes ?? [],
    reasoned: true,
    // Deux chaînes d'énergie distinctes : le visuel ne peut pas être remplacé
    // par un gabarit mono-système.
    multiChain: r.multiChain === true,
    // Actions absorbées : la question les demandait, le schéma les exprime par
    // un arc étiqueté. Elles ne doivent donc pas être comptées « manquantes ».
    representedActions: r.representedActions ?? [],
    // Couverture calculée par le raisonneur : composants demandés vs affichés,
    // plus les actions exprimées par un arc.
    reasonedCoverage: {
      asked: r.nodes.length + (r.representedActions?.length ?? 0),
      covered: r.nodes.length + (r.representedActions?.length ?? 0),
      ratio: 1,
    },
  }
  return visual
}

// Retourne un visuel pertinent pour la question, ou null.
// `hasVisualAlready` évite d'en rajouter un quand le modèle en a fourni un.
// Sélection par COUVERTURE : plusieurs règles peuvent correspondre, on garde
// celle qui représente le mieux les entités réellement demandées. C'était le
// cœur du bug : `RULES.find()` gardait la première règle correspondante, d'où
// un schéma « organes du moteur » pour une question sur la voiture entière.
export function planVisual(question, { hasVisualAlready = false, streaming = false } = {}) {
  if (hasVisualAlready || streaming) return null
  const q = String(question ?? '')
  if (q.length < 6) return null

  const candidates = RULES.filter((r) => r.match(q))
  const structure = analyzeStructure(q)

  // --- Sujet COMPOSITE : le raisonneur passe avant les règles -------------
  //
  // Une règle de contenu décrit UN système (la transmission intégrale, le
  // moteur, la boîte…). Quand la question décrit plusieurs chaînes d'énergie
  // qui coexistent — c'est la définition d'une propulsion hybride — aucune
  // règle ne peut la représenter : elle n'en montrerait qu'une moitié.
  // Cas réel : la Mercedes-AMG C 63 S E PERFORMANCE tombait sur la règle
  // « transmission intégrale », qui ignore le chemin électrique et la batterie.
  // On demande donc au raisonneur un graphe à deux chaînes, et il gagne.
  const reasonedFirst = visualFromReason(q)
  if (reasonedFirst && reasonedFirst.multiChain) {
    const cov = coverage(q, reasonedFirst)
    reasonedFirst.coverage = { asked: cov.asked, covered: cov.covered, ratio: Number(cov.ratio.toFixed(2)) }
    reasonedFirst.structure = structure
    return reasonedFirst
  }
  const asked = extractEntities(q)

  // --- Correctif central ---------------------------------------------------
  // Avant : le score valait `covered * 10 + ratio * 5 + 1`. Quand aucune entité
  // n'était reconnue (cas de la question Internet avant l'ajout du vocabulaire
  // réseau), tous les candidats obtenaient exactement 1 point et le gagnant
  // était le premier du tableau : le mot-clé décidait du type, pas la demande.
  // Désormais la structure de la demande pèse dans le score, et un candidat
  // dont le type correspond à cette structure l'emporte sur l'ordre de liste.
  const STRUCTURE_BONUS = 12

  const scored = candidates.map((rule) => {
    const { asked: askedCount, covered, ratio } = coverage(q, rule.visual)
    const typeAgrees = structure.best && rule.visual.type === structure.best
    const score =
      covered * 10 +
      ratio * 5 +
      (typeAgrees ? STRUCTURE_BONUS : 0) +
      // Un candidat qui couvre des entités demandées passe devant un candidat muet.
      (askedCount > 0 && covered > 0 ? 2 : 0)
    return { rule, covered, ratio, asked: askedCount, typeAgrees, score }
  })
  scored.sort((a, b) => b.score - a.score)
  const best = scored[0]

  if (!best) {
    // Aucune règle de CONTENU ne correspond. C'est le cas de tout sujet
    // automobile nouveau. Plutôt que de renvoyer « rien » (et donc un refus),
    // on demande au RAISONNEUR de construire un graphe à partir des composants
    // réellement nommés dans la question et de leurs relations physiques.
    // S'il ne peut pas le faire de façon défendable, il refuse et la réponse
    // textuelle honnête prend le relais.
    const reasoned = visualFromReason(q)
    if (reasoned) {
      const cov = coverage(q, reasoned)
      reasoned.coverage = { asked: cov.asked, covered: cov.covered, ratio: Number(cov.ratio.toFixed(2)) }
      reasoned.structure = structure
      return reasoned
    }
    return null
  }

  // Garde de cohérence : quand la structure de la demande est franchement
  // identifiée et qu'AUCUNE règle correspondante ne produit ce type, on
  // n'impose pas un visuel mal typé. Cas réel observé : « Raconte l'histoire
  // d'Internet de 1969 à 2020 » est une chronologie, mais la seule règle
  // correspondante sait dessiner un trajet réseau. Afficher un trajet
  // répondrait à côté ; la réponse textuelle, elle, reste juste.
  // Le type `timeline` est concerné en priorité : il exige de vraies dates,
  // qu'aucune règle de contenu ne peut inventer sans fabriquer des faits.
  const STRUCTURE_CONFIDENCE = 2.5
  const strongStructure = structure.votes[0] && structure.votes[0].score >= STRUCTURE_CONFIDENCE
  if (
    strongStructure &&
    structure.best === 'timeline' &&
    best.rule.visual.type !== 'timeline'
  ) {
    return null
  }

  const visual = { ...best.rule.visual, structure }

  // Enrichissement : les entités demandées qu'AUCUNE partie du visuel ne couvre.
  //
  // Correction : la recherche ne portait que sur les libellés des nœuds. Une
  // entité pourtant déjà représentée par le titre (« Transmission intégrale »)
  // ou par une note était donc ajoutée comme nœud supplémentaire — et ce nœud,
  // sans aucun lien, apparaissait comme un bloc orphelin dans le schéma.
  // On cherche désormais dans l'ensemble du visuel avant d'ajouter quoi que ce soit.
  if (visual.nodes) {
    const haystack = [
      visual.title ?? '',
      ...visual.nodes.map((n) => n.label),
      ...visual.nodes.map((n) => n.detail ?? ''),
      ...(visual.notes ?? []),
    ].join(' ').toLowerCase()
    const labels = visual.nodes.map((n) => n.label.toLowerCase())
    const missing = asked.filter((e) => {
      const label = e.label.toLowerCase()
      // Déjà représenté par un nœud ?
      if (labels.some((l) => l.includes(label) || label.includes(l))) return false
      // Déjà nommé dans le titre, un détail ou une note ? Alors pas de nœud en plus.
      return !haystack.includes(label)
    })
    if (missing.length) {
      // Règle de rendu : un schéma en graphe ne montre QUE des éléments reliés.
      // Un nœud ajouté sans lien apparaîtrait comme un bloc orphelin, en marge
      // du parcours, et donnerait une lecture fausse. On l'ajoute donc au graphe
      // par un lien vers le nœud le plus proche de sa famille (le premier nœud),
      // en gardant la trace du caractère ajouté.
      const anchor = visual.nodes[0]
      visual.nodes = [
        ...visual.nodes,
        ...missing.map((e) => ({
          id: e.id,
          label: e.label,
          detail: `Élément demandé dans votre question.`,
          tier: e.role === 'source' ? 'source' : e.role === 'control' ? 'control' : e.role === 'mechanical' ? 'mechanical' : 'power',
          added: true,
          anchoredTo: anchor?.id,
        })),
      ]
      if (visual.edges && anchor) {
        visual.edges = [
          ...visual.edges,
          ...missing.map((e) => ({ from: anchor.id, to: e.id, label: 'comprend', flow: 'control' })),
        ]
      }
    }
  }
  // Même enrichissement pour les types à étapes : une entité demandée qui
  // manque à la liste des étapes est signalée, sans réécrire le parcours.
  if (visual.steps) {
    // Un élément est « représenté » s'il apparaît dans une étape, un composant,
    // le titre ou le chiffrement. La comparaison tolère les reformulations
    // (« Serveurs » vs « Serveur du site ») en partageant au moins un mot
    // significatif — sinon on annoncerait à tort des éléments manquants.
    const haystack = [
      ...visual.steps.map((st) => st.label),
      ...(visual.components ?? []).map((c) => c.label),
      ...(visual.components ?? []).map((c) => c.detail ?? ''),
      visual.encryption ?? '',
      visual.title ?? '',
    ].join(' ').toLowerCase()
    const STOP = new Set(['des', 'les', 'une', 'aux', 'pour', 'mon', 'mes', 'mes', 'site', 'protocole'])
    const words = (t) => t.toLowerCase().split(/[^a-zàâäéèêëîïôöùûüç0-9]+/i).filter((w) => w.length > 3 && !STOP.has(w))
    const hayWords = new Set(words(haystack))
    const missing = asked.filter((e) => {
      const label = e.label.toLowerCase()
      if (haystack.includes(label)) return false
      const tokens = words(e.label)
      if (!tokens.length) return true
      return !tokens.some((t) => hayWords.has(t))
    })
    if (missing.length) visual.missingEntities = missing.map((e) => e.label)
  }

  // --- Garde de COHÉRENCE SUJET ↔ CONTENU --------------------------------
  //
  // Défaut commun trouvé en corrigeant le cas « freinage » : une règle pouvait
  // gagner avec un contenu qui ne traite PAS le sujet dominant de la question,
  // simplement parce que le vocabulaire du sujet n'était pas modélisé. Le
  // visuel affiché était alors correct dans sa forme, faux dans son propos, et
  // le texte de démonstration le décrivait fidèlement — donc hors sujet.
  //
  // Règle : on ne présente jamais un schéma spécialisé s'il ne couvre pas au
  // moins une entité du sujet reconnu. Dans ce cas on ne fabrique pas un schéma
  // trompeur : on renvoie null, et la réponse textuelle seule est servie
  // (voir `fallbackText` dans demo.js). C'est exactement la consigne produit :
  // mieux vaut une explication juste que rien, et rien qu'un schéma faux.
  if (visual.coverage && visual.coverage.asked > 0 && visual.coverage.covered === 0) {
    // La règle gagnante ne traite pas le sujet : on tente le raisonneur avant
    // de renoncer à tout visuel.
    const reasoned = visualFromReason(q)
    if (reasoned) {
      const cov = coverage(q, reasoned)
      if (cov.asked === 0 || cov.covered > 0) {
        reasoned.coverage = { asked: cov.asked, covered: cov.covered, ratio: Number(cov.ratio.toFixed(2)) }
        reasoned.structure = structure
        return reasoned
      }
    }
    return null
  }

  // Mesure sur le visuel FINAL : annoncer la couverture d'avant enrichissement
  // donnait un chiffre faux (2/4 alors que les quatre éléments étaient rendus).
  const finalCoverage = coverage(q, visual)
  visual.coverage = {
    asked: finalCoverage.asked,
    covered: finalCoverage.covered,
    ratio: Number(finalCoverage.ratio.toFixed(2)),
  }
  return visual
}

export const VISUAL_RULE_IDS = RULES.map((r) => r.id)

// Exposé pour les tests : la règle gagnante et son score de couverture.
export function planCandidates(question) {
  const q = String(question ?? '')
  const structure = analyzeStructure(q)
  return RULES.filter((r) => r.match(q)).map((rule) => ({
    id: rule.id,
    type: rule.visual.type,
    typeAgrees: rule.visual.type === structure.best,
    score: coverage(q, rule.visual).covered * 10 + coverage(q, rule.visual).ratio * 5 + (rule.visual.type === structure.best ? 12 : 0),
    ...coverage(q, rule.visual),
  }))
}

// Structure pressentie de la demande, exposée pour l'audit et les tests.
export function planStructure(question) {
  return analyzeStructure(question)
}
