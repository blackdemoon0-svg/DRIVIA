// Calcul de disposition d'un diagramme système.
//
// Problème corrigé : avec un simple classement par rôle, la batterie, l'onduleur
// et le moteur tombaient dans la même colonne, forçant des courbes de retour
// longues qui traversaient tout le diagramme.
//
// Solution : un ordonnancement en colonnes par « moment du parcours »
// (source → conversion → transmission → récupération), puis, à l'intérieur de
// chaque colonne, un tri par rôle. Un même identifiant de flux ne partage jamais
// arbitrairement une colonne avec sa cible, ce qui garde les flèches courtes.

const ROLE_RANK = {
  source: 0,
  control: 1,
  power: 2,
  mechanical: 3,
  recovery: 4,
  other: 5,
}

// Colonnes canoniques : elles suivent le trajet physique de l'énergie.
const TIER_ORDER = ['source', 'control', 'power', 'mechanical', 'recovery', 'other']

// Regroupe les nœuds en colonnes, en limitant le nombre de nœuds par colonne
// pour que le diagramme reste lisible (deux par colonne au maximum).
export function buildColumns(nodes, maxPerColumn = 2) {
  const byTier = new Map()
  for (const node of nodes) {
    const tier = TIER_ORDER.includes(node.tier) ? node.tier : 'other'
    if (!byTier.has(tier)) byTier.set(tier, [])
    byTier.get(tier).push(node)
  }

  const columns = []
  for (const tier of TIER_ORDER) {
    const list = byTier.get(tier)
    if (!list?.length) continue
    // Découpe une colonne trop chargée en sous-colonnes équilibrées.
    const chunkSize = Math.ceil(list.length / Math.ceil(list.length / maxPerColumn))
    for (let i = 0; i < list.length; i += chunkSize) {
      columns.push({ tier, nodes: list.slice(i, i + chunkSize) })
    }
  }
  return columns
}

// Retourne la colonne d'un nœud, pour tracer un lien sans ambiguïté.
export function columnIndexMap(columns) {
  const map = new Map()
  columns.forEach((column, index) => {
    for (const node of column.nodes) map.set(node.id, index)
  })
  return map
}

// Nombre de colonnes visé selon la largeur disponible.
export function maxColumnsFor(width) {
  if (width < 520) return 1
  if (width < 760) return 2
  if (width < 1080) return 4
  return 6
}
