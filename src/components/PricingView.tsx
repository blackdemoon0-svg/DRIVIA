import { useMemo, useState } from "react";
import {
  BILLING_INTERVALS,
  PRICING_PLANS,
  classifyCheckoutError,
  formatPlanPrice,
  planBillingNote,
  validatePaddleConfig,
  type BillingInterval,
  type PaidPlanId,
  type PricingPlan,
} from "../lib/paddleCore";
import { openPaddleCheckout, readPaddleConfig } from "../lib/paddleCheckout";

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

  const config = useMemo(() => readPaddleConfig(), []);
  const status = useMemo(() => validatePaddleConfig(config), [config]);
  const environmentLabel = config.environment === "sandbox" ? "Sandbox" : "Production";

  const handleCheckout = async (plan: PaidPlanId) => {
    setError(null);
    setNotice(null);
    setPendingPlan(plan);

    try {
      await openPaddleCheckout({
        plan,
        interval,
        onOpened: () => setNotice("Paiement ouvert dans Paddle. Aucun débit n'est effectué en Sandbox."),
        onClosed: () => setPendingPlan(null),
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
          Commencez gratuitement, puis passez à une formule payante quand vous en avez besoin.
          Paiement et facturation gérés par Paddle, résiliable à tout moment.
        </p>

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
          <span className="pricing-toggle-hint">2 mois offerts sur l'annuel</span>
        </div>
      </header>

      {!status.ready && (
        <div className="pricing-config-note" id="pricing-config-summary" role="status">
          <strong>Paiement indisponible : configuration Paddle {environmentLabel} incomplète.</strong>
          <p>
            Les boutons d'abonnement restent affichés, mais le paiement ne peut pas s'ouvrir tant que
            ces valeurs publiques manquent au build :
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
            build). Le token client Paddle et les price IDs sont publics : la clé API Paddle secrète
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
          const label = isPending ? "Ouverture du paiement…" : plan.cta;

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

              {paid && !status.ready && (
                <p className="pricing-cta-note">
                  Configuration Paddle requise : le bouton affichera l'erreur exacte.
                </p>
              )}
            </article>
          );
        })}
      </div>

      <footer className="pricing-footer">
        <p>
          Environnement Paddle : <strong>{environmentLabel}</strong>.{" "}
          {config.environment === "sandbox"
            ? "Aucun débit réel n'est effectué : le parcours complet est testable en Sandbox."
            : "Attention : cet environnement encaisse de vrais paiements."}
        </p>
        <p>
          Facturation, moyens de paiement et remboursements sont gérés par Paddle. Les tarifs affichés
          sont indicatifs ; le montant définitif est confirmé dans la fenêtre de paiement.
        </p>
      </footer>
    </main>
  );
}
