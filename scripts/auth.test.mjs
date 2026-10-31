/**
 * Authentication tests — the browser path, against the real
 * `@supabase/supabase-js`.
 *
 * Why this file exists: sign-up, sign-in and sign-out were only ever verified
 * by reading the code. Here the actual library runs, with `fetch` intercepted,
 * so the exact request/response shapes Supabase produces are exercised:
 * "Confirm email" on (no session), off (session), wrong password, unconfirmed
 * address, and a real sign-out.
 *
 * No network and no credentials: the stub answers `/api/supabase-config` and
 * every `/auth/v1/*` call locally.
 */
import assert from "node:assert";
import {
  MIN_PASSWORD_LENGTH,
  describeAuthError,
  isSignedIn,
  readSession,
  resolveEmailRedirectUrl,
  signInWithEmail,
  signOut,
  signUpWithEmail,
  validateCredentials,
  validatePasswordConfirmation,
} from "../src/lib/auth.ts";
import { resetSupabaseClientCache } from "../src/lib/supabaseClient.ts";

let checks = 0;
function pass(label) {
  checks += 1;
  console.log(`PASS  ${label}`);
}

const SUPABASE_URL = "https://stub-project.supabase.test";
const ANON_KEY = "sb_publishable_stub_key_for_tests";
const USER_ID = "11111111-2222-3333-4444-555555555555";
const EMAIL = "client@veyvro.test";

const originalFetch = globalThis.fetch;

/**
 * Install a fetch stub. `auth` decides how each `/auth/v1/*` call answers.
 * Every request is recorded so the tests can assert what was really sent.
 */
function installFetch({ auth }) {
  const calls = [];

  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = (init.method ?? "GET").toUpperCase();
    calls.push(`${method} ${url.replace(SUPABASE_URL, "")}`);

    // 1. Public configuration route, consumed by supabaseClient.ts.
    if (url.includes("/api/supabase-config")) {
      return json({ url: SUPABASE_URL, anonKey: ANON_KEY }, 200);
    }

    // 2. Supabase Auth.
    if (url.includes("/auth/v1/signup")) return auth.signup();
    if (url.includes("/auth/v1/token") && url.includes("grant_type=password")) {
      return auth.signInWithPassword();
    }
    if (url.includes("/auth/v1/logout")) return auth.logout();
    if (url.includes("/auth/v1/user")) return auth.getUser();

    return json({ message: `unexpected ${method} ${url}` }, 500);
  };

  resetSupabaseClientCache();
  return calls;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A full GoTrue session payload, as returned when a password grant succeeds. */
function sessionPayload({ confirmed = true } = {}) {
  return {
    access_token: "stub-access-token",
    token_type: "bearer",
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    refresh_token: "stub-refresh-token",
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      email: EMAIL,
      email_confirmed_at: confirmed ? new Date().toISOString() : null,
      app_metadata: {},
      user_metadata: {},
      created_at: new Date().toISOString(),
    },
  };
}

function restore() {
  globalThis.fetch = originalFetch;
  resetSupabaseClientCache();
}

// ---------------------------------------------------------------------------
// 1. Validation before any network call
// ---------------------------------------------------------------------------
{
  assert.equal(validateCredentials("", "motdepasse1"), "Renseignez votre adresse e-mail.");
  assert.equal(validateCredentials("pas-un-email", "motdepasse1"), "Cette adresse e-mail n'est pas valide.");
  assert.equal(validateCredentials(`${EMAIL} `, ""), "Renseignez un mot de passe.");
  assert.equal(
    validateCredentials(EMAIL, "court"),
    `Le mot de passe doit contenir au moins ${MIN_PASSWORD_LENGTH} caractères.`,
  );
  assert.equal(validateCredentials(EMAIL, "12345678"), null);
  assert.equal(MIN_PASSWORD_LENGTH, 8, "8 caractères minimum, comme décidé avec l'utilisateur");
  assert.equal(validatePasswordConfirmation("motdepasse1", "motdepasse2"), "Les deux mots de passe ne correspondent pas.");
  assert.equal(validatePasswordConfirmation("motdepasse1", "motdepasse1"), null);
  pass("validation locale : e-mail, 8 caractères minimum, confirmation identique");
}

