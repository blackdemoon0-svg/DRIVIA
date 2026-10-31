import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MIN_PASSWORD_LENGTH,
  describeAuthError,
  signInWithEmail,
  signUpWithEmail,
  useSignOut,
  validateCredentials,
  validatePasswordConfirmation,
} from "../lib/auth";
import type { User } from "@supabase/supabase-js";
import {
  fetchEntitlement,
  summarizeSubscription,
  type EntitlementResult,
} from "../lib/entitlement";

/**
 * Sign-up, sign-in and account views.
 *
 * Navigation is state-based (`App.tsx` switches on `view`), so these are plain
 * views, not routes: no URL is added and no server rewrite is required.
 *
 * Design notes:
 * - reuses the existing pricing-stage / pricing-card / pricing-intro classes so
 *   the pages belong to the same visual family as the rest of the site;
 * - only additive `auth-*` classes are introduced for form controls.
 */

type AuthMode = "connexion" | "inscription";

type AuthViewProps = {
  mode: AuthMode;
  onModeChange: (mode: AuthMode) => void;
  /** Called once a real session exists (never on a pending confirmation). */
  onSignedIn?: () => void;
};

type Feedback = { tone: "error" | "success"; text: string } | null;

export default function AuthView({ mode, onModeChange, onSignedIn }: AuthViewProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [isBusy, setIsBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const isSignUp = mode === "inscription";

  // Reset the form when switching between the two views.
  useEffect(() => {
    setPassword("");
    setConfirmation("");
    setFeedback(null);
  }, [mode]);

  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;

    setFeedback(null);

    const invalid = validateCredentials(email, password);
    if (invalid) {
      setFeedback({ tone: "error", text: invalid });
      return;
    }

    if (isSignUp) {
      const mismatch = validatePasswordConfirmation(password, confirmation);
      if (mismatch) {
        setFeedback({ tone: "error", text: mismatch });
        return;
      }
    }

    setIsBusy(true);
    try {
      if (isSignUp) {
        const result = await signUpWithEmail(email, password);
        setPassword("");
        setConfirmation("");
        if (result.status === "signed-in") {
          // "Confirm email" disabled: a real session exists, so this is safe.
          setFeedback({ tone: "success", text: "Compte créé et connecté." });
          onSignedIn?.();
        } else {
          // The project has "Confirm email" enabled: no session exists yet.
          setFeedback({
            tone: "success",
            text: "Compte créé. Vérifiez votre boîte mail et cliquez sur le lien de confirmation pour activer votre adresse, puis revenez vous connecter.",
          });
        }
      } else {
        await signInWithEmail(email, password);
        setPassword("");
        setFeedback({ tone: "success", text: "Connexion réussie." });
        onSignedIn?.();
      }
    } catch (error) {
      setFeedback({ tone: "error", text: describeAuthError(error) });
    } finally {
      setIsBusy(false);
    }
  };

  const switchMode = (next: AuthMode) => {
    if (next === mode) return;
    onModeChange(next);
  };

  return (
    <main className="pricing-stage auth-stage" aria-label={isSignUp ? "Créer un compte" : "Se connecter"}>
      <div className="pricing-intro">
        <p className="eyebrow">
          <span className="eyebrow-dot" /> {isSignUp ? "CRÉER UN COMPTE" : "ESPACE PERSONNEL"}
        </p>
        <h1>
          {isSignUp ? "Rejoindre" : "Se connecter"} <span>VEYVRO</span>
        </h1>
        <p className="pricing-subtitle">
          {isSignUp
            ? "Un compte vous permet de retrouver votre formule et vos accès sur tous vos appareils."
            : "Connectez-vous pour accéder à votre compte et à votre formule."}
        </p>
      </div>

      <section className="pricing-card auth-card" aria-labelledby="auth-form-title">
        <h2 className="auth-title" id="auth-form-title">
          {isSignUp ? "Inscription" : "Connexion"}
        </h2>

        <form className="auth-form" onSubmit={handleSubmit} noValidate>
          <div className="auth-field">
            <label htmlFor="auth-email">Adresse e-mail</label>
            <input
              id="auth-email"
              ref={emailRef}
              className="auth-input"
              type="email"
              name="email"
              autoComplete="email"
              inputMode="email"
              spellCheck={false}
              required
              value={email}
              onChange={(event) => setEmail(event.currentTarget.value)}
            />
          </div>

          <div className="auth-field">
            <label htmlFor="auth-password">Mot de passe</label>
            <input
              id="auth-password"
              className="auth-input"
              type="password"
              name="password"
              autoComplete={isSignUp ? "new-password" : "current-password"}
              required
              minLength={MIN_PASSWORD_LENGTH}
              aria-describedby="auth-password-hint"
              value={password}
              onChange={(event) => setPassword(event.currentTarget.value)}
            />
            <p className="auth-hint" id="auth-password-hint">
              {MIN_PASSWORD_LENGTH} caractères minimum.
            </p>
          </div>

          {isSignUp && (
            <div className="auth-field">
              <label htmlFor="auth-password-confirm">Confirmer le mot de passe</label>
              <input
                id="auth-password-confirm"
                className="auth-input"
                type="password"
                name="password-confirm"
                autoComplete="new-password"
                required
                minLength={MIN_PASSWORD_LENGTH}
                value={confirmation}
                onChange={(event) => setConfirmation(event.currentTarget.value)}
              />
            </div>
          )}

          {feedback && (
            <p
              className={feedback.tone === "error" ? "pricing-error auth-feedback" : "pricing-notice auth-feedback"}
              role={feedback.tone === "error" ? "alert" : "status"}
            >
              {feedback.text}
            </p>
          )}

          <button type="submit" className="pricing-cta auth-submit" disabled={isBusy} aria-busy={isBusy}>
            {isBusy
              ? isSignUp
                ? "Création en cours…"
                : "Connexion en cours…"
              : isSignUp
                ? "Créer mon compte"
                : "Se connecter"}
          </button>
        </form>

        <p className="auth-switch">
          {isSignUp ? "Vous avez déjà un compte ?" : "Pas encore de compte ?"}{" "}
          <button
            type="button"
            className="auth-switch-button"
            onClick={() => switchMode(isSignUp ? "connexion" : "inscription")}
          >
            {isSignUp ? "Se connecter" : "Créer un compte"}
          </button>
        </p>
      </section>
    </main>
  );
}

