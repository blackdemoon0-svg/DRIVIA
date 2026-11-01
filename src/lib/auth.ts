import { useCallback, useEffect, useState } from "react";
import type { Session, User } from "@supabase/supabase-js";
import { getSupabaseClient, SupabaseConfigError } from "./supabaseClient";

/**
 * Authentication helpers.
 *
 * Rules enforced here (and nowhere else):
 * - a user is never reported as signed in without a real session returned by
 *   Supabase: a successful `signUp` with "Confirm email" enabled produces no
 *   session, and that case is surfaced as `confirmation-required`;
 * - error messages never reveal whether an address already has an account
 *   beyond what Supabase itself allows;
 * - no secret is read in this file: only the browser client (anon key) is used.
 */

/** Minimum password length required by the interface. */
export const MIN_PASSWORD_LENGTH = 8;

export type AuthStatus = "loading" | "signed-out" | "signed-in" | "unavailable";

export type AuthSessionState = {
  status: AuthStatus;
  session: Session | null;
  user: User | null;
  /** Set when the configuration is missing or the route is unreachable. */
  message: string | null;
};

export const INITIAL_AUTH_STATE: AuthSessionState = {
  status: "loading",
  session: null,
  user: null,
  message: null,
};

/** Raised for any authentication failure, already translated for the UI. */
export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

export type SignUpResult =
  /** An e-mail was sent: no session exists yet, the user is NOT signed in. */
  | { status: "confirmation-required" }
  /** "Confirm email" is disabled: Supabase returned a real session. */
  | { status: "signed-in" }
  /**
   * The address already belongs to a confirmed account: Supabase answered with
   * an obfuscated user and sent NOTHING. Reported so the interface can stop
   * claiming an e-mail is on its way, without revealing whether the account
   * exists.
   */
  | { status: "already-registered" };

/**
 * Detect Supabase's anti-enumeration answer for an existing confirmed account.
 *
 * With "Confirm email" enabled, `signUp` never returns an error for a known
 * address: it returns a fake user whose `identities` array is empty, and sends
 * no e-mail. Everything else (a fresh sign-up, an unconfirmed address) carries
 * at least one identity, so anything that is not exactly `[]` is treated as a
 * real sign-up — an unexpected shape must never block a genuine registration.
 */
