// Adaptateur de démonstration — UNIQUEMENT en développement (import.meta.env.DEV)
// et uniquement lorsque le backend réel (/api/supabase-config, /api/chat) est injoignable.
// Il permet de prévisualiser l'interface et de tester le chat sans backend.
// En production, isDemoAvailable() renvoie false : ce code n'a aucun effet.

import { planVisual } from './smart/plan'
import { extractEntities } from './smart/entities'

const DEMO_KEY = 'veyvro.demo.session'

export function isDemoAvailable() {
  try {
    return Boolean(import.meta.env?.DEV)
  } catch {
    return false
  }
}

function readSession() {
  try {
    const raw = localStorage.getItem(DEMO_KEY)
    return raw ? JSON.parse(raw) : null
  } catch {
    return null
  }
}

function writeSession(session) {
  try {
    if (session) localStorage.setItem(DEMO_KEY, JSON.stringify(session))
    else localStorage.removeItem(DEMO_KEY)
  } catch {
    /* stockage indisponible */
  }
}

function makeSession(email) {
  const id = 'demo-' + Math.abs(hashCode(email)).toString(36)
  return {
    access_token: 'demo-token-' + id,
    token_type: 'bearer',
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    user: {
      id,
      email,
      email_confirmed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
      user_metadata: { name: email.split('@')[0] },
    },
  }
}

function hashCode(str) {
  let h = 0
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0
  return h
}

export function createDemoClient() {
  let session = readSession()
  const listeners = new Set()
  const emit = (event) => listeners.forEach((cb) => cb(event, session))

  const auth = {
    async getSession() {
      return { data: { session }, error: null }
    },
    onAuthStateChange(callback) {
      listeners.add(callback)
      // Émission initiale asynchrone, comme Supabase.
      setTimeout(() => callback('INITIAL_SESSION', session), 0)
      return { data: { subscription: { unsubscribe: () => listeners.delete(callback) } } }
    },
    async signInWithPassword({ email, password }) {
      if (!email || !password) {
        return { data: null, error: { message: 'Invalid login credentials' } }
      }
      session = makeSession(String(email).trim().toLowerCase())
      writeSession(session)
      emit('SIGNED_IN')
      return { data: { session, user: session.user }, error: null }
    },
    async signUp({ email }) {
      // En démo, on connecte directement (pas d'e-mail réel).
      session = makeSession(String(email).trim().toLowerCase())
      writeSession(session)
      emit('SIGNED_IN')
      return { data: { session, user: session.user }, error: null }
    },
    async signOut() {
      session = null
      writeSession(null)
      emit('SIGNED_OUT')
      return { error: null }
    },
    async resend() {
      return { data: {}, error: null }
    },
  }
  return { auth, __demo: true }
}

const DEMO_RESPONSES = [
  `Bonne question — voici comment je raisonne côté automobile.\n\n**1. Le contexte.** Pour vous répondre précisément, j'aurais idéalement la marque, le modèle, l'année et le kilométrage. Mais je peux déjà vous donner une lecture claire.\n\n**2. Ce qu'il faut vérifier.**\n- L'historique d'entretien (factures, carnet).\n- Les points d'usure : freins, pneus, distribution.\n- Les voyants éventuels au tableau de bord.\n\n**3. Mon conseil.** Ne signez rien sans un essai routier et, pour une occasion, un contrôle indépendant. Un prix trop bas cache souvent une usure ou un historique flou.\n\nDonnez-moi le modèle exact et je vous fais une analyse détaillée.`,
  `Je peux vous aider à y voir clair. 🚗\n\nPour un **devis de garage**, regardez trois choses : la cohérence des prix pièce par pièce, la main-d'œuvre (taux horaire × temps), et les lignes floues (« divers », « forfait »). Demandez toujours le détail.\n\nPour un **voyant**, la couleur compte : rouge = arrêt immédiat, orange = surveillance rapide. Un voyant moteur orange peut aller d'un simple bouchon de réservoir mal fermé à un souci d'injection — un diagnostic OBD lève le doute.\n\nPour une **occasion**, croisez le prix avec la cote, vérifiez l'historique et méfiez-vous des vendeurs pressés.\n\nDites-moi votre cas précis et je creuse avec vous.`,
  `Voici une réponse structurée.\n\n**Comparaison.** Quand vous hésitez entre deux voitures, comparez le coût total de possession, pas seulement le prix d'achat : assurance, consommation, entretien, décote. Une allemande premium coûte souvent plus cher à entretenir qu'une généraliste bien équipée.\n\n**Fiabilité.** Les modèles récents sont globalement fiables, mais certains moteurs ont des points connus (chaîne de distribution, consommation d'huile, turbo). Je peux vous les citer pour un modèle précis.\n\n**Achat.** Négociez sur la base de faits : pneus à remplacer, révision proche, défauts constatés. Chaque élément chiffré est un argument.\n\nQuel modèle ou quelle situation voulez-vous que j'analyse ?`,
]