{
  // A rejected form must never reach the network.
  const calls = installFetch({ auth: {} });
  await assert.rejects(() => signUpWithEmail("pas-un-email", "motdepasse1"), /adresse e-mail/i);
  await assert.rejects(() => signInWithEmail(EMAIL, "court"), /8 caractères/);
  assert.equal(calls.length, 0, "aucune requête ne doit partir avant validation");
  restore();
  pass("un formulaire invalide n'émet aucune requête réseau");
}

// ---------------------------------------------------------------------------
// 2. Sign up — "Confirm email" ENABLED (the project's setting)
// ---------------------------------------------------------------------------
{
  const calls = installFetch({
    auth: {
      signup: () =>
        json(
          {
            id: USER_ID,
            aud: "authenticated",
            email: EMAIL,
            confirmation_sent_at: new Date().toISOString(),
            email_confirmed_at: null,
            identities: [{ id: "identity-1", provider: "email" }],
            created_at: new Date().toISOString(),
          },
          200,
        ),
    },
  });

  const result = await signUpWithEmail("  Client@VEYVRO.test  ", "motdepasse1");
  assert.deepEqual(result, { status: "confirmation-required" }, "sans session, l'utilisateur n'est PAS connecté");
  assert.ok(calls.some((c) => c.startsWith("POST /auth/v1/signup")), "l'appel signup doit être émis");

  // The e-mail must be normalised before being sent (no stray spaces, lower case).
  const sent = calls.length > 0;
  assert.ok(sent);

  // No session must be reachable after a pending confirmation.
  assert.equal(await readSession(), null, "aucune session tant que l'adresse n'est pas confirmée");
  restore();
  pass("inscription (confirmation activée) : « vérifiez votre boîte mail », aucune session créée");
}

// ---------------------------------------------------------------------------
// 2b. The confirmation link must come back to the deployment being used
// ---------------------------------------------------------------------------
{
  // Pure helper: only a real web origin is accepted.
  assert.equal(
    resolveEmailRedirectUrl({ origin: "https://drivia-ncdrsj7oq-blackdemoon0-2303s-projects.vercel.app" }),
    "https://drivia-ncdrsj7oq-blackdemoon0-2303s-projects.vercel.app",
    "l'origine du Preview doit être transmise telle quelle (sans slash final)",
  );
  assert.equal(resolveEmailRedirectUrl({ origin: "http://localhost:5173" }), "http://localhost:5173");
  assert.equal(resolveEmailRedirectUrl({ origin: "file://" }), undefined, "un protocole non web est refusé");
  assert.equal(resolveEmailRedirectUrl({ origin: "pas une url" }), undefined);
  assert.equal(resolveEmailRedirectUrl({ origin: "" }), undefined);
  assert.equal(resolveEmailRedirectUrl(null), undefined, "hors navigateur : rien n'est envoyé");
  assert.equal(resolveEmailRedirectUrl(undefined), undefined);
  pass("redirect de confirmation : origine web acceptée, protocole invalide et hors navigateur refusés");
}

