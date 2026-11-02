import { useEffect, useRef, useState, type FormEvent } from "react";
import {
  MIN_PASSWORD_LENGTH,
  describeAuthError,
  resendConfirmationEmail,
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

/**
 * Supabase refuses a second confirmation e-mail for the same address within
 * 60 seconds. The button is disabled for that long so a click cannot burn the
 * project-wide quota (2 e-mails/hour on the built-in sender).
 */
export const RESEND_COOLDOWN_SECONDS = 60;

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
  /**
   * Address awaiting confirmation, so the resend button knows what to resend.
   * `null` means "no pending confirmation": the button is not offered.
   */
  const [pendingConfirmation, setPendingConfirmation] = useState<string | null>(null);
  /** Seconds left on Supabase's 60-second per-address cooldown. */
  const [resendCooldown, setResendCooldown] = useState(0);
  const [isResending, setIsResending] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);

  const isSignUp = mode === "inscription";

  // Reset the form when switching between the two views.
  useEffect(() => {
    setPassword("");
    setConfirmation("");
    setFeedback(null);
    setPendingConfirmation(null);
    setResendCooldown(0);
  }, [mode]);

  // Countdown for the resend button. Ticks once per second while active and
  // stops by itself, so the timer can never outlive the component.
  useEffect(() => {
    if (resendCooldown <= 0) return;
    const timer = setTimeout(() => setResendCooldown((current) => current - 1), 1_000);
    return () => clearTimeout(timer);
  }, [resendCooldown]);

  useEffect(() => {
    emailRef.current?.focus();
  }, [mode]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (isBusy) return;

    setFeedback(null);
    const cleanAddress = email.trim().toLowerCase();

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
          setPendingConfirmation(null);
          setFeedback({ tone: "success", text: "Compte créé et connecté." });
          onSignedIn?.();
        } else if (result.status === "already-registered") {
          // Supabase sent nothing. Saying "check your inbox" here is what made a
          // working sign-up look broken, so the wording changes — while staying
          // neutral: it never confirms that the account exists.
          setPendingConfirmation(cleanAddress);
          setResendCooldown(RESEND_COOLDOWN_SECONDS);
          setFeedback({
            tone: "success",
            text: "Si cette adresse n'est pas déjà enregistrée, un e-mail de confirmation arrive. Si vous avez déjà un compte, connectez-vous : vous n'avez peut-être plus besoin de le confirmer.",
          });
        } else {
          // The project has "Confirm email" enabled: an e-mail was sent, no
          // session exists yet. The resend button covers a lost or filtered one.
          setPendingConfirmation(cleanAddress);
          setResendCooldown(RESEND_COOLDOWN_SECONDS);
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

  const handleResend = async () => {
    const address = pendingConfirmation;
    if (!address || isResending || resendCooldown > 0) return;

    setIsResending(true);
    try {
      await resendConfirmationEmail(address);
      // Deliberately neutral: identical wording whether or not it was sent.
      setFeedback({
        tone: "success",
        text: "Si un compte attend confirmation pour cette adresse, un nouvel e-mail vient d'être envoyé.",
      });
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
    } catch (error) {
      // A rate limit already answers "wait a minute": keep the button locked so
      // the user cannot hammer the quota.
      setResendCooldown(RESEND_COOLDOWN_SECONDS);
      setFeedback({ tone: "error", text: describeAuthError(error) });
    } finally {
      setIsResending(false);
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

          {pendingConfirmation && (
            <button
              type="button"
              className="pricing-cta secondary auth-submit"
              onClick={() => void handleResend()}
              disabled={isResending || resendCooldown > 0}
              aria-busy={isResending}
            >
              {isResending
                ? "Envoi en cours…"
                : resendCooldown > 0
                  ? `Renvoyer l'e-mail (${resendCooldown} s)`
                  : "Renvoyer l'e-mail de confirmation"}
            </button>
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

  const subscription = entitlement?.kind === "subscription" ? entitlement.subscription : null;
  const summary = subscription ? summarizeSubscription(subscription) : null;

  /**
   * The account page is a starting point for the upgrade, not a place where the
   * change is executed: the prorated amount has to be shown and confirmed, and
   * that lives on the pricing page. Only a Plus subscription in good standing
   * gets the button — the same rule the server applies.
   */
  const offersUpgrade = subscription?.plan === "plus" && subscription.status === "active";

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

        {offersUpgrade && (
          <p className="pricing-notice auth-feedback" role="status">
            Le passage à VEYVRO Pro se fait depuis la page des formules : le montant au prorata
            vous y sera montré avant toute confirmation.
          </p>
        )}

        <div className="auth-actions">
          {offersUpgrade && (
            <button type="button" className="pricing-cta" onClick={onGoToPricing}>
              Passer à VEYVRO Pro
            </button>
          )}
          <button type="button" className="pricing-cta secondary" onClick={onGoToPricing}>
            {summary ? "Voir les formules" : "Découvrir les formules"}
          </button>
          <button
            type="button"
            className="pricing-verify-button"
            onClick={() => {
              // Navigate to the login view only once the session is really gone.
              void signOutNow().then((signedOut) => {
                if (signedOut) onSignedOut();
              });
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
