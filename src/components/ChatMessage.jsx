import { Component, useState } from 'react'
import { BrandMark, UserIcon, CopyIcon, CheckIcon } from './Icons'
import SmartResponse from './smart/SmartResponse'

// Rendu markdown de repli (pas de HTML injecté) : gras, titres, listes,
// code inline et blocs. Utilisé si Smart Responses est désactivé ou échoue.
function renderInline(text, keyBase) {
  const parts = []
  const regex = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let match
  let i = 0
  while ((match = regex.exec(text)) !== null) {
    if (match.index > last) parts.push(text.slice(last, match.index))
    const token = match[0]
    if (token.startsWith('**')) parts.push(<strong key={`${keyBase}-b-${i}`}>{token.slice(2, -2)}</strong>)
    else parts.push(<code key={`${keyBase}-c-${i}`}>{token.slice(1, -1)}</code>)
    last = match.index + token.length
    i++
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

export function PlainMarkdown({ text }) {
  const lines = text.split('\n')
  const blocks = []
  let list = null
  let code = null
  let key = 0

  const flushList = () => {
    if (list) {
      blocks.push(
        <ul key={`ul-${key++}`}>
          {list.map((item, i) => <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>)}
        </ul>
      )
      list = null
    }
  }
  const flushCode = () => {
    if (code !== null) {
      blocks.push(<pre key={`pre-${key++}`}><code>{code.join('\n')}</code></pre>)
      code = null
    }
  }

  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (line.trim().startsWith('```')) {
      if (code !== null) flushCode()
      else { flushList(); code = [] }
      continue
    }
    if (code !== null) { code.push(raw); continue }
    const trimmed = line.trim()
    if (!trimmed) { flushList(); continue }
    const heading = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (heading) {
      flushList()
      const level = heading[1].length
      const Tag = `h${Math.min(level + 2, 6)}`
      blocks.push(<Tag key={`h-${key++}`}>{renderInline(heading[2], `h-${key}`)}</Tag>)
      continue
    }
    const bullet = trimmed.match(/^[-*•]\s+(.*)$/)
    const numbered = trimmed.match(/^\d+[.)]\s+(.*)$/)
    if (bullet || numbered) {
      if (!list) list = []
      list.push((bullet ?? numbered)[1])
      continue
    }
    flushList()
    blocks.push(<p key={`p-${key++}`}>{renderInline(trimmed, `p-${key}`)}</p>)
  }
  flushList()
  flushCode()
  return <div className="message-markdown">{blocks}</div>
}

// Si la présentation intelligente échoue, la réponse reste affichée en markdown.
class ResponseBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { failed: false }
  }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error) {
    if (import.meta.env?.DEV) console.warn('[Smart Responses] repli markdown :', error?.message)
  }
  render() {
    if (this.state.failed) return <PlainMarkdown text={this.props.text} />
    return this.props.children
  }
}

export default function ChatMessage({ message, isStreaming, question = '', onUpdate }) {
  const [copied, setCopied] = useState(false)
  const isUser = message.role === 'user'

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message.content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1600)
    } catch {
      /* presse-papiers indisponible */
    }
  }

  return (
    <article className={`message${isUser ? ' is-user' : ' is-assistant'}`}>
      <div className="message-avatar" aria-hidden="true">
        {isUser ? <UserIcon size={16} /> : <BrandMark size={18} />}
      </div>
      <div className="message-body">
        <div className="message-meta">
          <span className="message-author">{isUser ? 'Vous' : 'VEYVRO'}</span>
          {isStreaming && <span className="message-streaming-dot" aria-label="En cours de rédaction" />}
        </div>
        <div className="message-content">
          {isUser ? (
            <p>{message.content}</p>
          ) : (
            <ResponseBoundary text={message.content}>
              <SmartResponse content={message.content} question={question} streaming={isStreaming} onUpdate={onUpdate} />
            </ResponseBoundary>
          )}
          {isStreaming && <span className="message-caret" aria-hidden="true" />}
        </div>
        {!isUser && message.content && !isStreaming && (
          <div className="message-actions">
            <button type="button" className="message-action" onClick={copy} aria-label="Copier la réponse">
              {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
              <span>{copied ? 'Copié' : 'Copier'}</span>
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export function ThinkingIndicator() {
  return (
    <article className="message is-assistant" aria-label="VEYVRO réfléchit">
      <div className="message-avatar" aria-hidden="true"><BrandMark size={18} /></div>
      <div className="message-body">
        <div className="message-meta"><span className="message-author">VEYVRO</span></div>
        <div className="thinking-dots" aria-hidden="true"><span /><span /><span /></div>
      </div>
    </article>
  )
}
