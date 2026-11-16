// Sélection adaptative du format de présentation.
// Le moteur NE CRÉE PAS de contenu : il choisit seulement comment présenter
// ce que le modèle a déjà produit. En cas de doute → conversation (sobre).

import { blockText } from './parse'

export const KINDS = ['conversation', 'educational', 'steps', 'comparison', 'technical', 'math', 'creative', 'diagram', 'system', 'cycle', 'journey', 'visual', 'image', 'data']

const PATTERNS = {
  greeting: /^(salut|bonjour|bonsoir|hello|hi|hey|coucou|ça va|ca va|merci|ok|super|d'accord|au revoir|bye)\b/i,
  comparison: /\b(compare|comparaison|comparer|versus|vs\.?|diff[ée]rence|diff[ée]rent|ou bien|lequel|laquelle|mieux entre|avantage|inconv[ée]nient)\b/i,
  steps: /\b(comment faire|comment on|comment je|étapes?|étape par étape|tutoriel|tutorial|proc[ée]dure|marche à suivre|guide|installer|monter|démonter|remplacer|réparer|étapes de)\b/i,
  process: /\b(comment (ça|cela|ca) (marche|fonctionne)|comment fonctionne|fonctionnement|processus|process|circuit|cheminement|cycle|schéma|schema)\b/i,
  educational: /\b(explique|expliquer|pourquoi|qu'est-ce|qu est ce|c'est quoi|c est quoi|définition|definition|comprendre|principe|th[ée]orie|à quoi sert)\b/i,
  technical: /\b(code|coder|programmation|programme|fonction|script|api|requête sql|sql|regex|bug|erreur|erreur \d|d[ée]bug|compiler|framework|library|biblioth[èe]que|html|css|javascript|typescript|python|react|node|java|rust|php|algorithme|architecture|serveur|base de données)\b/i,
  math: /\b(calcul|calcule|calculer|r[ée]sous|r[ée]soudre|[ée]quation|math[ée]matique|d[ée]riv[ée]|int[ée]grale|pourcentage|probabilit[ée]|statistique|moyenne|racine|fraction|factori|combien font|combien fait)\b/i,
  creative: /(?<![A-Za-zÀ-ÿ0-9_])([ée]cris|[ée]crire|r[ée]dige|r[ée]diger|po[èe]me|histoire|conte|chanson|slogans?|brainstorm|id[ée]es de|imagine|invente|sc[ée]nario|lettre|email de|post|titre accrocheur)(?![A-Za-zÀ-ÿ0-9_])/i,
  // Demande explicite de schéma / diagramme / carte.
  diagram: /\b(diagramme|organigramme|sch[ée]ma|sch[ée]matise|carte conceptuelle|carte mentale|arborescence|hi[ée]rarchie|flowchart|mindmap)\b/i,
  // Sujets à support visuel pédagogique (couches, système, structure).
  visualSubject: /\b(couches?|atmosph[èe]re|syst[èe]me solaire|plan[èe]tes?|cellule|neurone|r[ée]seau neuronal|moteur|circuit|[ée]lectricit[ée]|anatomie|organes?|strates?|structure|architecture|cycle|cha[îi]ne alimentaire|mol[ée]cule|atome|g[ée]ographie|continent|carte du monde)\b/i,
  // Description visuelle demandée (image).
  imageAsk: /\b(g[ée]n[èe]re|cr[ée]e|dessine|illustre|imagine|montre-moi)\b[^.]{0,40}\b(image|illustration|dessin|visuel|photo)\b/i,
}

const CODE_LANGS = new Set(['text', 'plain', 'txt', ''])

function questionOf(messages) {
  if (!Array.isArray(messages)) return String(messages ?? '')
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'user') return String(messages[i].content ?? '')
  }
  return ''
}