export function isObfuscatedExistingUser(identities: unknown): boolean {
  return Array.isArray(identities) && identities.length === 0;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function looksLikeEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

/**
 * Validate the form values before any network call.
 * Returns a French message, or `null` when the input is acceptable.
 */
export function validateCredentials(email: string, password: string): string | null {
  const cleanEmail = normalizeEmail(email);
  if (!cleanEmail) return "Renseignez votre adresse e-mail.";
  if (!looksLikeEmail(cleanEmail)) return "Cette adresse e-mail n'est pas valide.";
  if (!password) return "Renseignez un mot de passe.";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  return null;
}

/** Validate the two password fields of the sign-up form. */
export function validatePasswordConfirmation(password: string, confirmation: string): string | null {
  if (password !== confirmation) return "Les deux mots de passe ne correspondent pas.";
  return null;
}

/**
 * Translate a Supabase/network error.
 *
 * Deliberately generic on "invalid credentials": the same wording is used for
 * an unknown address and a wrong password, so the form cannot be used to list
 * accounts.
 */
export function describeAuthError(error: unknown): string {
  if (error instanceof AuthError) return error.message;
  if (error instanceof SupabaseConfigError) {
    return `Service de connexion indisponible : ${error.message}`;
  }

  const raw =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const text = raw.toLowerCase();

  if (!text) return "La connexion a échoué. Réessayez dans un instant.";
  if (text.includes("invalid login credentials")) {
    return "E-mail ou mot de passe incorrect.";
  }
  if (text.includes("email not confirmed")) {
    return "Confirmez d'abord votre adresse e-mail : ouvrez le lien reçu par e-mail, puis reconnectez-vous.";
  }
  if (text.includes("password should be at least") || text.includes("password is too short")) {
    return `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`;
  }
  // Supabase reports both limits with the SAME code (`over_email_send_rate_limit`)
  // and different messages. The code lives on `error.code`, not in the message,
  // so it has to be read separately — matching only the text is what left the
  // 60-second cooldown falling through to the generic "connexion échouée".
  const errorCode =
    typeof (error as { code?: unknown })?.code === "string"
      ? (error as { code: string }).code.toLowerCase()
      : "";
  const mentionsEmailRateLimit =
    errorCode === "over_email_send_rate_limit" ||
    text.includes("over_email_send_rate_limit") ||
    text.includes("email rate limit exceeded");
  const cooldown = /(?:after|dans) (\d+) secondes?/.test(text) || /after (\d+) seconds?/.test(text);

  if (mentionsEmailRateLimit || cooldown) {
    if (cooldown) {
      // Per-address cooldown: waiting a minute fixes it.
      return "Un e-mail vient d'être envoyé à cette adresse. Patientez une minute avant de redemander le lien.";
    }
    // Project-wide hourly budget of the built-in sender, or 2 e-mails/hour.
    return "Le service d'e-mail de Supabase a atteint sa limite horaire. Réessayez dans un moment.";
  }
  if (text.includes("email_address_not_authorized") || text.includes("email address not authorized")) {
    // Supabase's built-in sender only reaches the project team's own addresses.
    return "Le service d'e-mail du projet refuse cette adresse de destination. Un envoi personnalisé doit être configuré côté serveur.";
  }
  if (text.includes("rate limit") || text.includes("too many requests")) {
    return "Trop de tentatives en peu de temps. Patientez quelques minutes avant de réessayer.";
  }
  if (text.includes("signups not allowed") || text.includes("signup is disabled")) {
    return "La création de compte est momentanément désactivée.";
  }
  if (text.includes("unable to validate email") || text.includes("invalid email")) {
    return "Cette adresse e-mail n'est pas valide.";
  }
  if (text.includes("user already registered")) {
    // Supabase normally conceals this when "Confirm email" is enabled; if the
    // message does surface, keep it neutral and actionable.
    return "Un compte utilise peut-être déjà cette adresse. Essayez de vous connecter ou de réinitialiser votre mot de passe.";
  }
  if (text.includes("failed to fetch") || text.includes("network")) {
    return "Le service de connexion est injoignable. Vérifiez votre connexion, puis réessayez.";
  }
  return "La connexion a échoué. Réessayez dans un instant.";
}

/** Read the current session, or `null` when signed out. */
export async function readSession(): Promise<Session | null> {
  const client = await getSupabaseClient();
  const { data, error } = await client.auth.getSession();
  if (error) throw new AuthError(describeAuthError(error));
  return data.session ?? null;
}

/**
 * Address the confirmation e-mail must send the user back to.
 *
 * Without it, Supabase falls back to the project's **Site URL**, which is a
 * fixed deployment address: a newer Preview would send the visitor to an older
 * build. Using the origin the form was submitted from keeps the round trip on
 * the deployment the user is actually looking at.
 *
 * Nothing is returned outside a browser, or for an origin that is not a real
 * web origin (`file:`, `about:`…): GoTrue would otherwise receive an
 * unusable redirect. The value is exactly `window.location.origin`, with no
 * trailing slash and no path — it must also be listed in the project's
 * *Redirect URLs* to be accepted.
 */
export function resolveEmailRedirectUrl(
  location: { origin?: unknown } | null | undefined,
): string | undefined {
  const origin = typeof location?.origin === "string" ? location.origin.trim() : "";
  if (!origin) return undefined;
  try {
    const { protocol } = new URL(origin);
    if (protocol !== "http:" && protocol !== "https:") return undefined;
  } catch {
    return undefined;
  }
  return origin;
}

/**
 * Create an account.
 *
 * With "Confirm email" enabled (the project's setting), Supabase returns no
 * session: the caller must show "check your inbox", never "signed in".
 */
export async function signUpWithEmail(email: string, password: string): Promise<SignUpResult> {
  const cleanEmail = normalizeEmail(email);
  const invalid = validateCredentials(cleanEmail, password);
  if (invalid) throw new AuthError(invalid);

  const client = await getSupabaseClient();
  const emailRedirectTo = resolveEmailRedirectUrl(
    typeof window === "undefined" ? null : window.location,
  );
  const { data, error } = await client.auth.signUp({
    email: cleanEmail,
    password,
    // Sent as `?redirect_to=`; omitted entirely when there is no usable origin,
    // so Supabase keeps its own Site URL instead of receiving an empty value.
    ...(emailRedirectTo ? { options: { emailRedirectTo } } : {}),
  });
  if (error) throw new AuthError(describeAuthError(error));

  if (data.session) return { status: "signed-in" };

  // An existing confirmed address returns a fake user with an empty
  // `identities` array and NO e-mail. Saying "check your inbox" there is what
  // made a working sign-up look broken: the report distinguishes the two cases
  // while the wording shown to the user stays neutral.
  if (isObfuscatedExistingUser(data.user?.identities)) {
    return { status: "already-registered" };
  }

  return { status: "confirmation-required" };
}

/**
 * Ask Supabase to send the confirmation e-mail again.
 *
 * Needed because the first one can be lost, filtered, or never sent at all
 * (rate limit). The call is deliberately bare: the result is a boolean, and the
 * caller shows the same neutral message whatever happens, so this cannot be
 * turned into an account-discovery oracle.
 *
 * Supabase applies a 60-second cooldown per address and a project-wide hourly
 * quota; both surface as 429 and are translated into actionable wording.
 */
export async function resendConfirmationEmail(
  email: string,
): Promise<{ sent: boolean }> {
  const cleanEmail = normalizeEmail(email);
  if (!looksLikeEmail(cleanEmail)) throw new AuthError("Cette adresse e-mail n'est pas valide.");

  const client = await getSupabaseClient();
  const emailRedirectTo = resolveEmailRedirectUrl(
    typeof window === "undefined" ? null : window.location,
  );

  const { error } = await client.auth.resend({
    type: "signup",
    email: cleanEmail,
    ...(emailRedirectTo ? { options: { emailRedirectTo } } : {}),
  });
  if (error) throw new AuthError(describeAuthError(error));

  return { sent: true };
}

/** Sign in with e-mail and password. The session is verified before returning. */
export async function signInWithEmail(email: string, password: string): Promise<Session> {
  const cleanEmail = normalizeEmail(email);
  const invalid = validateCredentials(cleanEmail, password);
  if (invalid) throw new AuthError(invalid);

  const client = await getSupabaseClient();
  const { data, error } = await client.auth.signInWithPassword({
    email: cleanEmail,
    password,
  });
  if (error) throw new AuthError(describeAuthError(error));
  if (!data.session) {
    // Defensive: never report a signed-in state without a session.
    throw new AuthError("La connexion n'a pas abouti. Réessayez dans un instant.");
  }
  return data.session;
}

/** Sign out the current user and clear the local session. */
export async function signOut(): Promise<void> {
  const client = await getSupabaseClient();
  const { error } = await client.auth.signOut();
  if (error) throw new AuthError(describeAuthError(error));
}

/**
 * Subscribe to session changes.
 *
 * The returned function is safe to call before the client has resolved and
 * never reports a signed-in state on a configuration failure.
 */
export function subscribeToAuthChanges(
  callback: (session: Session | null) => void,
): () => void {
  let active = true;
  let unsubscribe: (() => void) | null = null;

  getSupabaseClient()
    .then((client) => {
      if (!active) return;
      const { data } = client.auth.onAuthStateChange((_event, session) => {
        callback(session ?? null);
      });
      unsubscribe = () => data.subscription.unsubscribe();
    })
    .catch(() => {
      // Configuration unavailable: the hook reports "unavailable" itself.
    });

  return () => {
    active = false;
    unsubscribe?.();
  };
}

function stateFromSession(session: Session | null): AuthSessionState {
  if (!session) return { status: "signed-out", session: null, user: null, message: null };
  return {
    status: "signed-in",
    session,
    user: session.user ?? null,
    message: null,
  };
}

/** React hook exposing the current session. */
export function useAuthSession(): AuthSessionState {
  const [state, setState] = useState<AuthSessionState>(INITIAL_AUTH_STATE);

  useEffect(() => {
    let active = true;

    const unsubscribe = subscribeToAuthChanges((session) => {
      if (!active) return;
      setState(stateFromSession(session));
    });

    readSession()
      .then((session) => {
        if (!active) return;
        setState(stateFromSession(session));
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          status: "unavailable",
          session: null,
          user: null,
          message: describeAuthError(error),
        });
      });

    return () => {
      active = false;
      unsubscribe();
    };
  }, []);

  return state;
}

/** True when the user holds a real session. */
export function isSignedIn(state: AuthSessionState): boolean {
  return state.status === "signed-in" && state.session !== null;
}

/**
 * Convenience wrapper around `signOut` for components: exposes a busy flag, an
 * already-translated error message, and whether the sign-out really happened.
 *
 * The boolean matters: `signOut` can fail (network down, revoked token). The
 * caller must not navigate away pretending the user is signed out while the
 * session is still live — it would leave a valid session behind a login form.
 */
export function useSignOut(): {
  signOutNow: () => Promise<boolean>;
  isSigningOut: boolean;
  error: string | null;
} {
  const [isSigningOut, setIsSigningOut] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signOutNow = useCallback(async (): Promise<boolean> => {
    setIsSigningOut(true);
    setError(null);
    try {
      await signOut();
      return true;
    } catch (signOutError) {
      setError(describeAuthError(signOutError));
      return false;
    } finally {
      setIsSigningOut(false);
    }
  }, []);

  return { signOutNow, isSigningOut, error };
}