// Réponses de démonstration couvrant les formats Smart Responses.
// Elles servent uniquement à prévisualiser le rendu en développement.
const SMART_DEMO = {
  greeting: `Bonjour ! Ravi de vous retrouver. 🚗\n\nJe peux analyser un devis, expliquer un voyant ou comparer deux modèles. Dites-moi ce qui vous amène.`,


  electric: `## Voiture électrique ou essence ?

| Critère | Électrique | Essence |
| --- | --- | --- |
| Énergie / 100 km | 15–20 kWh | 5–8 L |
| Coût / 100 km | 3 à 6 € | 9 à 14 € |
| Entretien annuel | Faible | Plus élevé |
| Autonomie | 300–500 km | 600–900 km |
| Recharge | 20 min à 8 h | 5 min |

**À retenir.** L'électrique gagne sur le coût d'usage et l'entretien, l'essence sur la souplesse des longs trajets. Votre kilométrage annuel et votre accès à une borne décident du meilleur choix.`,

  html: `**HTML** est le langage qui structure une page web. Il décrit le contenu, pas son apparence.

\`\`\`html
<article class="voiture">
  <h2>Renault Clio</h2>
  <p>Compacte, 5 portes.</p>
  <a href="/essai">Réserver un essai</a>
</article>
\`\`\`

Les éléments clés :
- \`<article>\` regroupe un contenu autonome.
- \`<h2>\` donne un titre de niveau 2.
- \`<p>\` contient un paragraphe.
- \`<a>\` crée un lien, avec sa cible dans \`href\`.

Le CSS s'occupe ensuite du style, le JavaScript de l'interactivité.`,

  math: `Calculons la consommation réelle sur un trajet de 420 km avec 31,5 L utilisés.

**Formule.** Consommation aux 100 km :

$$C = \\frac{L \\times 100}{D}$$

**Étape 1 — on remplace :**

$$C = \\frac{31{,}5 \\times 100}{420}$$

**Étape 2 — on calcule :**

$$C = \\frac{3150}{420} = 7{,}5$$

Résultat : 7,5 L/100 km.`,

  wheel: `## Changer une roue en sécurité

1. **Immobilisez le véhicule** — sur sol plat et dur, frein à main serré, première vitesse engagée, triangle de signalisation placé.
2. **Débloque les écrous** — d'un quart de tour seulement, roue encore au sol, pour ne pas faire tourner le disque.
3. **Levez le véhicule** — cric au point de levage prévu par le constructeur, jusqu'à décoller la roue de 3 cm.
4. **Remplacez la roue** — retirez les écrous, montez la roue de secours, revissez à la main en croix.
5. **Reposez et serrez** — descendez le véhicule puis serrez au couple prescrit, souvent 110 à 130 Nm.

**Rappel.** Une roue de secours galette se limite généralement à 80 km/h. Faites contrôler le serrage après 50 km.`,

  chart: `Voici l'écart de coût d'usage sur 100 km, carburant et entretien compris.

\`\`\`veyvro
{"type":"chart","variant":"bar","title":"Coût aux 100 km","unit":"€","series":[
 {"label":"Électrique","points":[{"x":"Citadine","y":3.2},{"x":"Compacte","y":4.1},{"x":"Berline","y":5.0},{"x":"SUV","y":6.4}]},
 {"label":"Essence","points":[{"x":"Citadine","y":9.1},{"x":"Compacte","y":10.8},{"x":"Berline","y":12.5},{"x":"SUV","y":15.2}]}
]}
\`\`\`

Survolez une barre pour la valeur exacte. L'écart se creuse avec le gabarit du véhicule.`,

  creative: `**Trois accroches pour votre garage**

1. *La transparence, pièce par pièce.* Chaque devis détaillé, chaque euro expliqué.
2. *Votre voiture mérite mieux qu'un forfait flou.* Ici, on vous montre tout.
3. *Réparé juste. Facturé juste.*

Dites-moi le ton souhaité — plus sobre, plus chaleureux ou plus technique — et j'ajuste.`,
  // --- V3 : réponses à visuels riches -------------------------------------
  solar: `Le système solaire s'est formé il y a environ 4,6 milliards d'années à partir d'un nuage de gaz et de poussière.

\`\`\`veyvro
{"type":"diagram","title":"L'organisation du système solaire","root":{"id":"sun","label":"Le Soleil","detail":"Une étoile qui concentre 99,8 % de la masse du système et maintient tout en orbite.","children":[{"id":"inner","label":"Planètes rocheuses","detail":"Mercure, Vénus, la Terre et Mars : petites, denses, proches du Soleil.","children":[{"id":"earth","label":"La Terre","detail":"La seule planète connue abritant la vie. Orbitée par la Lune."}]},{"id":"outer","label":"Géantes gazeuses","detail":"Jupiter, Saturne, Uranus et Neptune : volumineuses et éloignées.","children":[{"id":"saturn","label":"Saturne","detail":"Célèbre pour ses anneaux de glace et de roche."}]},{"id":"small","label":"Petits corps","detail":"Astéroïdes, comètes et planètes naines comme Pluton."}]}}
\`\`\`

**Le Soleil** représente à lui seul 99,8 % de la masse totale. Les quatre planètes internes sont rocheuses, les quatre externes sont des géantes.

**Les orbites** sont quasi circulaires et coplanaires : c'est un vestige du disque de poussière initial.`,

  atmosphere: `L'atmosphère terrestre est une enveloppe de gaz retenue par la gravité, organisée en couches selon la température.

\`\`\`veyvro
{"type":"layers","title":"Les couches de l'atmosphère","items":[{"label":"Troposphère","value":"0 – 12 km","detail":"C'est là que se produisent la météo, les nuages et la majorité de la vapeur d'eau."},{"label":"Stratosphère","value":"12 – 50 km","detail":"Elle contient la couche d'ozone qui filtre les rayons ultraviolets. Les avions de ligne y volent."},{"label":"Mésosphère","value":"50 – 85 km","detail":"La température y chute jusqu'à −90 °C. Les météorites y brûlent et deviennent des étoiles filantes."},{"label":"Thermosphère","value":"85 – 600 km","detail":"Températures très élevées mais gaz raréfiés. Aurores polaires et orbite de la Station spatiale."},{"label":"Exosphère","value":"au-delà de 600 km","detail":"Limite où l'atmosphère se fond dans l'espace. Les satellites y circulent."}]}
\`\`\`

**La pression** diminue avec l'altitude : elle est divisée par deux dès 5 500 m. C'est pourquoi les avions volent haut, là où l'air est plus fin et la traînée plus faible.`,

  engine: `Un moteur électrique convertit l'énergie électrique en énergie mécanique grâce à l'interaction entre un champ magnétique et des courants.

\`\`\`veyvro
{"type":"concept","title":"Les organes d'un moteur électrique","nodes":[{"id":"battery","label":"Batterie","detail":"Fournit le courant continu sous une tension donnée."},{"id":"controller","label":"Contrôleur","detail":"Module l'énergie : fréquence et intensité déterminent la vitesse et le couple."},{"id":"stator","label":"Stator","detail":"Bobines fixes qui créent un champ magnétique tournant."},{"id":"rotor","label":"Rotor","detail":"Aimants qui suivent le champ tournant et entraînent l'arbre moteur."},{"id":"gear","label":"Transmission","detail":"Réduit la vitesse de rotation et transmet la force aux roues."}],"edges":[{"from":"battery","to":"controller","label":"alimente"},{"from":"controller","to":"stator","label":"commande"},{"from":"stator","to":"rotor","label":"entraîne"},{"from":"rotor","to":"gear","label":"transmet"}]}
\`\`\`

**Le principe** repose sur la force de Laplace : un conducteur parcouru par un courant dans un champ magnétique subit une force. En alternant le courant, on obtient une rotation continue.

**L'avantage** décisif est le couple maximal disponible dès le démarrage, sans embrayage ni boîte de vitesses complexe.`,

  ai: `Une intelligence artificielle moderne est un modèle statistique entraîné sur d'énormes volumes de données.

\`\`\`veyvro
{"type":"diagram","title":"Comment fonctionne une IA","root":{"id":"data","label":"Données d'entraînement","detail":"Textes, images, sons : la matière première, nettoyée et mise en forme.","children":[{"id":"model","label":"Modèle (réseau de neurones)","detail":"Des millions de paramètres ajustés automatiquement par calcul de gradient.","children":[{"id":"layers","label":"Couches de calcul","detail":"Chaque couche transforme la représentation : des traits aux concepts."},{"id":"weights","label":"Paramètres","detail":"Les valeurs apprises, figées après l'entraînement."}]},{"id":"infer","label":"Inférence","detail":"Le modèle produit une réponse, mot après mot, à partir du prompt."},{"id":"eval","label":"Évaluation","detail":"Mesure de la qualité : un mauvais score renvoie à l'entraînement."}]}}
\`\`\`

**L'entraînement** ajuste les paramètres pour minimiser l'écart entre la sortie du modèle et la réponse attendue. Cette phase consomme l'essentiel de la puissance de calcul.

**L'inférence**, elle, est beaucoup plus légère : c'est le calcul effectué à chaque question posée.`,

  cell: `La cellule est l'unité de base du vivant : elle contient tout ce qui est nécessaire à son fonctionnement.

\`\`\`veyvro
{"type":"concept","title":"Les organites d'une cellule","nodes":[{"id":"nucleus","label":"Noyau","detail":"Contient l'ADN, programme de fonctionnement de la cellule."},{"id":"mito","label":"Mitochondries","detail":"Produisent l'énergie (ATP) par respiration cellulaire."},{"id":"er","label":"Réticulum endoplasmique","detail":"Fabrique et achemine protéines et lipides."},{"id":"golgi","label":"Appareil de Golgi","detail":"Trie et expédie les protéines vers leur destination."},{"id":"membrane","label":"Membrane plasmique","detail":"Frontière sélective : elle contrôle les échanges avec l'extérieur."}],"edges":[{"from":"nucleus","to":"er","label":"instructions"},{"from":"er","to":"golgi","label":"protéines"},{"from":"mito","to":"nucleus","label":"énergie"},{"from":"membrane","to":"nucleus","label":"protège"}]}
\`\`\`

**Chaque organite** a un rôle précis et complémentaire : le noyau dirige, les mitochondries fournissent l'énergie, le réticulum et le Golgi fabriquent et expédient les protéines.`,

  energy: `La production mondiale d'électricité reste dominée par les énergies fossiles, malgré la progression rapide du solaire et de l'éolien.

\`\`\`veyvro
{"type":"pie","title":"Répartition indicative des sources d'électricité","unit":"%","slices":[{"label":"Fossiles","value":60},{"label":"Hydraulique","value":15},{"label":"Nucléaire","value":9},{"label":"Éolien","value":8},{"label":"Solaire","value":8}]}
\`\`\`

**La tendance** est nette : le solaire photovoltaïque est la source qui progresse le plus vite, portée par la baisse des coûts des panneaux.`,

  python: `Voici une fonction Python qui calcule une moyenne, avec gestion du cas vide.

\`\`\`python
def moyenne(valeurs: list[float]) -> float:
    """Retourne la moyenne d'une liste de nombres."""
    if not valeurs:
        raise ValueError("La liste ne peut pas être vide")
    return sum(valeurs) / len(valeurs)


notes = [12, 15, 9, 18]
print(f"Moyenne : {moyenne(notes):.2f}")  # 13.50
\`\`\`

**Point d'attention** : diviser par zéro lève une exception. Le test \`if not valeurs\` protège la fonction et rend l'erreur explicite plutôt que silencieuse.`,

  equation: `Résolvons l'équation étape par étape.

\`\`\`veyvro
{"type":"steps","title":"Résolution de 3x + 7 = 22","steps":[{"title":"Isoler le terme en x","detail":"On soustrait 7 de chaque côté : 3x = 22 − 7"},{"title":"Simplifier","detail":"3x = 15"},{"title":"Diviser par 3","detail":"x = 15 / 3"},{"title":"Vérifier","detail":"3 × 5 + 7 = 22 ✓"}]}
\`\`\`

La solution est $x = 5$. On peut toujours vérifier en remplaçant x par sa valeur dans l'équation d'origine.`,


  evCar: `Une voiture électrique convertit l'énergie chimique de sa batterie en mouvement, puis récupère une partie de cette énergie au freinage.

\`\`\`veyvro
{"type":"system","title":"Chaîne de traction d'une voiture électrique","nodes":[{"id":"battery","label":"Batterie","detail":"Réserve d'énergie chimique sous forme de courant continu (200 à 800 V selon le modèle). Sa capacité en kWh détermine l'autonomie.","tier":"source"},{"id":"bms","label":"Gestion batterie","detail":"Surveille tension et température de chaque cellule, équilibre les charges et protège le pack en coupant le courant si nécessaire.","tier":"control"},{"id":"inverter","label":"Onduleur","detail":"Convertit le courant continu de la batterie en courant alternatif triphasé, dont il règle la fréquence pour piloter la vitesse du moteur.","tier":"power"},{"id":"motor","label":"Moteur électrique","detail":"Convertit l'énergie électrique en énergie mécanique grâce au champ magnétique tournant du stator qui entraîne le rotor.","tier":"power"},{"id":"transmission","label":"Transmission","detail":"Réducteur à rapport fixe, parfois complété d'un différentiel : adapte la vitesse de rotation du moteur à celle des roues et répartit le couple.","tier":"mechanical"},{"id":"wheels","label":"Roues","detail":"Seul contact avec la route : c'est là que le couple devient mouvement.","tier":"mechanical"},{"id":"regen","label":"Freinage régénératif","detail":"Le moteur fonctionne en générateur : il freine les roues et renvoie l'énergie cinétique vers la batterie en repassant par l'onduleur.","tier":"recovery"}],"edges":[{"from":"battery","to":"inverter","label":"courant continu","flow":"energy"},{"from":"bms","to":"battery","label":"surveille","flow":"control"},{"from":"bms","to":"inverter","label":"autorise","flow":"control"},{"from":"inverter","to":"motor","label":"courant alternatif","flow":"energy"},{"from":"motor","to":"transmission","label":"couple","flow":"mechanical"},{"from":"transmission","to":"wheels","label":"rotation","flow":"mechanical"},{"from":"wheels","to":"regen","label":"inertie","flow":"mechanical"},{"from":"regen","to":"inverter","label":"énergie récupérée","flow":"recovery"},{"from":"inverter","to":"battery","label":"recharge","flow":"recovery"}],"notes":["Flux d'énergie (violet) : de la batterie vers les roues.","Signaux de commande (bleu pointillé) : ils pilotent sans transporter d'énergie.","Au freinage, le flux s'inverse : les roues entraînent le moteur, qui recharge la batterie (vert)."]}
\`\`\`

**Le rendement** d'une chaîne électrique atteint 85 à 90 %, contre 25 à 35 % pour un moteur thermique : l'essentiel de l'énergie est transmis aux roues plutôt que perdu en chaleur.

**Le freinage régénératif** restitue jusqu'à 25 % de l'énergie consommée en ville, ce qui explique la consommation plus faible en usage urbain qu'autoroutier.`,

  iceEngine: `Un moteur à combustion interne transforme l'énergie chimique du carburant en énergie mécanique. Le cycle se déroule en quatre temps, soit deux tours de vilebrequin.

\`\`\`veyvro
{"type":"cycle","title":"Moteur à combustion interne à quatre temps","cycleName":"Cycle de Beau de Rochas (quatre temps)","phases":[{"number":1,"name":"Admission","state":"admission","piston":"Descend : du PMH vers le PMB","valves":"Admission ouverte, échappement fermée","detail":"Le piston descend et crée une dépression : le mélange air-carburant est aspiré dans le cylindre par la soupape d'admission.","media":"Air + carburant"},{"number":2,"name":"Compression","state":"compression","piston":"Monte : du PMB vers le PMH","valves":"Les deux soupapes fermées","detail":"Les soupapes se ferment et le piston remonte : le mélange est comprimé jusqu'à environ 1/10 de son volume initial (rapport volumétrique 10:1).","media":"Mélange comprimé"},{"number":3,"name":"Combustion et détente","state":"detente","piston":"Redescend : du PMH vers le PMB","valves":"Les deux soupapes fermées","detail":"La bougie enflamme le mélange juste avant le PMH. La pression des gaz brûlants repousse le piston : c'est le seul temps qui fournit du travail.","media":"Gaz brûlants"},{"number":4,"name":"Échappement","state":"echappement","piston":"Remonte : du PMB vers le PMH","valves":"Échappement ouverte, admission fermée","detail":"La soupape d'échappement s'ouvre et le piston remonte pour chasser les gaz brûlés vers l'échappement.","media":"Gaz brûlés"}],"parts":{"caption":"Chaîne cinématique : la pression des gaz pousse le piston, la bielle transforme ce mouvement rectiligne en rotation du vilebrequin.","nodes":[{"id":"spark","label":"Bougie","detail":"Produit l'étincelle qui enflamme le mélange, quelques degrés avant le point mort haut en fin de compression.","col":0,"row":0},{"id":"in-valve","label":"Soupape d'admission","detail":"S'ouvre pendant le 1er temps pour laisser entrer le mélange air-carburant.","col":1,"row":0},{"id":"ex-valve","label":"Soupape d'échappement","detail":"S'ouvre pendant le 4e temps pour évacuer les gaz brûlés.","col":3,"row":0},{"id":"piston","label":"Piston","detail":"Pièce mobile du cylindre : il descend en admission, remonte en compression, est repoussé en détente et remonte en échappement.","col":2,"row":2},{"id":"rod","label":"Bielle","detail":"Relie le piston au vilebrequin et transforme le mouvement rectiligne alternatif en rotation.","col":2,"row":3},{"id":"crank","label":"Vilebrequin","detail":"Convertit le mouvement de la bielle en rotation continue, transmise ensuite à la boîte de vitesses.","col":3,"row":4},{"id":"cylinder","label":"Cylindre","detail":"Volume fermé où se déroulent les quatre temps ; sa paroi guide le piston.","col":2,"row":1}],"edges":[{"from":"in-valve","to":"cylinder","label":"mélange admis","flow":"gas"},{"from":"cylinder","to":"ex-valve","label":"gaz évacués","flow":"gas"},{"from":"spark","to":"cylinder","label":"étincelle","flow":"ignition"},{"from":"cylinder","to":"piston","label":"pression des gaz","flow":"energy"},{"from":"piston","to":"rod","label":"poussée axiale","flow":"mechanical"},{"from":"rod","to":"crank","label":"couple moteur","flow":"mechanical"},{"from":"crank","to":"piston","label":"mouvement de retour","flow":"mechanical"}]},"notes":["Un cycle complet du piston correspond à exactement deux tours de vilebrequin (720°).","Sur les quatre temps, un seul produit du travail : la combustion-détente. Les trois autres sont des temps résistants, entraînés par l'inertie du volant moteur.","La distribution (arbre à cames) ouvre et ferme les soupapes en synchronisation avec la position du piston."]}\n\`\`\`

**Le principe** : la pression des gaz de combustion pousse un piston. La bielle transforme ce mouvement rectiligne alternatif en rotation continue du vilebrequin.

**Un seul temps moteur** : sur les quatre temps, seule la combustion-détente fournit du travail. L'admission, la compression et l'échappement sont des temps résistants, absorbés par l'inertie du volant moteur.

**La distribution** : un arbre à cames, entraîné par le vilebrequin à mi-vitesse, ouvre et ferme les soupapes au bon moment du cycle.`,

}