export function selectFormat({ question, blocks = [], content = '', streaming = false }) {
  const q = questionOf(question)
  const qLower = q.toLowerCase()
  const text = content || blocks.map(blockText).join('\n')
  const length = text.trim().length

  const counts = {
    heading: 0, list: 0, orderedItems: 0, bulletItems: 0,
    code: 0, realCode: 0, table: 0, math: 0, visual: 0, paragraph: 0, callout: 0,
  }
  let orderedList = null
  let tableCols = 0
  for (const b of blocks) {
    if (b.type === 'heading') counts.heading++
    else if (b.type === 'paragraph') counts.paragraph++
    else if (b.type === 'callout') counts.callout++
    else if (b.type === 'list') {
      counts.list++
      if (b.ordered) {
        counts.orderedItems += b.items.length
        if (!orderedList || b.items.length > orderedList.items.length) orderedList = b
      } else counts.bulletItems += b.items.length
    } else if (b.type === 'code') {
      counts.code++
      if (!CODE_LANGS.has(b.lang)) counts.realCode++
    } else if (b.type === 'table') { counts.table++; tableCols = Math.max(tableCols, b.header.length) }
    else if (b.type === 'math') counts.math++
    else if (b.type === 'visual') counts.visual++
  }

  const hasInlineMath = /\$[^$\n]+\$/.test(text)
  const reasons = []
  let kind = 'conversation'

  // 0. Image générée présente dans la réponse → format « image ».
  const hasImageBlock = blocks.some((b) => b.type === 'image')

  // 1. Métadonnées explicites du modèle : toujours prioritaires.
  const explicit = blocks.find((b) => b.type === 'visual' && b.spec)
  if (hasImageBlock) {
    kind = 'visual'
    reasons.push('generated-image')
  } else if (explicit) {
    const t = explicit.spec.type
    kind = t === 'comparison' ? 'comparison'
      : t === 'steps' ? 'steps'
      : t === 'chart' || t === 'pie' ? 'data'
      : t === 'system' || t === 'cycle' || t === 'journey' ? 'system'
      : t === 'diagram' || t === 'concept' || t === 'layers' ? 'diagram'
      : 'educational'
    reasons.push('visual-explicit')
  }
  // 1b. Demande explicite de diagramme → format diagramme.
  else if (PATTERNS.diagram.test(qLower)) {
    kind = 'diagram'
    reasons.push('diagram-request')
  }
  // 2. Salutation / message très court → conversation, sans visuel.
  else if (PATTERNS.greeting.test(qLower.trim()) && length < 400 && counts.realCode === 0 && counts.table === 0) {
    kind = 'conversation'
    reasons.push('greeting')
  }
  // 3. Code présent → technique.
  else if (counts.realCode > 0 || (counts.code > 0 && PATTERNS.technical.test(qLower))) {
    kind = 'technical'
    reasons.push('code-block')
  }
  // 4. Mathématiques.
  else if (counts.math > 0 || (PATTERNS.math.test(qLower) && (hasInlineMath || /[=]/.test(text)))) {
    kind = 'math'
    reasons.push('math')
  }
  // 5. Tableau à 2+ colonnes ou question comparative → comparaison.
  else if ((counts.table > 0 && tableCols >= 2) || (PATTERNS.comparison.test(qLower) && length > 220)) {
    kind = 'comparison'
    reasons.push(counts.table ? 'table' : 'comparison-question')
  }
  // 6. Procédure : liste ordonnée de 3+ items, ou question « comment faire ».
  else if ((counts.orderedItems >= 3 && (PATTERNS.steps.test(qLower) || PATTERNS.process.test(qLower) || counts.orderedItems >= 4)) ) {
    kind = 'steps'
    reasons.push('ordered-steps')
  }
  // 7. Création littéraire → sobre.
  else if (PATTERNS.creative.test(qLower) && counts.realCode === 0) {
    kind = 'creative'
    reasons.push('creative')
  }
  // 8. Explication structurée.
  else if (
    PATTERNS.educational.test(qLower) ||
    PATTERNS.process.test(qLower) ||
    (counts.heading >= 2 && length > 420) ||
    (counts.orderedItems >= 3 && length > 420)
  ) {
    kind = 'educational'
    reasons.push('structured-explanation')
  }
  // 8b. Sujet à support visuel (atmosphère, moteur, système solaire…) :
  // l'explication gagne un schéma même sans bloc explicite du modèle.
  else if (PATTERNS.visualSubject.test(qLower) && length > 180) {
    kind = 'educational'
    reasons.push('visual-subject')
  }
  // 9. Long texte sans structure → éducatif seulement si vraiment long.
  else if (length > 900 && counts.heading >= 1) {
    kind = 'educational'
    reasons.push('long-answer')
  }
  else {
    kind = 'conversation'
    reasons.push('default-simple')
  }

  // Un visuel n'a de sens que s'il y a de la matière.
  const rich = length > 200 || counts.visual > 0
  const wantsProcessDiagram =
    rich &&
    (kind === 'steps' || (kind === 'educational' && PATTERNS.process.test(qLower))) &&
    counts.orderedItems >= 4

  return {
    kind,
    reasons,
    counts,
    orderedList,
    showProcessDiagram: wantsProcessDiagram,
    // Pendant le streaming on reste sobre : pas de montage/démontage de gros
    // composants à chaque delta. Les visuels se stabilisent à la fin.
    allowHeavyVisuals: !streaming || counts.visual > 0,
  }
}
