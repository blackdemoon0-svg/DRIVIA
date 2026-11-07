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
  PlanChangeError,
  describePlanChangeError,
  formatMinorAmount,
  isQuoteExpired,
  previewPlanChange,
  requestPlanChange,
  type PlanChangePreview,
  type PlanChangeQuote,
} from "../lib/paddlePlanChange";
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
  /**
   * Whether the signed-in account has a confirmed address.
   *
   * The webhook refuses to bind a subscription to an unconfirmed account, so a
   * checkout opened from one takes the money and grants nothing until the
   * address is confirmed and Paddle redelivers. The button is refused instead
   * (see `decideCta`), and the server refuses the change of formula too.
   */
  emailConfirmed: boolean;
  /** Opens the sign-in view; a paid checkout requires an account. */
  onRequireSignIn: () => void;
};

/**
 * When to re-read the account after the Paddle window closes.
 *
 * Four reads in total, then silence: a bounded confirmation, not a poll. The
 * webhook usually lands within a second or two, but network and Paddle's own
 * retries can take longer, and showing "nothing recorded" after a real payment
 * is the one answer that must not be given too early.
 */
const CHECKOUT_CONFIRMATION_DELAYS_MS = [0, 2_000, 5_000, 15_000] as const;

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "Mensuel",
  year: "Annuel",
};

/**
 * Where a plan change (Plus → Pro) stands.
 *
 * `quoting` asks Paddle what the change costs; `confirm` shows that figure and
 * waits for the customer; `applying` sends the change; `pending` means Paddle
 * accepted it and the database has not caught up yet. **None of these states is
 * "the plan changed"** — only a re-read of `subscriptions` can say that.
 */
type PlanChangeStage =
  | { kind: "idle" }
  | { kind: "quoting"; plan: PaidPlanId }
  /**
   * `quote` carries everything the confirmation will send: the plan, the
   * interval and the amount Paddle computed, signed. Deliberately *not* read
   * from the monthly/yearly toggle at confirmation time — the toggle may have
   * moved since, and what gets applied must be exactly what was shown.
   */
  | { kind: "confirm"; plan: PaidPlanId; preview: PlanChangePreview; quote: PlanChangeQuote }
  | { kind: "applying"; plan: PaidPlanId }
  | { kind: "pending"; plan: PaidPlanId };

const IDLE_CHANGE: PlanChangeStage = { kind: "idle" };

/** Button text while a change is in flight for that plan. */
function planChangeLabel(stage: PlanChangeStage, planId: string): string | null {
  if (stage.kind === "idle" || stage.plan !== planId) return null;
  switch (stage.kind) {
    case "quoting":
      return "Calcul du montant…";
    case "confirm":
      return "Confirmation attendue";
    case "applying":
      return "Changement en cours…";
    case "pending":
      return "En attente de confirmation";
  }
}

function isPaidPlan(plan: PricingPlan): plan is PricingPlan & { id: PaidPlanId } {
  return plan.id !== "decouverte";
}

