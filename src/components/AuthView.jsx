import { useState } from 'react'
import { useAuthActions, validateCredentials } from '../lib/auth'
import { BrandMark, MailIcon, ShieldIcon, ArrowIcon } from './Icons'

// Connexion / inscription — flows Supabase existants conservés.
export default function AuthView({ mode, onModeChange, onSignedIn }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [notice, setNotice] = useState(null)
  const { busy, signIn, signUp } = useAuthActions()
  const isSignUp = mode === 'signup'

  const submit = async (e) => {
    e.preventDefault()
    if (busy) return
    setNotice(null)
    const invalid = validateCredentials(email, password)
    if (invalid) return setNotice({ tone: 'error', text: invalid })
    if (isSignUp && password !== confirm) return setNotice({ tone: 'error', text: 'Les deux mots de passe ne correspondent pas.' })
    const result = isSignUp ? await signUp(email, password) : await signIn(email, password)
    if (!result.ok) return setNotice({ tone: 'error', text: result.message })
    if (isSignUp && result.status === 'confirmation-sent') {
      setNotice({ tone: 'success', text: 'Compte créé. Vérifiez votre boîte mail et cliquez sur le lien de confirmation pour activer votre adresse.' })
      return
    }
    onSignedIn?.()
  }

  return (
    <div className="page-view auth-view">
      <div className="auth-card">
        <div className="auth-brand"><BrandMark size={34} /></div>
        <h1>{isSignUp ? 'Créer un compte' : 'Connexion'}</h1>
        <p className="auth-subtitle">
          {isSignUp ? 'Rejoignez VEYVRO pour discuter avec votre IA automobile.' : 'Connectez-vous pour retrouver votre assistant automobile.'}
        </p>

        <div className="auth-tabs" role="tablist">
          <button type="button" role="tab" aria-selected={!isSignUp} className={!isSignUp ? 'is-active' : ''} onClick={() => onModeChange('signin')}>Connexion</button>
          <button type="button" role="tab" aria-selected={isSignUp} className={isSignUp ? 'is-active' : ''} onClick={() => onModeChange('signup')}>Inscription</button>
        </div>

        <form onSubmit={submit} className="auth-form">
          <label className="field">
            <span>Adresse e-mail</span>
            <div className="field-input">
              <MailIcon size={17} />
              <input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="vous@exemple.com" required />
            </div>
          </label>
          <label className="field">
            <span>Mot de passe</span>
            <div className="field-input">
              <ShieldIcon size={17} />
              <input type="password" autoComplete={isSignUp ? 'new-password' : 'current-password'} value={password} onChange={(e) => setPassword(e.target.value)} placeholder="8 caractères minimum" required />
            </div>
          </label>
          {isSignUp && (
            <label className="field">
              <span>Confirmer le mot de passe</span>
              <div className="field-input">
                <ShieldIcon size={17} />
                <input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder="Retapez le mot de passe" required />
              </div>
            </label>
          )}
          {notice && <div className={`auth-notice is-${notice.tone}`} role="alert">{notice.text}</div>}
          <button type="submit" className="primary-button auth-submit" disabled={busy}>
            {busy ? 'Veuillez patienter…' : isSignUp ? 'Créer mon compte' : 'Se connecter'}
            {!busy && <ArrowIcon size={16} />}
          </button>
        </form>
        <p className="auth-foot">En continuant, vous acceptez que VEYVRO traite vos échanges pour vous répondre.</p>
      </div>
    </div>
  )
}
