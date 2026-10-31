-- =====================================================================
-- VEYVRO — subscriptions and webhook audit
-- =====================================================================
-- ⚠️ SUPERSEDED FOR `veyvro-preview` — DO NOT RUN ON THAT PROJECT.
--
--   `public.subscriptions` already exists there with 19 columns whose names
--   differ from the ones assumed below (`paddle_price_id` instead of
--   `price_id`, `current_period_ends_at` instead of `current_period_end`,
--   `source_updated_at` instead of `occurred_at`, uuid primary key `id`).
--   Because this file uses `create table if not exists`, it would silently do
--   nothing, leaving the code and the table mismatched.
--
--   Use `0002_align_subscriptions.sql`, which is written against the real
--   schema and is additive.
--
--   This file is kept as the reference design for a **fresh** project only.
--
-- NOT APPLIED. This file is prepared only: no SQL has been executed against
-- the `veyvro-preview` project, and nothing here changes a Supabase setting.
-- Review, then run it yourself (Supabase → SQL Editor) when you decide to.
--
-- Design notes
--   * `subscriptions` is the lean cache described by Paddle
--     (build/subscriptions/provision-access-webhooks): only the fields needed
--     to answer "does this account have access?" without calling Paddle.
--   * `webhook_events` makes delivery idempotent and auditable: Paddle
--     guarantees at-least-once delivery, so the same `event_id` can arrive
--     twice, and refusals must leave a trace.
--   * Row level security is enabled on both tables. The browser may read only
--     its own subscription and nothing else. All writes come from the webhook
--     using the service role, which bypasses RLS by design.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. Subscriptions (one row per Paddle subscription)
-- ---------------------------------------------------------------------
create table if not exists public.subscriptions (
  paddle_subscription_id text primary key,
  user_id                uuid not null references auth.users (id) on delete cascade,
  plan                   text not null check (plan in ('plus', 'pro')),
  status                 text not null check (
                           status in ('trialing', 'active', 'past_due', 'paused', 'canceled')
                         ),
  price_id               text not null,
  product_id             text,
  paddle_customer_id     text,
  current_period_end     timestamptz,
  scheduled_change_at    timestamptz,
  canceled_at            timestamptz,
  -- Timestamp of the Paddle event that produced this row. Events can arrive
  -- out of order, so the webhook compares this before applying an update.
  occurred_at            timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

comment on table public.subscriptions is
  'Paddle subscription state per VEYVRO account. Written only by api/paddle-webhook.ts (service role).';

create index if not exists subscriptions_user_id_idx
  on public.subscriptions (user_id);

-- One Paddle customer may only have ONE subscription in force at a time.
--
-- The predicate matters: Paddle reuses the same `customer_id` when a customer
-- subscribes again after cancelling. Restricting the index to the statuses that
-- actually grant access (trialing, active, past_due, paused) keeps the history
-- (cancelled rows) while still refusing a second concurrent subscription.
-- An unconditional unique index would make a re-subscription fail with 409.
create unique index if not exists subscriptions_paddle_customer_id_idx
  on public.subscriptions (paddle_customer_id)
  where paddle_customer_id is not null
    and status in ('trialing', 'active', 'past_due', 'paused');

-- ---------------------------------------------------------------------
-- 2. Webhook events (idempotency + audit)
-- ---------------------------------------------------------------------
create table if not exists public.webhook_events (
  event_id    text primary key,
  event_type  text not null,
  occurred_at timestamptz,
  received_at timestamptz not null default now(),
  status      text not null default 'received' check (
                status in ('received', 'processed', 'rejected', 'ignored')
              ),
  reason      text
);

comment on table public.webhook_events is
  'One row per Paddle event_id. Makes delivery idempotent and keeps a trace of refused events.';

-- ---------------------------------------------------------------------
-- 3. updated_at maintenance
-- ---------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists subscriptions_touch_updated_at on public.subscriptions;
create trigger subscriptions_touch_updated_at
  before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------
-- 4. Row level security
-- ---------------------------------------------------------------------
alter table public.subscriptions  enable row level security;
alter table public.webhook_events enable row level security;

-- A signed-in user may read only their own subscription.
drop policy if exists "read own subscription" on public.subscriptions;
create policy "read own subscription"
  on public.subscriptions
  for select
  to authenticated
  using (auth.uid() = user_id);

-- No insert/update/delete policy is created for `anon` or `authenticated` on
-- either table: writes therefore require the service role, which the browser
-- never has. A missing policy is the intended state, not an oversight.

-- Belt and braces: remove the default grants Supabase applies to new tables so
-- the browser cannot even attempt a write.
revoke all on public.webhook_events from anon, authenticated;
revoke all on public.subscriptions from anon;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

-- `webhook_events` is intentionally unreadable from the browser: no policy, and
-- no select grant. Only the service role (server) can see it.
