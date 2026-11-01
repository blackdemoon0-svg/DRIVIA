import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  BILLING_INTERVALS,
  CURRENCY,
  PRICING_PLANS,
  classifyCheckoutError,
  expectedAmount,
  formatPlanPrice,
  getPriceId,
  isSandboxPriceId,
  planBillingNote,
  validatePaddleConfig,
  type BillingInterval,
  type PaidPlanId,
  type PaddleConfig,
  type PricePreviewVerdict,
  type PricingPlan,
} from "../lib/paddleCore";
import { describeLimits, type PlanId } from "../lib/planLimits";
import { fetchOwnSubscriptionRows, planLabel } from "../lib/entitlement";
import {
  IDLE_ACTIVITY,
  decideCta,
  snapshotFromRows,
  type CheckoutActivity,
  type PlanSnapshot,
} from "../lib/purchaseGuard";
import {
  loadPaddleConfig,
  openPaddleCheckout,
  readPaddleConfig,
  verifyAllPrices,
} from "../lib/paddleCheckout";

type PricingViewProps = {
  onStartFree: () => void;
  /** Supabase id of the signed-in user, or `null` when signed out. */
  userId: string | null;
  /** Supabase access token, used once to obtain the attribution proof. */
  accessToken: string | null;
  /** Opens the sign-in view; a paid checkout requires an account. */
  onRequireSignIn: () => void;
};

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "Mensuel",
  year: "Annuel",
};

function isPaidPlan(plan: PricingPlan): plan is PricingPlan & { id: PaidPlanId } {
  return plan.id !== "decouverte";
}

