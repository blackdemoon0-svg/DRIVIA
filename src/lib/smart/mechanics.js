// Connaissance des MÉCANISMES automobiles — composants, fonctions, relations.
//
// Pourquoi ce fichier existe.
// Les corrections précédentes ajoutaient une règle par sujet (`brake-system`,
// `abs-system`…). Chaque nouveau sujet automobile — refroidissement, contrôle de
// traction, direction assistée — repassait donc par le même échec : soit aucun
// visuel, soit, pire, le visuel d'un AUTRE système (le refroidissement de la
// BMW M5 recevait « Les organes d'un moteur électrique », parce que la règle
// générique `engine` ne testait que le mot « moteur »).
//
// Ce catalogue n'est PAS une liste de réponses. C'est un vocabulaire de
// COMPOSANTS (libellé GÉNÉRIQUE, fonctions possibles, domaine) et un vocabulaire
// de RELATIONS (sens et type de flux). Le raisonneur (`reasoner.js`) s'en sert
// pour construire un schéma à partir de la question réellement posée.
//
// Règles d'écriture :
//   • le libellé est la forme GÉNÉRIQUE employée dans une question
//     (« Calculateur », pas « Calculateur de motricité ») ; le nom précis est
//     dérivé du domaine par `DOMAIN_NAMING` ;
//   • `fn` décrit la fonction de l'organe, jamais le système entier ;
//   • aucune valeur chiffrée inventée ;
//   • `alts` liste les formes abrégées qu'un utilisateur emploie réellement.