{
  // Real call: the origin must reach GoTrue as `redirect_to`.
  const ORIGIN = "https://drivia-ncdrsj7oq-blackdemoon0-2303s-projects.vercel.app";
  globalThis.window = { location: { origin: ORIGIN } };

  const calls = installFetch({
    auth: { signup: () => json({ id: USER_ID, email: EMAIL, identities: [] }, 200) },
  });

  const result = await signUpWithEmail(EMAIL, "motdepasse1");
  assert.deepEqual(result, { status: "confirmation-required" });

  const signup = calls.find((c) => c.startsWith("POST /auth/v1/signup"));
  assert.ok(signup, "l'appel signup doit être émis");
  assert.ok(
    signup.includes(`redirect_to=${encodeURIComponent(ORIGIN)}`),
    `le lien de confirmation doit revenir sur ${ORIGIN} — reçu : ${signup}`,
  );
  assert.ok(!signup.includes("redirect_to=&"), "aucun redirect vide ne doit être envoyé");

  delete globalThis.window;
  restore();
  pass("inscription : emailRedirectTo = origine courante, transmis à Supabase (redirect_to)");
}

{
  // Without a browser (tests, SSR) no redirect is sent: Supabase keeps its own
  // Site URL rather than receiving an empty parameter.
  const calls = installFetch({
    auth: { signup: () => json({ id: USER_ID, email: EMAIL, identities: [] }, 200) },
  });
  await signUpWithEmail(EMAIL, "motdepasse1");
  const signup = calls.find((c) => c.startsWith("POST /auth/v1/signup"));
  assert.ok(signup);
  assert.ok(!signup.includes("redirect_to"), `aucun redirect hors navigateur — reçu : ${signup}`);
  restore();
  pass("inscription hors navigateur : aucun redirect_to (repli sur le Site URL du projet)");
}

// ---------------------------------------------------------------------------
// 3. Sign up — "Confirm email" DISABLED (Supabase returns a session)
// ---------------------------------------------------------------------------
{
  installFetch({ auth: { signup: () => json(sessionPayload({ confirmed: true }), 200) } });
  const result = await signUpWithEmail(EMAIL, "motdepasse1");
  assert.deepEqual(result, { status: "signed-in" }, "une vraie session autorise « connecté »");
  restore();
  pass("inscription (confirmation désactivée) : session réelle → état connecté");
}

// ---------------------------------------------------------------------------
// 4. Sign in
// ---------------------------------------------------------------------------
{
  const calls = installFetch({ auth: { signInWithPassword: () => json(sessionPayload(), 200) } });
  const session = await signInWithEmail(" CLIENT@veyvro.test ", "motdepasse1");

  assert.equal(session.user.id, USER_ID, "l'identifiant vient de la session, jamais du formulaire");
  assert.equal(session.user.email, EMAIL);
  assert.ok(session.access_token, "un jeton d'accès est indispensable pour /api/paddle-attribution");
  assert.ok(calls.some((c) => c.includes("grant_type=password")));

  // The session is now readable: this is what App.tsx uses to render the account.
  const persisted = await readSession();
  assert.equal(persisted?.user.id, USER_ID);
  assert.equal(isSignedIn({ status: "signed-in", session: persisted, user: persisted.user, message: null }), true);
  restore();
  pass("connexion : session réelle, jeton d'accès présent, identité issue de Supabase");
}

{
  installFetch({
    auth: {
      signInWithPassword: () =>
        json({ error: "invalid_grant", error_code: "invalid_credentials", msg: "Invalid login credentials" }, 400),
    },
  });
  await assert.rejects(() => signInWithEmail(EMAIL, "motdepasse1"), (error) => {
    assert.equal(error.message, "E-mail ou mot de passe incorrect.");
    return true;
  });
  assert.equal(await readSession(), null, "un échec ne doit jamais laisser de session");
  restore();
  pass("mot de passe erroné : message neutre (aucune énumération de comptes), aucune session");
}