// Gabarits de contenu de la démonstration. Ils répondent aux demandes de
// PRODUCTION (rédiger, calculer, comparer, tutorer) et servent de repli quand
// le moteur visuel ne connaît pas le sujet.
//
// Deux gardes ajoutées ici, car c'est cette fonction qui envoyait une question
// de freinage sur « Changer une roue en sécurité » :
//   1. `dominant()` — un gabarit ne capte plus une question par un mot isolé,
//      noyé dans une longue question technique ;
//   2. aucune route de TUTORIEL (« changer une roue », « étapes ») ne s'applique
//      à une question de compréhension.
const TUTORIAL_ONLY = /^(?![\s\S]*(?:comment fonctionne|explique|fonctionnement|pourquoi|d[ée]cris|qu'est-ce))/i

function wordShare(lower, word) {
  const words = lower.split(/[^a-zàâäéèêëîïôöùûüç0-9]+/i).filter(Boolean)
  if (!words.length) return 0
  const hits = words.filter((w) => w === word).length
  return hits / words.length
}

const dominant = (lower, word) => wordShare(lower, word) >= 0.05

// Un gabarit ne doit se déclencher que sur un MOT, jamais sur un fragment.
// Défaut réel observé : « calc**ulateur** » contenait « calcul » et une question
// de contrôle de traction recevait un exercice de consommation. Toutes les
// routes ci-dessous passent donc par cette correspondance sur mot entier.
const wordRe = (term) => new RegExp(`(^|[^a-zà-ÿ0-9])${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-zà-ÿ0-9]|$)`, 'i')
const hasWord = (text, term) => wordRe(term).test(text)
const hasAnyWord = (text, terms) => terms.some((t) => hasWord(text, t))

function templateResponse(lower) {
  const isUnderstanding = /comment fonctionne|explique|fonctionnement|pourquoi|d[ée]cris|qu'est-ce/.test(lower)
  if (/^(salut|bonjour|bonsoir|hello|hi|hey|coucou)\b/.test(lower)) return SMART_DEMO.greeting
  if (hasWord(lower, 'python')) return SMART_DEMO.python
  if (hasAnyWord(lower, ['équation', 'equation']) || /\d+x\s*[+-]/.test(lower)) return SMART_DEMO.equation
  if (hasAnyWord(lower, ['solaire', 'système solaire', 'systeme solaire'])) return SMART_DEMO.solar
  if (hasAnyWord(lower, ['atmosphère', 'atmosphere'])) return SMART_DEMO.atmosphere
  if (hasAnyWord(lower, ['intelligence artificielle', 'réseau neuronal', 'reseau neuronal', 'diagramme'])) return SMART_DEMO.ai
  if (hasWord(lower, 'cellule')) return SMART_DEMO.cell
  // Moteur à combustion interne : AVANT les règles « moteur » et « voiture
  // électrique », sinon « moteur à combustion » serait pris pour un moteur
  // électrique.
  // Deuxième garde de la même famille : les pièces du moteur thermique ne
  // suffisent plus à elles seules. Une question de freinage qui mentionne « les
  // étriers serrent le disque » ou un contrôle de traction qui « freine une
  // roue » ne doit pas recevoir le cycle à quatre temps.
  const BRAKE_CONTEXT = /[ée]triers?|disques? de frein|plaquettes?|ma[îi]tre[- ]cylindre|contr[ôo]le de traction|[ée]lectrovanne/i
  if (
    /combustion|quatre[- ]temps|4[- ]temps|moteur thermique|beau de rochas/.test(lower) ||
    (/vilebrequin|bielle|soupape|piston/.test(lower) && !BRAKE_CONTEXT.test(lower))
  ) {
    return SMART_DEMO.iceEngine
  }

  // Voiture électrique complète : AVANT la règle « moteur », mais jamais pour
  // une question comparative (« compare électrique et essence »), qui doit
  // rester un tableau comparatif.
  const isComparison = /compar|versus|\bvs\b|diff[ée]rence|avantage|inconv[ée]nient|mieux qu/.test(lower)
  const isEvCar = (lower.includes('voiture') || lower.includes('véhicule') || lower.includes('vehicule')) && lower.includes('électrique')
  const isEvPart = /onduleur|freinage r[ée]g[ée]n[ée]ratif/.test(lower)
  if (!isComparison && (isEvCar || isEvPart)) return SMART_DEMO.evCar
  if (hasWord(lower, 'html')) return SMART_DEMO.html
  if (hasAnyWord(lower, ['graphique', 'graph']) || (hasWord(lower, 'consommation') && hasAnyWord(lower, ['coût', 'cout']))) return SMART_DEMO.chart
  // « calcul », « calculer »… mais PAS « calculateur » : la correspondance sur
  // mot entier l'exclut désormais, et une question de mécanisme ne tombe plus
  // sur un exercice de consommation.
  if (
    hasAnyWord(lower, [
      'calcul', 'calculs', 'calculer', 'calcule', 'calculez', 'calculons', 'combien',
    ])
  ) {
    return SMART_DEMO.math
  }
  // Route de TUTORIEL : jamais sur une question de compréhension, et seulement
  // quand le mot-clé est réellement dominant dans la demande.
  if (!isUnderstanding && TUTORIAL_ONLY.test(lower) && (dominant(lower, 'roue') || dominant(lower, 'pneu') || /tutoriel|^comment changer|^changer\b/.test(lower))) {
    return SMART_DEMO.wheel
  }
  if (hasAnyWord(lower, ['renouvelable', 'renouvelables', 'énergie', 'energie', 'électricité', 'electricite'])) return SMART_DEMO.energy
  // Comparatif électrique vs thermique : avant tout autre motif « électrique ».
  if ((lower.includes('électrique') || lower.includes('electrique')) && (lower.includes('thermique') || lower.includes('essence') || lower.includes('compare') || lower.includes('comparaison'))) return SMART_DEMO.electric
  if (hasAnyWord(lower, ['accroche', 'slogan', 'poème', 'écris'])) return SMART_DEMO.creative
  if (hasAnyWord(lower, ['devis', 'facture', 'garage'])) return DEMO_RESPONSES[1]
  if (hasAnyWord(lower, ['comparer', 'comparaison', 'compare', 'battle', 'choisir'])) return DEMO_RESPONSES[2]
  return null
}

// Une question « comment ça marche / explique » ne doit JAMAIS tomber sur un
// contenu pré-écrit thématiquement voisin. C'était la cause du symptôme
// « freinage d'une Porsche 911 GT3 » → « Changer une roue en sécurité » :
// la question contient « roue », la route figée `roue|pneu` l'attrapait, et le
// moteur visuel n'était même pas consulté.
const UNDERSTANDING = /\b(?:comment|explique\w*|pourquoi|d[ée]cris|d[ée]taille\w*|d[ée]tailler|fonctionne\w*|fonctionnement|qu'est-ce que|c'est quoi|r[ôo]le|principes?)\b/i

function pickResponse(messages) {
  const last = [...messages].reverse().find((m) => m.role === 'user')?.content ?? ''
  const lower = last.toLowerCase().trim()

  // --- Routage : le MOTEUR décide d'abord, les gabarits ensuite -------------
  //
  // Avant, chaque route figée testait son mot-clé avant de savoir si la
  // question relevait d'un autre domaine : « freinage … roue » partait sur le
  // tutoriel de changement de roue. Désormais :
  //   1. une question de COMPRÉHENSION est traitée par le moteur visuel ;
  //   2. ses gabarits de contenu ne sont utilisés que si le moteur ne sait rien
  //      produire pour ce sujet ;
  //   3. un gabarit ne capte plus une question par un mot isolé : il faut que
  //      le mot-clé soit dominant dans la question (voir wordShare).
  const planned = planVisual(last)
  if (planned) return structuredResponse(last)
  if (UNDERSTANDING.test(last)) {
    // Aucun visuel : plutôt qu'un gabarit hors sujet, une explication honnête.
    const known = templateResponse(lower)
    if (known !== null) return known
    return fallbackText(last)
  }

  const known = templateResponse(lower)
  if (known !== null) return known
  // Plus de repli aléatoire : la réponse est construite à partir du visuel
  // planifié pour CETTE question, ce qui garantit un contenu propre à chaque
  // demande au lieu d'un texte générique tiré au sort.
  return structuredResponse(last)
}


// Réponse de démonstration du trajet réseau. Le texte est rédigé ici (rôle de la
// démo), mais le SCHÉMA n'est PAS écrit à la main : il est demandé au moteur de
// planification, qui choisit le type d'après la structure de la question.
// Avant correction, cette réponse contenait un bloc veyvro figé de type « flow » :
// même en réparant plan.js, la démo continuait d'imposer sa structure.
// Réponse de démonstration GÉNÉRIQUE.
//
// Avant : une liste de réponses rédigées à la main, et un repli aléatoire
// (`DEMO_RESPONSES[hash % n]`). Deux questions automobiles différentes
// recevaient donc le MÊME texte, et aucune ne recevait de schéma — alors que le
// moteur de planification savait produire le bon visuel. C'était la source
// visible du symptôme « VEYVRO répète la même réponse ».
//
// Désormais : le texte est construit à partir du visuel réellement planifié
// pour CETTE question (titre, éléments, notes), et le schéma vient du moteur.
function structuredResponse(question) {
  const spec = planVisual(question)
  const block = spec
    ? '\n\n\`\`\`veyvro\n' + JSON.stringify(stripStructure(spec)) + '\n\`\`\`\n'
    : ''
  if (!spec) {
    // Aucun visuel pertinent : on ne fabrique pas de schéma. Une question de
    // compréhension reçoit une explication honnête, pas un texte de remplissage.
    return fallbackText(question)
  }

  // Schéma construit par le RAISONNEUR : la question porte sur un mécanisme
  // dont on connaît les organes et les relations. L'explication suit alors le
  // trajet réel (chaîne des arcs), pas une liste de composants.
  if (spec.reasoned && spec.edges?.length) {
    return `${reasonedNarrative(spec)}${block}`
  }

  // Résumé textuel dérivé du visuel : même contenu, donc cohérence garantie
  // entre l'explication et le schéma.
  const items = spec.nodes ?? spec.steps ?? spec.items ?? spec.phases ?? []
  const labels = items.slice(0, 5).map((it) => it.label ?? it.name ?? it.title).filter(Boolean)
  const intro = labels.length
    ? `${spec.title}. Les éléments qui comptent ici : ${labels.join(', ')}.`
    : `${spec.title}.`
  // Pas de reprise des notes ici : le schéma les affiche déjà. Les répéter en
  // texte produisait un doublon visible sous le diagramme.
  return `${intro}${block}`
}

// Explication de repli — SANS schéma.
//
// Principe produit : si le moteur ne sait pas dessiner le mécanisme demandé, il
// vaut mieux une explication correcte et une phrase d'honnêteté qu'un schéma
// générique présenté comme la réponse. C'est ce que cette fonction produit.
//
// Elle ne prétend pas traiter le détail technique : elle nomme les éléments
// reconnus dans la question (vocabulaire du moteur d'entités) et indique
// comment obtenir une réponse spécialisée. Le contenu reste donc propre à la
// question posée — jamais un texte recyclé d'un autre sujet.
export function fallbackText(question) {
  const asked = extractEntities(question).map((e) => e.label)
  const subject = String(question ?? '').trim().replace(/\s+/g, ' ')
  const short = subject.length > 140 ? subject.slice(0, 137) + '…' : subject
  const list = asked.length
    ? `J'ai identifié dans votre question : ${asked.join(', ')}.`
    : `Je n'ai pas reconnu de composant technique nommé dans votre question.`
  return `**${short}**

${list}

Je ne dispose pas encore d'un schéma spécialisé pour ce mécanisme précis, et je préfère vous le dire plutôt que d'afficher un schéma générique qui ne le représenterait pas.

**Ce que je peux faire tout de suite :** décomposer le fonctionnement organe par organe (rôle, entrée, sortie, lien avec les autres), expliquer la chaîne d'énergie ou la boucle de commande, puis illustrer la partie que vous voulez détailler — freinage, ABS, suspension, moteur, transmission, ou un autre système.

**Pour aller plus loin :** précisez le véhicule et le sous-système (par exemple « circuit hydraulique », « capteurs de roue », « électrovannes ») : la réponse et le schéma seront alors construits pour ce sous-système.`
}


// Explication d'un mécanisme, dérivée du graphe raisonné.
//
// Principe : on ne raconte pas une liste d'organes, on suit le TRAJET. Le texte
// est produit à partir des mêmes nœuds et des mêmes arcs que le schéma, donc
// les deux ne peuvent pas diverger. Les fonctions viennent du catalogue
// (`mechanics.js`) ; aucune valeur chiffrée n'est inventée.
function reasonedNarrative(spec) {
  const byId = new Map(spec.nodes.map((n) => [n.id, n]))
  const label = (id) => byId.get(id)?.label ?? id
  const detail = (id) => (byId.get(id)?.detail ?? '').replace(/\s+/g, ' ').trim()

  // Chaîne principale = suite d'arcs de matière/mécanique, dans l'ordre.
  const mainFlows = new Set(['fluid', 'mechanical', 'energy', 'gas', 'ignition'])
  const main = spec.edges.filter((e) => mainFlows.has(e.flow))
  const info = spec.edges.filter((e) => e.flow === 'information' || e.flow === 'control')
  const heat = spec.edges.filter((e) => e.flow === 'heat')

  const chain = []
  for (const e of main) {
    if (!chain.length) chain.push(e.from)
    chain.push(e.to)
  }
  const pathLabels = [...new Set(chain)].map(label)

  const lines = []
  lines.push(`**${spec.title}**`)
  lines.push('')
  if (pathLabels.length >= 2) {
    lines.push(`Le trajet, dans l'ordre : ${pathLabels.join(' → ')}.`)
    lines.push('')
  }

  // Une phrase par étape, à partir de la fonction réelle de chaque organe.
  for (const id of [...new Set(chain)]) {
    const d = detail(id)
    if (d) lines.push(`**${label(id)}** — ${d}`)
  }

  if (info.length) {
    lines.push('')
    lines.push('**La boucle de régulation.**')
    for (const e of info) {
      lines.push(`- ${label(e.from)} → ${label(e.to)} : ${e.label}`)
    }
  }

  if (heat.length) {
    lines.push('')
    lines.push('**Le transfert thermique.**')
    for (const e of heat) lines.push(`- ${label(e.from)} → ${label(e.to)} : ${e.label}`)
  }

  const added = spec.nodes.filter((n) => n.added)
  if (added.length) {
    lines.push('')
    lines.push(
      `*Complément apporté par VEYVRO, absent de votre question : ${added.map((n) => n.label).join(', ')}.*`
    )
  }
  return lines.join('\n')
}

// Retire les champs internes de diagnostic avant de sérialiser le bloc affiché.
function stripStructure(spec) {
  const {
    structure,
    coverage,
    missingEntities,
    reasoned,
    reasonedCoverage,
    representedActions,
    ...rest
  } = spec
  return rest
}

// Simule le streaming SSE du vrai /api/chat, avec le même contrat de callbacks.
export async function demoStreamChat(messages, onDelta, { signal } = {}) {
  const text = pickResponse(messages)
  const chunks = text.match(/[\s\S]{1,18}/g) ?? [text]
  await new Promise((r) => setTimeout(r, 450))
  for (const chunk of chunks) {
    if (signal?.aborted) {
      const err = new Error('Aborted')
      err.name = 'AbortError'
      throw err
    }
    onDelta(chunk)
    await new Promise((r) => setTimeout(r, 24))
  }
}