export default function PricingView({ onStartFree, userId, accessToken, onRequireSignIn }: PricingViewProps) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  // What the database says about this account. `checking` until the read lands:
  // nothing is claimed and nothing may be bought before then.
  const [snapshot, setSnapshot] = useState<PlanSnapshot>({ kind: "checking" });
  // The checkout in flight, if any. Never a payment: see `onClosed` below.
  const [activity, setActivity] = useState<CheckoutActivity>(IDLE_ACTIVITY);
  // Synchronous re-entrancy lock: React state is applied after the handler
  // returns, so two clicks in the same tick would both see `idle` without it.
  const checkoutLock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verdicts, setVerdicts] = useState<PricePreviewVerdict[] | null>(null);

  // Start from what the build inlined, then complete from the server when the
  // client token was saved under a non-VITE_ name (e.g. PADDLE_CLIENT_TOKEN).
  const [config, setConfig] = useState<PaddleConfig>(() => readPaddleConfig());

  useEffect(() => {
    let active = true;
    void loadPaddleConfig().then((resolved) => {
      if (active) setConfig(resolved);
    });
    return () => {
      active = false;
    };
  }, []);

  const status = useMemo(() => validatePaddleConfig(config), [config]);
  const environmentLabel = config.environment === "sandbox" ? "Sandbox" : "Production";
  const canQueryPaddle = Boolean(config.clientToken);

  /**
   * Read the account's own rows and turn them into a guard snapshot.
   *
   * The rows come from `subscriptions` through row level security: no prop, no
   * query string and no local storage can declare a formula here. A failed read
   * becomes `unknown`, never "free" — an unreadable subscription is a reason to
   * refuse a payment, not a reason to assume there is none.
   */
  const readPlan = useCallback(async (): Promise<PlanSnapshot> => {
    if (!userId) return { kind: "free" };

    const result = await fetchOwnSubscriptionRows(userId);
    if (result.kind === "error") {
      return {
        kind: "unknown",
        message:
          result.transport === "thrown"
            ? "Votre formule n'a pas pu être vérifiée : la lecture a échoué. Aucun paiement n'est ouvert tant que ce n'est pas résolu."
            : "Votre formule est momentanément illisible. Aucun paiement n'est ouvert tant que ce n'est pas résolu.",
      };
    }
    return snapshotFromRows(result.rows, userId);
  }, [userId]);

  /** Re-read the plan, showing `checking` meanwhile so nothing can be clicked. */
  const refreshPlan = useCallback(async (): Promise<PlanSnapshot> => {
    setSnapshot({ kind: "checking" });
    const next = await readPlan();
    setSnapshot(next);
    return next;
  }, [readPlan]);

  useEffect(() => {
    let active = true;
    if (!userId) {
      // Signed out: nothing is stored for anyone, and a click leads to sign-in.
      setSnapshot({ kind: "free" });
      return;
    }
    setSnapshot({ kind: "checking" });
    void readPlan().then((next) => {
      if (active) setSnapshot(next);
    });
    return () => {
      active = false;
    };
  }, [userId, readPlan]);

  /** Give up on a checkout whose window never appeared. */
  const releaseCheckout = () => {
    checkoutLock.current = false;
    setActivity(IDLE_ACTIVITY);
    setNotice("Paiement interrompu avant toute confirmation : votre formule n'a pas changé.");
    void refreshPlan();
  };

  const handleCheckout = async (plan: PaidPlanId) => {
    // Two clicks in the same tick: React has not re-rendered yet, so the
    // disabled attribute is still absent. The lock is what actually prevents a
    // second checkout from being created — and therefore a second payment.
    if (checkoutLock.current) return;

    setError(null);
    setNotice(null);

    // An account is required before paying: the subscription is linked to the
    // user through `customData`, so a payment made while signed out could never
    // be attributed to anyone.
    if (!userId || !accessToken) {
      setNotice("Connectez-vous à votre compte VEYVRO pour choisir une formule payante.");
      onRequireSignIn();
      return;
    }

    // Belt to the button's braces: the guard is re-evaluated at click time, so a
    // stale render can never open a checkout the current state refuses.
    const catalogue = PRICING_PLANS.find((item) => item.id === plan);
    const decision = decideCta(plan, catalogue?.cta ?? "Choisir", snapshot, activity);
    if (decision.disabled) {
      if (decision.hint) setNotice(decision.hint);
      return;
    }

    checkoutLock.current = true;
    setActivity({ kind: "creating", plan });

    try {
      await openPaddleCheckout({
        plan,
        interval,
        userId,
        accessToken,
        onOpened: () =>
          // `checkout.loaded` proves a checkout exists, nothing more. The wording
          // says so, and the plan is left untouched until the database changes.
          setNotice(
            `Paiement ouvert dans Paddle (${environmentLabel}) : ${plan.toUpperCase()} — ${expectedAmount(plan, interval)} ${CURRENCY} / ${
              interval === "month" ? "mois" : "an"
            }. Votre formule ne change pas tant que l'abonnement n'est pas enregistré.`,
          ),
        onClosed: () => {
          // The window is gone; the payment may or may not have happened. Ask the
          // database instead of assuming either way.
          checkoutLock.current = false;
          setActivity(IDLE_ACTIVITY);
          void refreshPlan().then((next) => {
            const recorded = next.kind === "subscribed" && next.plan === plan;
            setNotice(
              recorded
                ? `${planLabel(plan)} est maintenant enregistré sur votre compte.`
                : "Fenêtre de paiement fermée : aucun abonnement n'est encore enregistré à votre nom. L'ouverture du paiement ne vaut pas confirmation — l'accès n'est accordé qu'après l'enregistrement de l'abonnement par Paddle, ce qui peut prendre quelques instants.",
            );
          });
        },
        onVerified: (verdict) => {
          setVerdicts((current) => [
            ...(current ?? []).filter((item) => item.priceId !== verdict.priceId),
            verdict,
          ]);
        },
        onError: (message) => {
          setError(message);
          checkoutLock.current = false;
          setActivity(IDLE_ACTIVITY);
        },
      });

      // `Checkout.open()` returned without throwing: the window exists even if
      // `checkout.loaded` has not fired yet. Still not a payment.
      setActivity((current) =>
        current.kind === "creating" && current.plan === plan ? { kind: "open", plan } : current,
      );
    } catch (checkoutError) {
      setError(classifyCheckoutError(checkoutError).message);
      // Release here, not in a `finally`: the click must not become available
      // again while the overlay is open, or a second payment could be started.
      checkoutLock.current = false;
      setActivity(IDLE_ACTIVITY);
    }
  };

  const handleVerifyPrices = async () => {
    setError(null);
    setNotice(null);
    setVerifying(true);
    try {
      const results = await verifyAllPrices(config);
      setVerdicts(results);
      setNotice(
        results.every((result) => result.ok)
          ? "Les price IDs configurés correspondent aux tarifs annoncés (devise USD et montants exacts)."
          : "Au moins un price ID ne correspond pas au tarif annoncé : voir le détail ci-dessous.",
      );
    } catch (verifyError) {
      setError(classifyCheckoutError(verifyError).message);
    } finally {
      setVerifying(false);
    }
  };

  return (
    <main className="pricing-stage" id="pricing" aria-labelledby="pricing-title">
      <header className="pricing-intro">
        <p className="eyebrow">
          <span className="eyebrow-dot" /> ABONNEMENT VEYVRO
        </p>
        <h1 id="pricing-title">
          Choisissez votre <span>formule</span>
        </h1>
        <p className="pricing-subtitle">
          Commencez gratuitement, puis passez à VEYVRO Plus ou VEYVRO Pro. Paiement et facturation
          gérés par Paddle, résiliable à tout moment.
        </p>
        <p className="pricing-currency">Tarifs en dollars américains (USD, $)</p>

        <div className="pricing-toggle" role="group" aria-label="Périodicité de facturation">
          {BILLING_INTERVALS.map((value) => (
            <button
              key={value}
              type="button"
              className={interval === value ? "pricing-toggle-option active" : "pricing-toggle-option"}
              aria-pressed={interval === value}
              onClick={() => setInterval(value)}
            >
              {INTERVAL_LABELS[value]}
            </button>
          ))}
          <span className="pricing-toggle-hint">Économisez jusqu'à 30 % sur l'annuel</span>
        </div>
      </header>

      {!status.ready && (
        <div className="pricing-config-note" id="pricing-config-summary" role="status">
          <strong>Paiement indisponible : configuration Paddle {environmentLabel} incomplète.</strong>
          <p>
            Les formules et les boutons restent affichés, mais le paiement ne peut pas s'ouvrir tant
            que ces valeurs publiques manquent au build :
          </p>
          <ul>
            {status.missingKeys.map((key) => (
              <li key={key}>
                <code>{key}</code>
              </li>
            ))}
          </ul>
          <p className="pricing-config-hint">
            Deux noms acceptés dans Vercel → Settings → Environment Variables, cible{" "}
            <strong>Preview</strong> : <code>PADDLE_CLIENT_TOKEN</code> (lu côté serveur par{" "}
            <code>/api/paddle-config</code>, actif immédiatement) ou{" "}
            <code>VITE_PADDLE_CLIENT_TOKEN</code> (inliné au build, nécessite un redéploiement du
            Preview). Le token client Paddle et les price IDs sont publics ; la clé API Paddle
            secrète ne doit jamais être exposée au navigateur.
          </p>
        </div>
      )}

      {error && (
        <div className="pricing-error" role="alert">
          {error}
        </div>
      )}

      {snapshot.kind === "unknown" && (
        <div className="pricing-error" role="alert">
          {snapshot.message}{" "}
          <button type="button" className="pricing-signin-link" onClick={() => void refreshPlan()}>
            Réessayer la vérification
          </button>
        </div>
      )}

      {userId && activity.kind !== "idle" && (
        <p className="pricing-notice" role="status">
          {activity.kind === "creating"
            ? "Ouverture du paiement… Merci de ne pas fermer cette page."
            : "Fenêtre de paiement Paddle ouverte. Aucun débit n'est considéré comme confirmé avant l'enregistrement de l'abonnement."}{" "}
          <button type="button" className="pricing-signin-link" onClick={releaseCheckout}>
            La fenêtre ne s&apos;est pas ouverte ?
          </button>
        </p>
      )}

      {notice && (
        <p className="pricing-notice" role="status">
          {notice}
        </p>
      )}

      {userId && (
        <p className="pricing-signin-note" role="status">
          {snapshot.kind === "subscribed"
            ? `Formule lue sur votre compte : ${planLabel(snapshot.plan)}.`
            : snapshot.kind === "free"
              ? "Aucune formule payante enregistrée sur votre compte : la formule Découverte s'applique."
              : "Formule en cours de vérification sur votre compte."}{" "}
          <button type="button" className="pricing-signin-link" onClick={() => void refreshPlan()}>
            Actualiser ma formule
          </button>
        </p>
      )}

      {!userId && (
        <p className="pricing-signin-note" role="status">
          Un compte VEYVRO est nécessaire pour souscrire : il permet de rattacher l'abonnement à
          votre identité.{" "}
          <button type="button" className="pricing-signin-link" onClick={onRequireSignIn}>
            Se connecter ou créer un compte
          </button>
        </p>
      )}

      <div className="pricing-grid">
        {PRICING_PLANS.map((plan) => {
          const price = formatPlanPrice(plan, interval);
          const billingNote = planBillingNote(plan, interval);
          const paid = isPaidPlan(plan);
          // One decision per card, taken from the guard: it owns whether the
          // button may be pressed, what it says, and why it is refused.
          const decision = paid ? decideCta(plan.id, plan.cta, snapshot, activity) : null;
          const isPending = activity.kind === "creating" && activity.plan === plan.id;
          const label = decision ? decision.label : plan.cta;
          const planPriceId = paid ? getPriceId(config, plan.id, interval) : null;

          return (
            <article
              key={plan.id}
              className={`pricing-card${plan.featured ? " featured" : ""}`}
              aria-labelledby={`plan-${plan.id}-name`}
            >
              <header className="pricing-card-head">
                <h2 id={`plan-${plan.id}-name`}>{plan.name}</h2>
                {plan.badge && <span className="pricing-badge">{plan.badge}</span>}
              </header>

              <p className="pricing-tagline">{plan.tagline}</p>

              <p className="pricing-price">
                <span className="pricing-amount">{price}</span>
                {paid && <span className="pricing-currency-tag">{CURRENCY}</span>}
              </p>
              <p className="pricing-billing-note">{billingNote}</p>

              <ul className="pricing-features">
                {plan.features.map((feature) => (
                  <li key={feature}>{feature}</li>
                ))}
                {/* Generated from the table the server enforces, so the page
                    cannot promise a quota the handler would refuse. */}
                <li className="pricing-quota">{describeLimits(plan.id as PlanId)}</li>
              </ul>

              {paid && decision ? (
                <button
                  type="button"
                  className="pricing-cta"
                  onClick={() => void handleCheckout(plan.id)}
                  disabled={decision.disabled}
                  aria-busy={isPending}
                  data-cta-reason={decision.reason}
                  aria-describedby={status.ready ? undefined : "pricing-config-summary"}
                >
                  {label}
                </button>
              ) : (
                <button type="button" className="pricing-cta secondary" onClick={onStartFree}>
                  {label}
                </button>
              )}

              {decision?.hint && <p className="pricing-cta-note">{decision.hint}</p>}

              {paid && planPriceId && (
                <p className="pricing-price-id">
                  price ID&nbsp;: <code>{planPriceId}</code>
                  {config.environment === "sandbox" && isSandboxPriceId(planPriceId) && (
                    <span className="pricing-price-id-tag">Sandbox</span>
                  )}
                </p>
              )}
              {paid && !planPriceId && (
                <p className="pricing-cta-note">
                  Price ID manquant pour la formule {plan.name} ({interval === "month" ? "mensuel" : "annuel"}).
                </p>
              )}
            </article>
          );
        })}
      </div>

      {verdicts && verdicts.length > 0 && (
        <section className="pricing-verify" aria-label="Vérification des price IDs Paddle">
          <h2>Vérification auprès de Paddle</h2>
          <ul>
            {verdicts.map((verdict) => (
              <li key={`${verdict.priceId}-${verdict.interval}`} className={verdict.ok ? "ok" : "ko"}>
                <span aria-hidden="true">{verdict.ok ? "✓" : "✗"}</span>
                <span>
                  <strong>
                    {verdict.plan.toUpperCase()} {verdict.interval === "month" ? "mensuel" : "annuel"}
                  </strong>{" "}
                  — <code>{verdict.priceId}</code> : Paddle annonce{" "}
                  {verdict.amount === null ? "montant illisible" : `${verdict.amount} ${verdict.currency ?? "?"}`}{" "}
                  / attendu {verdict.expectedAmount} {CURRENCY}
                  {verdict.ok ? "" : ` — ${verdict.problems.join(" ")}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="pricing-footer">
        <p>
          Environnement Paddle : <strong>{environmentLabel}</strong>.{" "}
          {config.environment === "sandbox"
            ? "Aucun débit réel n'est effectué : le parcours complet est testable en Sandbox."
            : "Attention : cet environnement encaisse de vrais paiements."}
        </p>
        {canQueryPaddle && (
          <p>
            <button
              type="button"
              className="pricing-verify-button"
              onClick={() => void handleVerifyPrices()}
              aria-busy={verifying}
            >
              {verifying ? "Vérification…" : "Vérifier les price IDs auprès de Paddle"}
            </button>
          </p>
        )}
        <p>
          Facturation, moyens de paiement et remboursements sont gérés par Paddle. Chaque paiement est
          refusé si la devise ou le montant renvoyé par Paddle ne correspond pas exactement au tarif
          affiché.
        </p>
      </footer>
    </main>
  );
}