export const COMPONENTS = {
  // ---------------------------------------------------------------- moteur
  engine: {
    label: 'Moteur',
    alts: ['moteur thermique', 'bloc moteur', 'moteur essence', 'moteur diesel'],
    fn: 'Convertit l\'énergie du carburant en couple, en rejetant une grande part sous forme de chaleur.',
    domain: 'engine',
    families: ['heatSource', 'mechanical'],
  },
  cylinders: {
    label: 'Cylindres',
    alts: ['chambre de combustion', 'chambres de combustion'],
    fn: 'Chambres où brûle le mélange : c\'est là que naît la chaleur.',
    domain: 'engine',
    families: ['heatSource'],
  },
  piston: { label: 'Pistons', fn: 'Transmettent la pression des gaz au vilebrequin.', domain: 'engine', families: ['mechanical'] },
  crankshaft: { label: 'Vilebrequin', fn: 'Convertit la poussée des pistons en rotation continue.', domain: 'engine', families: ['mechanical'] },
  // ------------------------------------------------------------ thermique
  coolant: {
    label: 'Liquide de refroidissement',
    alts: ['liquide de refroidissement', 'antigel', 'coolant'],
    fn: 'Mélange eau + antigel : il absorbe la chaleur dans le moteur et la transporte vers le radiateur sans bouillir.',
    domain: 'cooling',
    families: ['fluid'],
  },
  waterPump: {
    label: 'Pompe à eau',
    alts: ['pompe a eau'],
    fn: 'Entraînée par le moteur, elle met le liquide en circulation et maintient le débit dans tout le circuit.',
    domain: 'cooling',
    families: ['pump'],
  },
  thermostat: {
    label: 'Thermostat',
    fn: 'Vanne commandée par la température : fermée à froid pour accélérer la montée en température, elle s\'ouvre vers 90 °C pour laisser passer le liquide vers le radiateur.',
    domain: 'cooling',
    families: ['valve'],
  },
  radiator: {
    label: 'Radiateur',
    alts: ['radiateur'],
    fn: 'Échangeur air/liquide : le liquide chaud cède sa chaleur à l\'air qui traverse les ailettes.',
    domain: 'cooling',
    families: ['exchanger'],
  },
  heaterCore: {
    label: 'Radiateur de chauffage',
    alts: ['radiateur de chauffage', 'chauffage habitacle'],
    fn: 'Prélève une partie de la chaleur du liquide pour chauffer l\'habitacle : dérivatif du circuit principal.',
    domain: 'cooling',
    families: ['exchanger'],
  },
  fan: { label: 'Ventilateur', fn: 'Force l\'air à travers le radiateur quand le véhicule roule trop lentement pour le faire seul.', domain: 'cooling', families: ['pump'] },
  tempSensor: {
    label: 'Sonde de température',
    alts: ['sonde de temperature', 'sonde'],
    fn: 'Mesure la température du liquide et la transmet au calculateur, qui commande le thermostat et le ventilateur.',
    domain: 'cooling',
    families: ['sensor'],
  },
  // ------------------------------------------------------------ lubrifiant
  oil: { label: 'Huile moteur', alts: ['huile'], fn: 'Réduit le frottement, évacue une part de la chaleur et transporte les impuretés vers le filtre.', domain: 'lubrication', families: ['fluid'] },
  oilPump: { label: 'Pompe à huile', alts: ['pompe a huile'], fn: 'Met l\'huile sous pression et l\'envoie vers les points lubrifiés.', domain: 'lubrication', families: ['pump'] },
  oilFilter: { label: 'Filtre à huile', alts: ['filtre a huile'], fn: 'Retient les particules métalliques et les résidus de combustion.', domain: 'lubrication', families: ['filter'] },
  oilPan: { label: 'Carter d\'huile', alts: ['carter d\'huile'], fn: 'Réserve d\'huile : elle retombe par gravité après avoir lubrifié le moteur.', domain: 'lubrication', families: ['reservoir'] },
  bearings: { label: 'Coussinets', alts: ['coussinets'], fn: 'Surfaces de glissement lubrifiées : sans film d\'huile, elles s\'échauffent et se détruisent.', domain: 'lubrication', families: ['mechanical'] },
  // ------------------------------------------------------------ admission
  airFilter: { label: 'Filtre à air', alts: ['filtre a air'], fn: 'Retient les poussières avant l\'entrée dans le moteur.', domain: 'air', families: ['filter'] },
  turbo: { label: 'Turbocompresseur', alts: ['turbo', 'turbocompresseur'], fn: 'Deux roues sur un même arbre : les gaz d\'échappement entraînent la turbine, qui comprime l\'air d\'admission.', domain: 'air', families: ['pump'] },
  intercooler: { label: 'Échangeur air/air', alts: ['intercooler', 'echangeur air/air'], fn: 'Refroidit l\'air comprimé, qui devient plus dense et donc plus riche en oxygène.', domain: 'air', families: ['exchanger'] },
  wastegate: { label: 'Soupape de décharge', alts: ['wastegate'], fn: 'Limite la pression de suralimentation en dérivant une partie des gaz autour de la turbine.', domain: 'air', families: ['valve'] },
  throttle: { label: 'Papillon des gaz', alts: ['papillon'], fn: 'Règle le débit d\'air admis, donc la charge du moteur.', domain: 'air', families: ['valve'] },
  // ------------------------------------------------------------ carburant
  fuelTank: { label: 'Réservoir', fn: 'Stocke le carburant à l\'abri de la chaleur.', domain: 'fuel', families: ['reservoir'] },
  fuelPump: { label: 'Pompe à carburant', alts: ['pompe a carburant'], fn: 'Met le carburant sous pression jusqu\'à la rampe d\'injection.', domain: 'fuel', families: ['pump'] },
  injector: { label: 'Injecteurs', alts: ['injecteur'], fn: 'Dosent et pulvérisent le carburant à un instant précis du cycle.', domain: 'fuel', families: ['valve'] },
  fuelRail: { label: 'Rampe d\'injection', alts: ['rampe d\'injection'], fn: 'Distribue le carburant sous pression vers chaque injecteur.', domain: 'fuel', families: ['duct'] },
  // --------------------------------------------------------- allumage/échapp.
  sparkPlug: { label: 'Bougies', alts: ['bougie'], fn: 'Produisent l\'étincelle qui enflamme le mélange comprimé.', domain: 'ignition', families: ['mechanical'] },
  coil: { label: 'Bobines d\'allumage', alts: ['bobine', 'bobines'], fn: 'Élèvent la tension de la batterie jusqu\'à plusieurs dizaines de milliers de volts.', domain: 'ignition', families: ['mechanical'] },
  exhaust: { label: 'Ligne d\'échappement', alts: ['echappement', 'collecteur d\'echappement'], fn: 'Évacue les gaz brûlés, dont la pression entraîne la turbine du turbo.', domain: 'exhaust', families: ['duct'] },
  catalyst: { label: 'Catalyseur', alts: ['pot catalytique'], fn: 'Transforme les gaz toxiques en composés moins nocifs.', domain: 'exhaust', families: ['filter'] },
  // ------------------------------------------------------- freinage/châssis
  brakePedal: { label: 'Pédale de frein', alts: ['pedale de frein', 'pedale'], fn: 'Point d\'entrée de la commande de freinage.', domain: 'brake', families: ['mechanical'] },
  masterCylinder: { label: 'Maître-cylindre', alts: ['maitre-cylindre', 'maitre cylindre'], fn: 'Transforme l\'effort de la pédale en pression hydraulique.', domain: 'brake', families: ['pump'] },
  caliper: { label: 'Étriers', alts: ['etrier', 'etriers'], fn: 'Transforment la pression hydraulique en effort de serrage sur les plaquettes.', domain: 'brake', families: ['mechanical'] },
  pads: { label: 'Plaquettes', alts: ['plaquette'], fn: 'Frottent le disque et convertissent l\'énergie cinétique en chaleur.', domain: 'brake', families: ['mechanical'] },
  disc: { label: 'Disques', alts: ['disque', 'disques de frein'], fn: 'Dissipent la chaleur du freinage ; sur une sportive, ils sont ventilés.', domain: 'brake', families: ['mechanical'] },
  absModule: { label: 'Bloc ABS', alts: ['bloc abs', 'groupe hydraulique'], fn: 'Module la pression de freinage roue par roue, par cycles d\'isolement et de décharge.', domain: 'brake', families: ['valve'] },
  absValve: { label: 'Électrovannes ABS', alts: ['electrovannes abs'], fn: 'Maintiennent ou relâchent la pression de chaque roue indépendamment.', domain: 'brake', families: ['valve'] },
  wheel: { label: 'Roues', alts: ['roue', 'roues motrices'], fn: 'Seul contact avec la route : toute action passe par leur adhérence.', domain: 'chassis', families: ['mechanical'] },
  wheelSensor: {
    label: 'Capteurs de vitesse de roue',
    alts: ['capteurs abs', 'capteur abs', 'capteurs de roue', 'capteur de roue'],
    fn: 'Un par roue : ils mesurent la vitesse de rotation, donc le patinage ou le blocage.',
    domain: 'sensor',
    families: ['sensor'],
  },
  yawSensor: { label: 'Capteur de lacet', alts: ['capteur de rotation'], fn: 'Mesure la rotation du véhicule autour de son axe vertical : il distingue un virage voulu d\'une dérive.', domain: 'sensor', families: ['sensor'] },
  steerAngle: { label: 'Capteur d\'angle de volant', alts: ['capteur d\'angle', 'angle de volant'], fn: 'Donne la direction voulue par le conducteur.', domain: 'sensor', families: ['sensor'] },
  torqueSensor: { label: 'Capteur de couple', alts: ['capteur de couple volant'], fn: 'Mesure l\'effort appliqué au volant pour doser l\'assistance.', domain: 'sensor', families: ['sensor'] },
  accelSensor: { label: 'Capteurs d\'accélération', alts: ['accelerometre', 'capteur d\'acceleration'], fn: 'Mesurent les accélérations longitudinales et latérales du véhicule.', domain: 'sensor', families: ['sensor'] },
  ecu: { label: 'Calculateur', alts: ['calculateur', 'unite de commande', 'module de commande'], fn: 'Reçoit les mesures, les compare à une consigne et commande les actionneurs.', domain: 'control', families: ['control'] },
  battery: { label: 'Batterie', fn: 'Fournit l\'énergie électrique de bord.', domain: 'electrical', families: ['source'] },
  // --------------------------------------------------------- direction
  steeringWheel: { label: 'Volant', fn: 'Point d\'entrée de la commande de direction.', domain: 'steering', families: ['mechanical'] },
  steeringColumn: { label: 'Colonne de direction', alts: ['colonne'], fn: 'Transmet la rotation du volant à la crémaillère ; l\'assistance s\'y insère.', domain: 'steering', families: ['mechanical'] },
  assistMotor: { label: 'Moteur d\'assistance', alts: ['moteur electrique d\'assistance', 'moteur assiste'], fn: 'Applique un couple qui s\'ajoute à celui du conducteur, sur la colonne ou sur la crémaillère.', domain: 'steering', families: ['assist'] },
  rack: { label: 'Crémaillère', alts: ['cremaillere'], fn: 'Convertit la rotation du volant en translation latérale, celle des biellettes.', domain: 'steering', families: ['mechanical'] },
  tieRod: { label: 'Biellettes de direction', alts: ['biellette', 'biellettes'], fn: 'Transmettent le mouvement de la crémaillère aux porte-fusées.', domain: 'steering', families: ['mechanical'] },
  steeredWheels: { label: 'Roues directrices', alts: ['roues directrices'], fn: 'S\'orientent pour changer la trajectoire : c\'est l\'effet visible de la chaîne.', domain: 'steering', families: ['mechanical'] },
  // --------------------------------------------------------- électrique
  inverter: { label: 'Onduleur', fn: 'Convertit le courant continu de la batterie en alternatif triphasé pour le moteur.', domain: 'ev', families: ['valve'] },
  electricMotor: { label: 'Moteur électrique', alts: ['moteur electrique'], fn: 'Convertit l\'énergie électrique en couple, avec un rendement élevé.', domain: 'ev', families: ['mechanical'] },
  tractionBattery: {
    label: 'Batterie haute tension',
    alts: ['batterie haute tension', 'batterie ht', 'batterie de traction', 'pack batterie'],
    fn: 'Réserve d\'énergie de traction : elle alimente le moteur électrique et se recharge au freinage par récupération.',
    domain: 'hybrid',
    families: ['source', 'electricSource'],
  },
  rearMotor: {
    label: 'Moteur électrique arrière',
    alts: ['moteur electrique arriere', 'machine electrique arriere', 'moteur arriere electrique'],
    fn: 'Machine électrique implantée sur l\'essieu arrière : elle entraîne les roues arrière indépendamment de la boîte thermique.',
    domain: 'hybrid',
    families: ['electricMotor', 'mechanical'],
  },
  regen: {
    label: 'Récupération d\'énergie',
    alts: ['recuperation d\'energie', 'recuperation d energie', 'freinage par recuperation', 'recuperation'],
    fn: 'Le moteur électrique fonctionne en générateur : il freine les roues et renvoie l\'énergie cinétique vers la batterie.',
    domain: 'hybrid',
    families: ['recovery'],
  },
  awd: {
    label: 'Transmission intégrale',
    alts: ['transmission integrale', '4matic', '4matic+', 'xdrive', 'quattro', 'quatre roues motrices'],
    fn: 'Répartit le couple entre les quatre roues. Sur cette architecture, le chemin thermique et le chemin électrique sont deux voies distinctes : elles ne se rejoignent pas dans un même carter, mais chacune entraîne son essieu.',
    domain: 'hybrid',
    families: ['mechanical', 'torqueSplit'],
  },
  gearbox: { label: 'Boîte de vitesses', alts: ['boite de vitesses', 'bva', 'mct', 'speedshift', 'transmission mct', 'boite mct', 'transmission speedshift'], fn: 'Adapte le régime moteur à la vitesse du véhicule.', domain: 'transmission', families: ['mechanical'] },
}

