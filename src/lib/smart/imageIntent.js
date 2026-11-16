// Détection d'une demande de génération d'image dans le message utilisateur.
// Objectif : déclencher une vraie génération uniquement quand l'utilisateur
// demande explicitement une image — jamais pour une question simple (test 13).

const MAX_PROMPT = 500

// Deux familles de verbes :
//  - STRICT : le verbe est ambigu (générer/créer un diagramme…), le nom
//    « image » est donc OBLIGATOIRE pour éviter les faux positifs.
//  - LOOSE : le verbe est intrinsèquement visuel (illustrer, dessiner),
//    le nom peut être omis (« Illustre le système solaire »).
const IMAGE_NOUN = "(?:image|illustration|dessin|photo|visuel|picture|drawing|artwork|affiche|poster)"
const PREP = "(?:de\\s+|d['’]\\s*|of\\s+|pour\\s+|représentant\\s+|representing\\s+|montrant\\s+)?"
const ARTICLE = "(?:une\\s+|un\\s+|des\\s+|la\\s+|le\\s+)?"

const STRICT_RE = new RegExp(
  "^(?:peux-tu\\s+|pourrais-tu\\s+|stp\\s+|s'il te plaît\\s+)?" +
  "(?:génère|genere|générer|generer|crée|cree|créer|creer|fais|faire|produis|produire|generate|create|make)(?:-moi|\\s+moi)?" +
  "\\s+" + ARTICLE + IMAGE_NOUN + "\\s+" + PREP + "(.+)$",
  'i'
)
const LOOSE_RE = new RegExp(
  "^(?:peux-tu\\s+|pourrais-tu\\s+|stp\\s+)?" +
  "(?:illustre|illustrer|dessine|dessiner|draw|illustrate)(?:-moi|\\s+moi)?" +
  "\\s+" + ARTICLE + IMAGE_NOUN + "?\\s*" + PREP + "(.+)$",
  'i'
)

// « Montre-moi une représentation / un rendu de X » : demande de visuel.
const SHOW_RE = new RegExp(
  "^(?:peux-tu\\s+|pourrais-tu\\s+)?montre(?:-moi|\\s+moi)\\s+(?:une\\s+|un\\s+)?" +
  "(?:représentation|representation|rendu|aperçu|apercu|vue)\\s+" + PREP + "(.+)$",
  'i'
)

// « une image de X » sans verbe, en début de message.
const BARE_IMAGE_RE = new RegExp("^(?:une\\s+image|un\\s+visuel|une\\s+illustration)\\s+" + PREP + "(.+)$", 'i')

const ASPECTS = [
  { re: /\bpaysage\b|\blandscape\b|\bpanoramique\b/i, width: 1024, height: 576 },
  { re: /\bportrait\b|\bvertical\b/i, width: 576, height: 1024 },
  { re: /\bcarr[ée]e?\b|\bsquare\b/i, width: 1024, height: 1024 },
]

const STYLES = [
  { re: /\br[ée]aliste\b|\bphotograph|photoreal|photo\b/i, suffix: 'photorealistic, cinematic lighting' },
  { re: /\billustration\b|\bdigital art\b/i, suffix: 'digital illustration, vibrant colors' },
  { re: /\bdessin\b|\bcrayon\b|\bsketch\b/i, suffix: 'detailed pencil drawing' },
  { re: /\bpeinture\b|\bpainting\b/i, suffix: 'oil painting, classical style' },
  { re: /\b3d\b|\brendu 3d\b|\brender\b/i, suffix: '3d render, octane render' },
  { re: /\banime\b|\bmanga\b/i, suffix: 'anime style, studio quality' },
  { re: /\bpixel art\b/i, suffix: 'pixel art' },
  { re: /\bfuturiste\b|\bfuturistic\b/i, suffix: 'futuristic, neon lights' },
  { re: /\bnoir et blanc\b|\bblack and white\b|\bmonochrome\b/i, suffix: 'black and white, high contrast' },
]

function randomSeed() {
  return 1 + Math.floor(Math.random() * 999999)
}

function cleanSubject(raw) {
  return String(raw ?? '')
    .replace(/[«»"“”]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.!?]+$/, '')
    // Le groupe de capture peut inclure l'article : « d'une BMW » → « BMW ».
    .replace(/^(?:de\s+|d['’]\s*)?(?:une?|des|la|le|les)\s+/i, '')
    .trim()
    .slice(0, MAX_PROMPT)
}

// Analyse le message utilisateur.
// Retourne null si ce n'est pas une demande d'image, sinon la requête prête
// pour le service de génération (prompt enrichi, taille, seed).
export function detectImageIntent(text) {
  const input = String(text ?? '').trim()
  if (!input || input.length > 2000) return null

  let subject = null
  const match = STRICT_RE.exec(input) ?? LOOSE_RE.exec(input) ?? SHOW_RE.exec(input) ?? BARE_IMAGE_RE.exec(input)
  if (match) subject = cleanSubject(match[1])

  // Garde-fous : pas de sujet, ou le « sujet » est en fait une question.
  if (!subject || subject.length < 3) return null
  if (/^(comment|pourquoi|quand|où|est-ce|peux-tu m'expliquer)/i.test(subject)) return null
  // Un diagramme, un schéma, un tableau ou du code ne sont pas des images.
  if (/^(?:un\s+|le\s+|la\s+)?(diagramme|sch[ée]ma|tableau|graphique|organigramme|code|programme|texte|po[èe]me|calcul)\b/i.test(subject)) return null

  const aspect = ASPECTS.find((a) => a.re.test(input)) ?? { width: 1024, height: 1024 }
  const style = STYLES.find((s) => s.re.test(input))

  // Prompt visuel : le sujet de l'utilisateur reste intact, on ajoute
  // uniquement des descripteurs de qualité/style transparents.
  const parts = [subject]
  if (style) parts.push(style.suffix)
  parts.push('high quality, detailed')
  const prompt = parts.join(', ').slice(0, MAX_PROMPT)

  return {
    subject,
    prompt,
    width: aspect.width,
    height: aspect.height,
    seed: randomSeed(),
    model: 'sana',
  }
}

// Construit un nouveau seed pour une régénération (variante de l'image).
export function nextSeed() {
  return randomSeed()
}
