// Jeu d'icônes SVG cohérent avec la nouvelle direction artistique (traits fins,
// coins arrondis, currentColor). Aucune dépendance externe.
const base = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' }

function Svg({ children, size = 20, ...rest }) {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden="true" {...base} {...rest}>
      {children}
    </svg>
  )
}

export const ChatIcon = (p) => (
  <Svg {...p}><path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 9.9 9.9 0 0 1-2.8-.4L3 21l1.6-4.2A8.4 8.4 0 1 1 21 11.5Z" /><path d="M8.5 10.5h7M8.5 13.5h4" /></Svg>
)
export const ConversationsIcon = (p) => (
  <Svg {...p}><path d="M8 10h8M8 13.5h5" /><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.5-4.6A8 8 0 1 1 21 12Z" /><path d="M16.5 3.6a6.5 6.5 0 0 1 3.9 8" /></Svg>
)
export const SettingsIcon = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>
)
export const HelpIcon = (p) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M9.2 9a2.9 2.9 0 0 1 5.6 1c0 1.8-2.8 2.3-2.8 3.6" /><path d="M12 17h.01" /></Svg>
)
export const UserIcon = (p) => (
  <Svg {...p}><circle cx="12" cy="8" r="4" /><path d="M4 21c1.4-3.6 4.4-5.5 8-5.5s6.6 1.9 8 5.5" /></Svg>
)
export const MenuIcon = (p) => (<Svg {...p}><path d="M4 7h16M4 12h16M4 17h16" /></Svg>)
export const CloseIcon = (p) => (<Svg {...p}><path d="M6 6l12 12M18 6L6 18" /></Svg>)
export const SendIcon = (p) => (<Svg {...p}><path d="M5 12h13M13 6l6 6-6 6" /></Svg>)
export const AttachIcon = (p) => (
  <Svg {...p}><path d="M20.5 11.5 12 20a5.5 5.5 0 0 1-7.8-7.8l8.5-8.5a3.7 3.7 0 0 1 5.2 5.2l-8.5 8.5a1.8 1.8 0 0 1-2.6-2.6l7.8-7.8" /></Svg>
)
export const ToolsIcon = (p) => (
  <Svg {...p}><path d="M14.7 6.3a4.5 4.5 0 0 0-6 5.9L3 18l3 3 5.8-5.7a4.5 4.5 0 0 0 5.9-6l-2.8 2.8-2.5-.7-.7-2.5 2.8-2.8Z" /></Svg>
)
export const PlusIcon = (p) => (<Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>)
export const TrashIcon = (p) => (<Svg {...p}><path d="M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6.5 7l1 13h9l1-13" /></Svg>)
export const EditIcon = (p) => (<Svg {...p}><path d="M4 20h4L20 8a2.8 2.8 0 0 0-4-4L4 16v4Z" /><path d="M13.5 6.5l4 4" /></Svg>)
export const CheckIcon = (p) => (<Svg {...p}><path d="M5 13l4 4L19 7" /></Svg>)
export const ArrowIcon = (p) => (<Svg {...p}><path d="M5 12h14M13 6l6 6-6 6" /></Svg>)
export const SparklesIcon = (p) => (
  <Svg {...p}><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8L12 3Z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></Svg>
)
export const BattleIcon = (p) => (
  <Svg {...p}><path d="M4 16l1.5-5A2 2 0 0 1 7.4 9.5h9.2a2 2 0 0 1 1.9 1.5L20 16" /><path d="M4 16h16v3h-2.5M4 19h2.5" /><circle cx="7.5" cy="17.5" r="1.6" /><circle cx="16.5" cy="17.5" r="1.6" /><path d="M9 6l3-3 3 3" /></Svg>
)
export const QuoteIcon = (p) => (
  <Svg {...p}><path d="M7 3.8h7.7L18 7.1v8.2" /><path d="M14.5 3.9v3.6h3.2M7 3.8v16.4h5.1" /><path d="M9.8 10h5.1M9.8 13h3.2" /><path d="m15.1 17.2 4-4 2.1 2.2-4 4-2.7.6.6-2.8Z" /></Svg>
)
export const AlertIcon = (p) => (<Svg {...p}><path d="m12 3.7 9 15.6H3l9-15.6Z" /><path d="M12 9v4.6M12 17.1h.01" /></Svg>)
export const CarIcon = (p) => (
  <Svg {...p}><path d="m4.1 14.9 1.6-5.2a2 2 0 0 1 1.9-1.4h8.8a2 2 0 0 1 1.9 1.4l1.6 5.2" /><path d="M4 15h16v4h-2.4M4 19h2.4" /><circle cx="7.5" cy="16.8" r="1.5" /><circle cx="16.5" cy="16.8" r="1.5" /></Svg>
)
export const MoonIcon = (p) => (<Svg {...p}><path d="M20 14.5A8.5 8.5 0 0 1 9.5 4 8.5 8.5 0 1 0 20 14.5Z" /></Svg>)
export const SnowIcon = (p) => (<Svg {...p}><path d="M12 2v20M4 6l16 12M20 6L4 18" /><path d="M12 2l-2 2.5M12 2l2 2.5M12 22l-2-2.5M12 22l2-2.5" /></Svg>)
export const ReplayIcon = (p) => (<Svg {...p}><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /></Svg>)
export const LogoutIcon = (p) => (<Svg {...p}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="M16 17l5-5-5-5M21 12H9" /></Svg>)
export const MailIcon = (p) => (<Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2" /><path d="m3 7 9 6 9-6" /></Svg>)
export const ShieldIcon = (p) => (<Svg {...p}><path d="M12 3l8 3v6c0 4.5-3.2 7.7-8 9-4.8-1.3-8-4.5-8-9V6l8-3Z" /><path d="m9 12 2 2 4-4" /></Svg>)
export const InfoIcon = (p) => (<Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h.01" /></Svg>)
export const ChevronIcon = (p) => (<Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>)
export const CopyIcon = (p) => (<Svg {...p}><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Svg>)
export const StopIcon = (p) => (<Svg {...p}><rect x="6" y="6" width="12" height="12" rx="2" /></Svg>)
export const ImageIcon = (p) => (
  <Svg {...p}><rect x="3" y="4" width="18" height="16" rx="2.5" /><circle cx="8.7" cy="9.7" r="1.6" /><path d="m4 17 4.8-4.8a2 2 0 0 1 2.8 0L20 20" /></Svg>
)
export const ZoomIcon = (p) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="M20 20l-4.2-4.2M8.5 11h5M11 8.5v5" /></Svg>
)
export const DownloadIcon = (p) => (<Svg {...p}><path d="M12 3v12M7 11l5 5 5-5M4 20h16" /></Svg>)
export const RefreshIcon = (p) => (<Svg {...p}><path d="M20.5 12a8.5 8.5 0 1 1-2.9-6.4" /><path d="M21 4v5h-5" /></Svg>)

export function BrandMark({ size = 28 }) {
  return (
    <svg viewBox="0 0 32 32" width={size} height={size} aria-hidden="true" fill="none" className="brand-mark">
      <path d="M8 5.5h8a10.5 10.5 0 1 1-9.1 5.3" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6 4.5v7h7" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M12.4 11.5 16 20.5 19.6 11.5" stroke="var(--accent, #a855f7)" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
