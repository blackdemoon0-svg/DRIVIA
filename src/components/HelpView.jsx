import { useState } from 'react'
import { HelpIcon, ChevronIcon, MailIcon, ChatIcon, QuoteIcon, ShieldIcon } from './Icons'

export const HELP_FAQ = [
  {
    q: 'Que peut faire VEYVRO ?',
    a: "VEYVRO est votre assistant IA dédié à l'automobile : il analyse un devis de garage, explique un voyant ou un bruit, compare deux voitures et vous aide à vérifier une occasion avant achat. Posez simplement votre question dans le chat.",
  },
  {
    q: "Comment analyser mon devis de garage ?",
    a: "Cliquez sur l'icône pièce jointe (ou « Analyser mon devis »), importez une photo nette ou un PDF lisible de votre devis, et VEYVRO vous donne une première lecture des lignes et des montants.",
  },
  {
    q: 'Mes conversations sont-elles enregistrées ?',
    a: "Oui, vos conversations sont enregistrées localement sur cet appareil et associées à votre compte. Retrouvez-les dans « Mes conversations ». Vous pouvez les renommer ou les supprimer à tout moment.",
  },
  {
    q: 'VEYVRO est-il gratuit ?',
    a: "Oui. VEYVRO est entièrement gratuit : toutes les fonctionnalités sont accessibles sans abonnement et sans paiement. Il n'y a aucune formule payante dans cette interface.",
  },
  {
    q: 'Les réponses de VEYVRO sont-elles fiables ?',
    a: "VEYVRO fournit une première analyse pédagogique pour vous aider à y voir clair. Pour toute décision importante (achat, réparation, sécurité), faites confirmer par un professionnel qualifié.",
  },
  {
    q: 'Comment protéger mon compte ?',
    a: "Choisissez un mot de passe unique d'au moins 8 caractères et confirmez votre adresse e-mail. Ne partagez jamais vos identifiants.",
  },
]

export default function HelpView({ onStartChat }) {
  const [open, setOpen] = useState(0)

  return (
    <div className="page-view">
      <header className="page-head">
        <p className="eyebrow"><span className="eyebrow-dot" /> Assistance</p>
        <h1>Aide et <span>Support</span></h1>
        <p className="page-subtitle">Tout pour bien démarrer avec VEYVRO.</p>
      </header>

      <div className="help-cards">
        <button type="button" className="help-card" onClick={onStartChat}>
          <ChatIcon size={22} />
          <span className="help-card-title">Parler à VEYVRO</span>
          <span className="help-card-description">Posez votre question directement dans le chat.</span>
        </button>
        <a className="help-card" href="mailto:support@veyvro.dev">
          <MailIcon size={22} />
          <span className="help-card-title">Contacter le support</span>
          <span className="help-card-description">support@veyvro.dev — réponse par e-mail.</span>
        </a>
      </div>

      <section className="faq" aria-label="Questions fréquentes">
        <h2 className="settings-group-title"><HelpIcon size={17} /> Questions fréquentes</h2>
        {HELP_FAQ.map((item, i) => (
          <div key={i} className={`faq-item${open === i ? ' is-open' : ''}`}>
            <button type="button" className="faq-question" aria-expanded={open === i} onClick={() => setOpen(open === i ? -1 : i)}>
              <span>{item.q}</span>
              <ChevronIcon size={17} />
            </button>
            {open === i && <div className="faq-answer">{item.a}</div>}
          </div>
        ))}
      </section>

      <div className="settings-note">
        <ShieldIcon size={16} />
        <span>VEYVRO est une aide à la décision, pas un substitut à un diagnostic professionnel.</span>
      </div>
    </div>
  )
}