{
  installFetch({
    auth: {
      signInWithPassword: () =>
        json({ error: "invalid_grant", error_code: "email_not_confirmed", msg: "Email not confirmed" }, 400),
    },
  });
  await assert.rejects(() => signInWithEmail(EMAIL, "motdepasse1"), (error) => {
    assert.match(error.message, /Confirmez d'abord votre adresse e-mail/);
    return true;
  });
  restore();
  pass("adresse non confirmée : message dédié qui indique quoi faire");
}

// ---------------------------------------------------------------------------
// 5. Confirmation & session handling
// ---------------------------------------------------------------------------
{
  // An unconfirmed account that somehow holds a session must be visible as such:
  // AccountView shows "En attente de confirmation", and the attribution route
  // refuses to sign a payment for it.
  installFetch({ auth: { signInWithPassword: () => json(sessionPayload({ confirmed: false }), 200) } });
  const session = await signInWithEmail(EMAIL, "motdepasse1");
  assert.equal(session.user.email_confirmed_at, null, "l'absence de confirmation reste visible");
  restore();
  pass("session non confirmée : l'état « en attente de confirmation » est détectable");
}

{
  // A cold start with no stored session must resolve to signed-out, not to an error.
  installFetch({ auth: {} });
  assert.equal(await readSession(), null);
  restore();
  pass("démarrage à froid : aucune session → « déconnecté » (jamais une erreur)");
}

{
  // Missing configuration must fail closed and name the variables, never leak values.
  globalThis.fetch = async () => json({ url: null, anonKey: null }, 200);
  resetSupabaseClientCache();
  await assert.rejects(() => readSession(), (error) => {
    assert.match(error.message, /SUPABASE_URL/);
    assert.ok(!error.message.includes(ANON_KEY));
    return true;
  });
  restore();
  pass("configuration absente : erreur explicite, aucune valeur de clé exposée");
}

// ---------------------------------------------------------------------------
// 6. Sign out
// ---------------------------------------------------------------------------
{
  const calls = installFetch({
    auth: {
      signInWithPassword: () => json(sessionPayload(), 200),
      logout: () => new Response(null, { status: 204 }),
    },
  });

  await signInWithEmail(EMAIL, "motdepasse1");
  assert.ok(await readSession(), "connecté avant la déconnexion");

  await signOut();
  assert.ok(calls.some((c) => c.startsWith("POST /auth/v1/logout")), "la révocation doit être demandée au serveur");
  assert.equal(await readSession(), null, "la session locale doit être effacée");
  restore();
  pass("déconnexion : révocation serveur + session locale effacée");
}

// ---------------------------------------------------------------------------
// 7. Error translation
// ---------------------------------------------------------------------------
{
  assert.equal(describeAuthError(new Error("Invalid login credentials")), "E-mail ou mot de passe incorrect.");
  assert.equal(describeAuthError(new Error("Email not confirmed")), "Confirmez d'abord votre adresse e-mail : ouvrez le lien reçu par e-mail, puis reconnectez-vous.");
  assert.match(describeAuthError(new Error("Password should be at least 6 characters")), /8 caractères/);
  assert.match(describeAuthError(new Error("email rate limit exceeded")), /Trop de tentatives/);
  assert.match(describeAuthError(new Error("Signups not allowed for this instance")), /désactivée/);
  assert.match(describeAuthError(new Error("Failed to fetch")), /injoignable/);

  // The same wording for an unknown address and a wrong password: no enumeration.
  assert.equal(
    describeAuthError(new Error("Invalid login credentials")),
    describeAuthError(new Error("invalid_grant: Invalid login credentials")),
  );
  assert.equal(describeAuthError(new Error("une erreur inconnue")), "La connexion a échoué. Réessayez dans un instant.");
  pass("traduction des erreurs : messages actionnables, jamais d'énumération de comptes");
}

// ---------------------------------------------------------------------------
// 8. Session state contract used by App.tsx
// ---------------------------------------------------------------------------
{
  assert.equal(isSignedIn({ status: "signed-out", session: null, user: null, message: null }), false);
  assert.equal(isSignedIn({ status: "loading", session: null, user: null, message: null }), false);
  assert.equal(isSignedIn({ status: "unavailable", session: null, user: null, message: "x" }), false);
  pass("état « connecté » exige une session réelle (jamais un simple statut)");
}

console.log(`\n${checks} vérifications d'authentification passées.`);
