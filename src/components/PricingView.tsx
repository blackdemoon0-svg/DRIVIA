import { useMemo, useState } from "react";
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
  type PricePreviewVerdict,
  type PricingPlan,
} from "../lib/paddleCore";
import { openPaddleCheckout, readPaddleConfig, verifyAllPrices } from "../lib/paddleCheckout";

type PricingViewProps = {
  onStartFree: () => void;
};

const INTERVAL_LABELS: Record<BillingInterval, string> = {
  month: "Mensuel",
  year: "Annuel",
};

function isPaidPlan(plan: PricingPlan): plan is PricingPlan & { id: PaidPlanId } {
  return plan.id !== "decouverte";
}

export default function PricingView({ onStartFree }: PricingViewProps) {
  const [interval, setInterval] = useState<BillingInterval>("month");
  const [pendingPlan, setPendingPlan] = useState<PaidPlanId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verdicts, setVerdicts] = useState<PricePreviewVerdict[] | null>(null);

  const config = useMemo(() => readPaddleConfig(), []);
  const status = useMemo(() => validatePaddleConfig(config), [config]);
  const environmentLabel = config.environment === "sandbox" ? "Sandbox" : "Production";
  const canQueryPaddle = Boolean(config.clientToken);

  const handleCheckout = async (plan: PaidPlanId) => {
    setError(null);
    setNotice(null);
    setPendingPlan(plan);

    try {
      await openPaddleCheckout({
        plan,
        interval,
        onOpened: () =>
          setNotice(
            `Paiement ouvert dans Paddle (${environmentLabel}) : ${plan.toUpperCase()} — ${expectedAmount(plan, interval)} ${CURRENCY} / ${
              interval === "month" ? "mois" : "an"
            }.`,
          ),
        onClosed: () => setPendingPlan(null),
        onVerified: (verdict) => {
          setVerdicts((current) => [
            ...(current ?? []).filter((item) => item.priceId !== verdict.priceId),
            verdict,
          ]);
        },
        onError: (message) => {
          setError(message);
          setPendingPlan(null);
        },
      });
    } catch (checkoutError) {
      setError(classifyCheckoutError(checkoutError).message);
    } finally {
      setPendingPlan(null);
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
            À définir dans Vercel → Settings → Environment Variables, cible <strong>Preview</strong>{" "}
            uniquement, puis redéployer le Preview (les variables <code>VITE_*</code> sont figées au
            build). Le token client Paddle et les price IDs sont publics ; la clé API Paddle secrète
            ne doit jamais être exposée au navigateur.
          </p>
        </div>
      )}

      {error && (
        <div className="pricing-error" role="alert">
          {error}
        </div>
      )}

      {notice && (
        <p className="pricing-notice" role="status">
          {notice}
        </p>
      )}

      <div className="pricing-grid">
        {PRICING_PLANS.map((plan) => {
          const price = formatPlanPrice(plan, interval);
          const billingNote = planBillingNote(plan, interval);
          const paid = isPaidPlan(plan);
          const isPending = paid && pendingPlan === plan.id;
          const label = isPending ? "Vérification du tarif…" : plan.cta;
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
              </ul>

              {paid ? (
                <button
                  type="button"
                  className="pricing-cta"
                  onClick={() => void handleCheckout(plan.id)}
                  aria-busy={isPending}
                  aria-describedby={status.ready ? undefined : "pricing-config-summary"}
                >
                  {label}
                </button>
              ) : (
                <button type="button" className="pricing-cta secondary" onClick={onStartFree}>
                  {label}
                </button>
              )}

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