type AccountViewProps = {
  user: User;
  onGoToPricing: () => void;
  onSignedOut: () => void;
};

/**
 * Account view, shown only with a real session (guarded by `App.tsx`).
 *
 * The plan comes from the `subscriptions` table through row level security: no
 * prop, no query string and no local storage can assert a plan. While the read
 * is in flight, nothing is claimed; on failure, the reason is shown instead of a
 * guessed formula.
 */
export function AccountView({ user, onGoToPricing, onSignedOut }: AccountViewProps) {
  const { signOutNow, isSigningOut, error: signOutError } = useSignOut();
  const [entitlement, setEntitlement] = useState<EntitlementResult | null>(null);
  const [loading, setLoading] = useState(true);

  const email = user.email ?? "adresse inconnue";
  const confirmed = Boolean(user.email_confirmed_at);

  useEffect(() => {
    let active = true;
    setLoading(true);

    void fetchEntitlement(user.id)
      .then((result) => {
        if (active) setEntitlement(result);
      })
      .finally(() => {
        if (active) setLoading(false);
      });

    return () => {
      active = false;
    };
  }, [user.id]);

  const summary =
    entitlement?.kind === "subscription" ? summarizeSubscription(entitlement.subscription) : null;

  return (
    <main className="pricing-stage auth-stage" aria-label="Mon compte">
      <div className="pricing-intro">
        <p className="eyebrow">
          <span className="eyebrow-dot" /> ESPACE PERSONNEL
        </p>
        <h1>
          Mon <span>compte</span>
        </h1>
        <p className="pricing-subtitle">Votre identité VEYVRO et votre formule en cours.</p>
      </div>

      <section className="pricing-card auth-card" aria-labelledby="account-title">
        <h2 className="auth-title" id="account-title">
          Compte connecté
        </h2>

        <dl className="account-rows">
          <div className="account-row">
            <dt>Adresse e-mail</dt>
            <dd>{email}</dd>
          </div>
          <div className="account-row">
            <dt>Adresse</dt>
            <dd>{confirmed ? "Confirmée" : "En attente de confirmation"}</dd>
          </div>

          <div className="account-row">
            <dt>Formule</dt>
            <dd aria-busy={loading}>
              {loading ? (
                <span className="account-muted">Vérification de votre formule…</span>
              ) : summary ? (
                <span className={`account-plan account-plan-${summary.tone}`}>
                  <strong>{summary.plan}</strong>
                  <span className="account-plan-status">{summary.statusLabel}</span>
                </span>
              ) : entitlement?.kind === "error" ? (
                <span className="account-muted">{entitlement.message}</span>
              ) : (
                <span className="account-muted">
                  Aucun abonnement enregistré. La formule Découverte reste accessible gratuitement.
                </span>
              )}
            </dd>
          </div>
        </dl>

        {summary && (
          <p
            className={
              summary.tone === "warning"
                ? "pricing-error auth-feedback"
                : "pricing-notice auth-feedback"
            }
            role={summary.tone === "warning" ? "alert" : "status"}
          >
            {summary.detail}
          </p>
        )}

        {signOutError && (
          <p className="pricing-error auth-feedback" role="alert">
            {signOutError}
          </p>
        )}

        <div className="auth-actions">
          <button type="button" className="pricing-cta secondary" onClick={onGoToPricing}>
            {summary ? "Voir les formules" : "Découvrir les formules"}
          </button>
          <button
            type="button"
            className="pricing-verify-button"
            onClick={() => {
              void signOutNow().then(() => onSignedOut());
            }}
            disabled={isSigningOut}
            aria-busy={isSigningOut}
          >
            {isSigningOut ? "Déconnexion…" : "Se déconnecter"}
          </button>
        </div>
      </section>
    </main>
  );
}
