import { memo, useState, useMemo } from 'react'

// Organigramme / diagramme hiérarchique : arbre rendu en colonnes par niveau.
// Chaque nœud est cliquable et affiche son détail sous l'arbre.

function flatten(node, depth, out) {
  out.push({ node, depth })
  for (const child of node.children ?? []) flatten(child, depth + 1, out)
  return out
}

export default memo(function TreeDiagram({ root, title }) {
  const [activeId, setActiveId] = useState(root.id)
  const levels = useMemo(() => {
    const out = []
    for (const item of flatten(root, 0, [])) {
      out[item.depth] = out[item.depth] ?? []
      out[item.depth].push(item.node)
    }
    return out
  }, [root])

  const active = useMemo(() => flatten(root, 0, []).find((i) => i.node.id === activeId)?.node ?? root, [root, activeId])

  return (
    <div className="sr-visual-block sr-tree">
      {title && <h4 className="sr-visual-title">{title}</h4>}
      <div className="sr-tree-levels" role="tree" aria-label={title ?? 'Diagramme hiérarchique'}>
        {levels.map((nodes, depth) => (
          <div className="sr-tree-level" key={depth} role="group" aria-label={`Niveau ${depth + 1}`}>
            {nodes.map((node) => (
              <button
                key={node.id}
                type="button"
                role="treeitem"
                aria-selected={node.id === activeId}
                className={`sr-tree-node${node.id === activeId ? ' is-active' : ''}${node.children ? ' has-children' : ''}`}
                onClick={() => setActiveId(node.id)}
              >
                {node.label}
              </button>
            ))}
          </div>
        ))}
      </div>
      {active.detail && (
        <div className="sr-step-detail" aria-live="polite">
          <strong>{active.label}</strong>
          <p>{active.detail}</p>
        </div>
      )}
    </div>
  )
})