// Nom précis par domaine, pour les organes dont le nom dépend du système.
// Le libellé générique sert à RECONNAÎTRE ; celui-ci sert à AFFICHER.
export const DOMAIN_NAMING = {
  traction: { ecu: 'Calculateur de motricité', absModule: 'Bloc ABS / ESP', wheel: 'Roues motrices' },
  steering: { ecu: 'Calculateur de direction', assistMotor: 'Moteur d\'assistance', electricMotor: 'Moteur d\'assistance électrique' },
  braking: { ecu: 'Calculateur ABS', absModule: 'Bloc ABS' },
  cooling: { ecu: 'Calculateur de gestion moteur' },
  lubrication: { ecu: 'Calculateur de gestion moteur' },
  air: { ecu: 'Calculateur de gestion moteur' },
}

// Relations NORMALES entre FAMILLES de composants : squelette physique générique.
//   from/to : famille (voir `families` des composants)
//   flow    : type de flux transporté
export const LINKS = [
  { from: 'heatSource', to: 'fluid', flow: 'heat', label: 'chaleur cédée au fluide' },
  { from: 'pump', to: 'fluid', flow: 'fluid', label: 'met le fluide en mouvement' },
  { from: 'fluid', to: 'valve', flow: 'fluid', label: 'fluide vers la vanne' },
  { from: 'valve', to: 'exchanger', flow: 'fluid', label: 'débit régulé' },
  { from: 'fluid', to: 'exchanger', flow: 'fluid', label: 'fluide chaud' },
  { from: 'exchanger', to: 'air', flow: 'heat', label: 'chaleur évacuée' },
  { from: 'exchanger', to: 'fluid', flow: 'fluid', label: 'fluide refroidi, de retour' },
  { from: 'heatSource', to: 'sensor', flow: 'information', label: 'température mesurée' },
  { from: 'sensor', to: 'control', flow: 'information', label: 'mesure transmise' },
  { from: 'control', to: 'valve', flow: 'control', label: 'ouverture pilotée' },
  { from: 'control', to: 'pump', flow: 'control', label: 'débit commandé' },
  { from: 'fluid', to: 'heatSource', flow: 'fluid', label: 'retour au moteur' },
  { from: 'mechanical', to: 'fluid', flow: 'mechanical', label: 'entraîne' },
]

// Verbe de la question → intention. Sert à décider ce qu'il faut expliquer :
// une circulation, une régulation, ou un transfert.
export const INTENT_SIGNALS = [
  { id: 'regulation', re: /r[ée]gul\w*|maintien\w*|asservi\w*|corrige\w*|compense\w*|boucle/i },
  { id: 'transfer', re: /transmet\w*|converti\w*|transforme\w*|[ée]change\w*|dissipe\w*|absorbe\w*/i },
  { id: 'circulation', re: /circule\w*|circulation|d[ée]bit|parcours|trajet|s[ée]quence|[ée]tapes?|cycle/i },
]

// Formes nominalisées d'actions : « circulation du liquide », « détection du
// patinage », « réduction du couple » ne sont PAS des organes. Ce sont des
// RELATIONS. Les prendre pour des nœuds produisait des schémas faux
// (« Circulation du liquide » posé comme composant).
export const ACTION_HEADS =
  /^(circulation|detection|détection|reduction|réduction|echange|échange|freinage|regulation|régulation|commande|transmission|alimentation|refroidissement|lubrification|compression|detente|détente|admission|echappement|échappement|distribution|dosage|mesure|analyse|pilotage|assistance|multiplication|repartition|répartition)\b/i