export default function PricingView({
  onStartFree,
  userId,
  accessToken,
  emailConfirmed,
  onRequireSignIn,
}: PricingViewProps) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  // What the database says about this account. `checking` until the read lands:
  // nothing is claimed and nothing may be bought before then.
  const [snapshot, setSnapshot] = useState<PlanSnapshot>({ kind: "checking" });
  // The checkout in flight, if any. Never a payment: see `onClosed` below.
  const [activity, setActivity] = useState<CheckoutActivity>(IDLE_ACTIVITY);
  /** Plus → Pro, in place. Never a checkout: a second one would create a second subscription. */
  const [changeStage, setChangeStage] = useState<PlanChangeStage>(IDLE_CHANGE);
  // Synchronous re-entrancy lock: React state is applied after the handler
  // returns, so two clicks in the same tick would both see `idle` without it.
  const checkoutLock = useRef(false);
  // Same lock for the plan change. Without it, a double click on "Confirmer"
  // reads the same pre-render `confirm` state twice and sends two requests —
  // the server would refuse the second, but nothing should be sent at all.
  const changeLock = useRef(false);
  // Ticks once a second while a quote is displayed, so the countdown and the
  // expiry are visible without trusting a single render's timestamp.
  const [clock, setClock] = useState(() => Date.now());
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

  /** Every delayed confirmation is abandoned the moment the view goes away. */
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  /**
   * Background refresh: re-reads the database **without** flipping the snapshot
   * to `checking`.
   *
   * The foreground read disables every button while it runs, which is right for
   * a first load and wrong for a background check: a `focus` must not make the
   * page look like it is reloading. One read at a time, too — a burst of focus
   * events would otherwise open as many queries as events.
   */
  const reading = useRef(false);
  const refreshQuietly = useCallback(async (): Promise<PlanSnapshot | null> => {
    if (!userId || reading.current) return null;
    reading.current = true;
    try {
      const next = await readPlan();
      if (mounted.current) setSnapshot(next);
      return next;
    } finally {
      reading.current = false;
    }
  }, [userId, readPlan]);

  /** A newer confirmation supersedes the one in flight. */
  const confirmationRun = useRef(0);

  /**
   * After the Paddle window closes, ask the database — several times.
   *
   * The webhook is asynchronous: it can land seconds after the window closes,
   * and a single read would show "not registered yet" to a customer who has
   * paid. Four reads at most (immediately, then 2 s, 5 s, 15 s), stopped at the
   * first success and on unmount. Bounded on purpose: no polling loop, no
   * request every second, and nothing left running in the background.
   */
  const confirmCheckout = useCallback(
    async (plan: PaidPlanId) => {
      const runId = ++confirmationRun.current;
      for (const delay of CHECKOUT_CONFIRMATION_DELAYS_MS) {
        if (delay > 0) await new Promise((resolve) => setTimeout(resolve, delay));
        if (!mounted.current || runId !== confirmationRun.current) return;
        const next = await refreshQuietly();
        if (next && next.kind === "subscribed" && next.plan === plan) {
          if (mounted.current) setNotice(`${planLabel(plan)} est maintenant enregistré sur votre compte.`);
          return;
        }
      }
      if (mounted.current && runId === confirmationRun.current) {
        setNotice(
          "Fenêtre de paiement fermée : aucun abonnement n'est encore enregistré à votre nom. L'ouverture du paiement ne vaut pas confirmation — l'accès n'est accordé qu'après l'enregistrement de l'abonnement par Paddle, ce qui peut prendre quelques instants.",
        );
      }
    },
    [refreshQuietly],
  );

  /**
   * Coming back to the tab re-checks the account.
   *
   * A payment finished in another window, a subscription cancelled from the
   * Paddle portal, an expiry that passed while the page slept: all of these
   * change the database while this view is still mounted. One read per focus,
   * one per return to the tab, and never while another read is in flight.
   */
  useEffect(() => {
    if (!userId) return;
    const onFocus = () => {
      void refreshQuietly();
    };
    const onVisibility = () => {
      if (typeof document !== "undefined" && document.visibilityState === "visible") {
        void refreshQuietly();
      }
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [userId, refreshQuietly]);

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

  // Signing out, or signing in as someone else, must not carry over a quote,
  // an "en attente" banner or a lock from the previous account: a quote is
  // bound to one account on the server, and the screen must agree with that.
  useEffect(() => {
    changeLock.current = false;
    setChangeStage(IDLE_CHANGE);
  }, [userId]);

  // Count down only while a quote is on screen: the amount is valid for a few
  // minutes, and the customer can see how long they have left.
  useEffect(() => {
    if (changeStage.kind !== "confirm") return;
    setClock(Date.now());
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [changeStage]);

  /** Give up on a checkout whose window never appeared. */
  const releaseCheckout = () => {
    checkoutLock.current = false;
    setActivity(IDLE_ACTIVITY);
    setNotice("Paiement interrompu avant toute confirmation : votre formule n'a pas changé.");
    void refreshPlan();
  };

  /**
   * What the purchase guard sees: a checkout in flight, or a plan change in
   * flight. Both must lock every paid button — the guard has no reason to know
   * which mechanism is running, only that money may be moving.
   */
  const guardActivity: CheckoutActivity =
    activity.kind !== "idle"
      ? activity
      : changeStage.kind === "idle"
        ? IDLE_ACTIVITY
        : changeStage.kind === "pending"
          ? { kind: "open", plan: changeStage.plan }
          : { kind: "creating", plan: changeStage.plan };

  /** Ask Paddle what the change would cost. Nothing is charged by this step. */
  const startPlanChange = async (plan: PaidPlanId) => {
    // Two clicks in the same tick would otherwise send two quotes.
    if (changeLock.current) return;

    if (!userId || !accessToken) {
      setNotice("Connectez-vous à votre compte VEYVRO pour changer de formule.");
      onRequireSignIn();
      return;
    }

    changeLock.current = true;
    setError(null);
    setNotice(null);
    setChangeStage({ kind: "quoting", plan });

    try {
      const result = await previewPlanChange({ accessToken, targetPlan: plan, interval });
      // The amount is Paddle's own figure, and the quote carries the signed
      // proof of it. Both are kept for the confirmation step.
      setChangeStage({
        kind: "confirm",
        plan: result.quote.targetPlan,
        preview: result.preview,
        quote: result.quote,
      });
    } catch (changeError) {
      setError(
        changeError instanceof PlanChangeError
          ? changeError.message
          : describePlanChangeError("unexpected_error"),
      );
      setChangeStage(IDLE_CHANGE);
    } finally {
      changeLock.current = false;
    }
  };

  /** Send the change a quote describes. Paddle charges the prorated amount. */
  const confirmPlanChange = async () => {
    if (changeStage.kind !== "confirm") return;
    // One confirmation at a time: React state has not re-rendered yet, so the
    // disabled attribute alone cannot stop a second click in the same tick.
    if (changeLock.current) return;

    const { plan, quote } = changeStage;

    // An expired quote is not confirmed: the amount it quotes is no longer the
    // amount Paddle would charge.
    if (isQuoteExpired(quote, Date.now())) {
      setChangeStage(IDLE_CHANGE);
      setNotice(describePlanChangeError("quote_expired"));
      return;
    }

    changeLock.current = true;
    setError(null);
    setNotice(null);
    setChangeStage({ kind: "applying", plan });

    try {
      // The plan and the interval travel inside the signed quote: nothing here
      // re-reads the monthly/yearly toggle, which the customer may have moved.
      await requestPlanChange({ accessToken, quote });
      // Accepted, not applied: the plan still comes from the database.
      setChangeStage({ kind: "pending", plan });
    } catch (changeError) {
      setError(
        changeError instanceof PlanChangeError
          ? changeError.message
          : describePlanChangeError("unexpected_error"),
      );
      setChangeStage(IDLE_CHANGE);
    } finally {
      changeLock.current = false;
    }
  };

  const cancelPlanChange = () => {
    setChangeStage(IDLE_CHANGE);
    setNotice("Changement annulé avant tout paiement : votre formule n'a pas changé.");
  };

  /** Give up waiting for the webhook without ever claiming the plan changed. */
  const abandonPlanChange = () => {
    setChangeStage(IDLE_CHANGE);
    setNotice(
      "Attente interrompue. Votre formule reste celle enregistrée sur votre compte : la relire ci-dessus reste la seule source de vérité.",
    );
  };

  /**
   * Re-read the account, and settle a pending change only if the database now
   * shows the plan the customer asked for.
   */
  const refreshAndSettle = async () => {
    // Named `awaitedPlan` on purpose: the old checkout lock that used to carry
    // the "pending" name was released too early and must not return.
    const awaitedPlan = changeStage.kind === "pending" ? changeStage.plan : null;
    const next = await refreshPlan();

    if (awaitedPlan && next.kind === "subscribed" && next.plan === awaitedPlan) {
      setChangeStage(IDLE_CHANGE);
      setNotice(`${planLabel(awaitedPlan)} est maintenant enregistré sur votre compte.`);
    }
    return next;
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
    const decision = decideCta(plan, catalogue?.cta ?? "Choisir", snapshot, guardActivity, { emailConfirmed });
    if (decision.disabled) {
      if (decision.hint) setNotice(decision.hint);
      return;
    }

    // An upgrade must never reach this function: opening a checkout would create
    // a second Paddle subscription for a customer who already has one.
    if (decision.reason === "upgrade") {
      setNotice(decision.hint);
      void startPlanChange(plan);
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
          // database instead of assuming either way — and ask again a few times,
          // because the webhook lands on its own schedule.
          checkoutLock.current = false;
          setActivity(IDLE_ACTIVITY);
          void confirmCheckout(plan);
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

  /**
   * Single entry point for every paid button.
   *
   * An `upgrade` never opens a checkout — Paddle.js cannot modify a subscription,
   * so a second checkout would create a second subscription and a second charge.
   * It goes through the server route instead.
   */
  const handlePlanAction = (plan: PaidPlanId) => {
    const catalogue = PRICING_PLANS.find((item) => item.id === plan);
    const decision = decideCta(plan, catalogue?.cta ?? "Choisir", snapshot, guardActivity, { emailConfirmed });

    if (decision.disabled) {
      if (decision.hint) setNotice(decision.hint);
      return;
    }

    if (decision.reason === "upgrade") {
      void startPlanChange(plan);
      return;
    }

    void handleCheckout(plan);
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

  // A quote is only valid for a few minutes; the panel says so and stops
  // offering the confirmation once it has passed.
  const quoteExpired = changeStage.kind === "confirm" && isQuoteExpired(changeStage.quote, clock);
  const quoteSecondsLeft =
    changeStage.kind === "confirm"
      ? Math.max(0, Math.ceil((Date.parse(changeStage.quote.expiresAt) - clock) / 1_000))
      : 0;

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

      {changeStage.kind === "confirm" && (
        <section className="pricing-verify" aria-label="Confirmation du changement de formule">
          <h2>Passer à {planLabel(changeStage.plan)}</h2>
          <p>
            Montant calculé par Paddle au prorata de la période en cours :{" "}
            <strong>
              {formatMinorAmount(changeStage.preview.amountMinor, changeStage.preview.currencyCode)}
            </strong>{" "}
            {changeStage.preview.action === "credit"
              ? "en votre faveur."
              : "à payer maintenant."}
            {changeStage.preview.action === "charge" && changeStage.preview.amountMinor > 0
              ? ` Votre abonnement se poursuivra ensuite au tarif ${planLabel(changeStage.plan)}.`
              : ""}
          </p>
          <p>
            Le prélèvement est effectué par Paddle sur le moyen de paiement enregistré. Si le
            paiement échoue, le changement n'est pas appliqué et votre formule actuelle reste
            inchangée.
          </p>
          <p className="pricing-cta-note">
            Ce montant est garanti pour la formule {planLabel(changeStage.plan)} en{" "}
            {changeStage.quote.interval === "month" ? "mensuel" : "annuel"} pendant encore{" "}
            {Math.floor(quoteSecondsLeft / 60)} min {String(quoteSecondsLeft % 60).padStart(2, "0")} s.
            Paddle vérifie ce montant une seconde fois avant d'appliquer le changement ; s'il a
            changé, rien n'est prélevé et un nouveau calcul vous est demandé.
          </p>
          <div className="auth-actions">
            <button
              type="button"
              className="pricing-cta"
              onClick={() => void confirmPlanChange()}
              disabled={quoteExpired}
            >
              {quoteExpired
                ? "Montant expiré"
                : `Confirmer et payer ${formatMinorAmount(
                    changeStage.preview.amountMinor,
                    changeStage.preview.currencyCode,
                  )}`}
            </button>
            <button
              type="button"
              className="pricing-verify-button"
              onClick={() => void startPlanChange(changeStage.plan)}
            >
              Recalculer le montant
            </button>
            <button type="button" className="pricing-verify-button" onClick={cancelPlanChange}>
              Conserver ma formule actuelle
            </button>
          </div>
        </section>
      )}

      {changeStage.kind === "pending" && (
        <p className="pricing-notice" role="status">
          Changement envoyé à Paddle pour {planLabel(changeStage.plan)}. Votre formule reste celle
          enregistrée sur votre compte tant que l'abonnement n'a pas été mis à jour : cela peut
          prendre quelques instants.{" "}
          <button type="button" className="pricing-signin-link" onClick={() => void refreshAndSettle()}>
            Actualiser ma formule
          </button>{" "}
          <button type="button" className="pricing-signin-link" onClick={abandonPlanChange}>
            Cesser d&apos;attendre
          </button>
        </p>
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
          <button type="button" className="pricing-signin-link" onClick={() => void refreshAndSettle()}>
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
          const decision = paid
            ? decideCta(plan.id, plan.cta, snapshot, guardActivity, { emailConfirmed })
            : null;
          const isPending = guardActivity.kind === "creating" && guardActivity.plan === plan.id;
          // A change in flight on this plan says what it is doing, instead of the
          // generic "opening a payment" wording that belongs to a checkout.
          const label = (paid ? planChangeLabel(changeStage, plan.id) : null) ?? (decision ? decision.label : plan.cta);
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
                  onClick={() => handlePlanAction(plan.id)}
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
