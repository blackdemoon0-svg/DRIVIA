import { useState } from 'react'
import { ConversationsIcon, PlusIcon, TrashIcon, EditIcon, CheckIcon, CloseIcon, ChatIcon } from './Icons'

function timeAgo(ts) {
  const diff = Date.now() - ts
  const min = Math.floor(diff / 60000)
  if (min < 1) return "à l'instant"
  if (min < 60) return `il y a ${min} min`
  const h = Math.floor(min / 60)
  if (h < 24) return `il y a ${h} h`
  const d = Math.floor(h / 24)
  if (d < 7) return `il y a ${d} j`
  return new Date(ts).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })
}

export default function ConversationsView({ conversations, activeId, onOpen, onDelete, onRename, onNew, user }) {
  const [editingId, setEditingId] = useState(null)
  const [draft, setDraft] = useState('')

  const startEdit = (conv) => {
    setEditingId(conv.id)
    setDraft(conv.title)
  }
  const commitEdit = () => {
    if (editingId && draft.trim()) onRename(editingId, draft)
    setEditingId(null)
  }

  return (
    <div className="page-view">
      <header className="page-head">
        <p className="eyebrow"><span className="eyebrow-dot" /> Historique</p>
        <h1>Mes <span>conversations</span></h1>
        <p className="page-subtitle">Retrouvez et reprenez vos échanges avec VEYVRO. Ils sont enregistrés sur cet appareil.</p>
      </header>

      {!user ? (
        <div className="empty-state">
          <ConversationsIcon size={34} />
          <h2>Connectez-vous pour retrouver vos conversations</h2>
          <p>Vos échanges sont enregistrés localement et associés à votre compte VEYVRO.</p>
        </div>
      ) : conversations.length === 0 ? (
        <div className="empty-state">
          <ConversationsIcon size={34} />
          <h2>Aucune conversation pour le moment</h2>
          <p>Lancez votre premier échange avec VEYVRO pour le retrouver ici.</p>
          <button type="button" className="primary-button" onClick={onNew}><PlusIcon size={16} /> Nouvelle conversation</button>
        </div>
      ) : (
        <div className="conversations-list">
          {conversations.map((conv) => (
            <div key={conv.id} className={`conversation-row${conv.id === activeId ? ' is-active' : ''}`}>
              <button type="button" className="conversation-open" onClick={() => onOpen(conv.id)}>
                <span className="conversation-icon"><ChatIcon size={18} /></span>
                <span className="conversation-meta">
                  {editingId === conv.id ? (
                    <input
                      className="conversation-rename"
                      value={draft}
                      autoFocus
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitEdit()
                        if (e.key === 'Escape') setEditingId(null)
                      }}
                      onBlur={commitEdit}
                      aria-label="Renommer la conversation"
                    />
                  ) : (
                    <span className="conversation-title">{conv.title}</span>
                  )}
                  <span className="conversation-sub">{conv.messages.length} message{conv.messages.length > 1 ? 's' : ''} · {timeAgo(conv.updatedAt)}</span>
                </span>
              </button>
              <div className="conversation-actions">
                {editingId === conv.id ? (
                  <button type="button" className="icon-button" onClick={commitEdit} aria-label="Valider"><CheckIcon size={16} /></button>
                ) : (
                  <button type="button" className="icon-button" onClick={() => startEdit(conv)} aria-label="Renommer"><EditIcon size={16} /></button>
                )}
                <button type="button" className="icon-button is-danger" onClick={() => onDelete(conv.id)} aria-label="Supprimer"><TrashIcon size={16} /></button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
