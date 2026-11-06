-- =====================================================================
-- VEYVRO — 0002: secure the EXISTING public.subscriptions, create webhook_events
-- =====================================================================
-- CONTEXT
--   `public.subscriptions` already exists in `veyvro-preview` with 19 columns.
--   Its shape differs from what `0001_subscriptions.sql` assumed
--   (`paddle_price_id` vs `price_id`, `current_period_ends_at` vs
--   `current_period_end`, `source_updated_at` vs `occurred_at`, plus a uuid
--   primary key `id`). 0001 must NOT be run on this project.
--
--   The decision taken: the CODE follows the database, not the reverse. No
--   parallel columns are created, so no data is duplicated or orphaned.
--   `entitlement.ts` and `paddle-webhook.ts` read and write the real names.
--
-- OBJECTS ALREADY PRESENT IN THE PROJECT (confirmed manually)
--   subscriptions_pkey                       primary key (id)
--   subscriptions_paddle_subscription_id_key unique index on paddle_subscription_id
--   subscriptions_user_id_idx                index on user_id
--   subscriptions_user_status_idx            index on (user_id, status)
--   subscriptions_paddle_customer_id_idx     index on paddle_customer_id, DEFINITION TO BE VERIFIED
--   subscriptions_select_own                 RLS policy: SELECT, authenticated, auth.uid() = user_id
--
-- WHAT THIS MIGRATION DOES ABOUT THEM
--   * it never assumes `create ... if not exists` is enough: that clause only
--     compares NAMES. An index whose name is taken but whose DEFINITION is
--     wrong would be silently skipped. Section 4 therefore reads
--     `pg_indexes.indexdef` and compares the real definition;
--   * it rebuilds ONLY an index that really does not apply the intended rule,
--     never a table, never a column, never a row;
--   * it detects the existing RLS policy by its semantics (cmd + role +
--     expression), not by its name, so a differently named but equivalent
--     policy is left alone instead of duplicated;
--   * it creates nothing that already exists, adds no column, deletes no row.
--
--   ADDITIVE AND REVERSIBLE IN INTENT: no DROP TABLE, no DROP COLUMN, no
--   RENAME, no DELETE, no UPDATE, no TRUNCATE. The only DROP is a conditional
--   `drop index` on an index whose definition is provably wrong, executed in
--   the same transaction that recreates it — so there is no window where the
--   rule stops being enforced, and a failure rolls everything back.
--
--   NOT APPLIED. Review and run it yourself in the Supabase SQL Editor.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Verify the existing shape before touching anything
-- ---------------------------------------------------------------------
-- If a column is missing or has an unexpected type, the migration stops here
-- with an explicit message. Without this guard the webhook would fail at
-- runtime with an opaque PostgREST error (`column ... does not exist`).
do $$
declare
  expected constant text[][] := array[
    ['id',                           'uuid'],
    ['user_id',                      'uuid'],
    ['paddle_subscription_id',       'text'],
    ['paddle_customer_id',           'text'],
    ['paddle_product_id',            'text'],
    ['paddle_price_id',              'text'],
    ['plan',                         'text'],
    ['status',                       'text'],
    ['billing_interval',             'text'],
    ['currency_code',                'text'],
    ['current_period_started_at',    'timestamp with time zone'],
    ['current_period_ends_at',       'timestamp with time zone'],
    ['scheduled_change_action',      'text'],
    ['scheduled_change_effective_at','timestamp with time zone'],
    ['paused_at',                    'timestamp with time zone'],
    ['canceled_at',                  'timestamp with time zone'],
    ['source_updated_at',            'timestamp with time zone'],
    ['created_at',                   'timestamp with time zone'],
    ['updated_at',                   'timestamp with time zone']
  ];
  i integer;
  actual_type text;
  found_count integer := 0;
  problems text := '';
begin
  for i in 1 .. array_length(expected, 1) loop
    select format_type(a.atttypid, a.atttypmod)
      into actual_type
      from pg_attribute a
      join pg_class     c on c.oid = a.attrelid
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname = 'subscriptions'
       and a.attname = expected[i][1]
       and a.attnum > 0
       and not a.attisdropped;

    if actual_type is null then
      problems := problems || format('  - %s: MANQUANTE (attendue : %s)%n', expected[i][1], expected[i][2]);
    elsif actual_type <> expected[i][2] then
      problems := problems || format('  - %s: attendu %s, trouvé %s%n', expected[i][1], expected[i][2], actual_type);
    else
      found_count := found_count + 1;
    end if;
  end loop;

  if problems <> '' then
    raise exception
      E'Migration 0002 annulée : public.subscriptions ne correspond pas au schéma attendu.\n%'
      'Rien n''a été modifié (tout est dans une transaction).\n'
      'Corrigez le script pour refléter le schéma réel, ne renommez pas les colonnes existantes.',
      problems;
  end if;

  raise notice '0002: % / % colonnes vérifiées, types conformes.', found_count, array_length(expected, 1);
end
$$;

-- ---------------------------------------------------------------------
-- 2. Make `id` self-sufficient
-- ---------------------------------------------------------------------
-- The webhook never sends `id`. If the column had no default, every insert
-- would fail with a NOT NULL violation on the primary key. Setting a default
-- changes no existing row; if one is already present this is a no-op.
alter table public.subscriptions
  alter column id set default gen_random_uuid();

-- ---------------------------------------------------------------------
-- 3. Data checks — run BEFORE any unique index is created or rebuilt
-- ---------------------------------------------------------------------
-- These are not a substitute for the index: they are what turns a cryptic
-- "could not create unique index" into a readable message that names the
-- problem and refuses, instead of deleting anything.
do $$
declare
  dup_ids integer;
  dup_customers integer;
  null_ids integer;
begin
  select count(*) into dup_ids from (
    select paddle_subscription_id
      from public.subscriptions
     where paddle_subscription_id is not null
     group by paddle_subscription_id
    having count(*) > 1
  ) d;

  if dup_ids > 0 then
    raise exception
      'Migration 0002 annulée : % valeur(s) paddle_subscription_id en double. '
      'Le webhook ne pourrait pas choisir la ligne à mettre à jour. '
      'Fusionnez ces lignes manuellement, puis relancez. Aucune modification faite.',
      dup_ids;
  end if;

  select count(*) into dup_customers from (
    select paddle_customer_id
      from public.subscriptions
     where paddle_customer_id is not null
       and status in ('trialing', 'active', 'past_due', 'paused')
     group by paddle_customer_id
    having count(*) > 1
  ) d;

  if dup_customers > 0 then
    raise exception
      'Migration 0002 annulée : % client(s) Paddle ont plusieurs abonnements en cours. '
      'C''est un problème de données, pas d''index. Vérifiez ces lignes. '
      'Aucune modification faite.',
      dup_customers;
  end if;

  select count(*) into null_ids from public.subscriptions where paddle_subscription_id is null;

  if null_ids > 0 then
    raise warning
      '0002: % ligne(s) sans paddle_subscription_id. Elles sont conservées telles quelles, '
      'ignorées par l''upsert, et n''empêchent pas l''index unique (NULL n''entre pas en conflit).',
      null_ids;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 4. Indexes — create, then VERIFY THE REAL DEFINITION
-- ---------------------------------------------------------------------
-- `CREATE INDEX IF NOT EXISTS` only compares the index NAME. An existing index
-- with the right name and the wrong definition is skipped silently, which is
-- exactly how an integration ends up "migrated" while still broken. The blocks
-- below read `pg_indexes.indexdef` and decide on the actual SQL text.
--
-- An index may be backed by a UNIQUE/PRIMARY KEY constraint: in that case it
-- cannot be dropped on its own. The blocks detect that (`pg_constraint.conindid`)
-- and refuse with an explanation instead of failing mid-way.
do $$
declare
  def          text;
  backed_by    text;
  rebuilt      boolean := false;
  wanted constant text :=
    'create unique index subscriptions_paddle_customer_id_idx '
    'on public.subscriptions (paddle_customer_id) '
    'where paddle_customer_id is not null '
    "and status in ('trialing', 'active', 'past_due', 'paused')";
begin
  -- 4a. The conflict target of the webhook upsert.
  --     `?on_conflict=paddle_subscription_id` requires a UNIQUE index on that
  --     column, and PostgreSQL can only infer a PARTIAL index when the
  --     statement repeats its predicate — so this one must stay unconditional.
  select indexdef into def
    from pg_indexes
   where schemaname = 'public'
     and tablename  = 'subscriptions'
     and indexname  = 'subscriptions_paddle_subscription_id_key';

  if def is null then
    execute 'create unique index subscriptions_paddle_subscription_id_key '
            'on public.subscriptions (paddle_subscription_id)';
    raise notice '0002: index de conflit créé (absent).';

  elsif def ilike '%CREATE UNIQUE INDEX%' and def not ilike '%WHERE%' then
    raise notice '0002: index de conflit déjà conforme.';

  else
    select con.conname into backed_by
      from pg_constraint con
      join pg_class idx on idx.oid = con.conindid
     where idx.relname = 'subscriptions_paddle_subscription_id_key';

    if backed_by is not null then
      raise exception
        'Migration 0002 annulée : l''index subscriptions_paddle_subscription_id_key '
        'porte la contrainte "%" et n''est pas un index UNIQUE simple '
        '(définition : %). Il ne peut pas être remplacé par un `drop index`. '
        'Corrigez la contrainte manuellement, puis relancez. Aucune modification faite.',
        backed_by, def;
    end if;

    execute 'drop index public.subscriptions_paddle_subscription_id_key';
    execute 'create unique index subscriptions_paddle_subscription_id_key '
            'on public.subscriptions (paddle_subscription_id)';
    raise notice '0002: index de conflit non conforme remplacé. Ancienne définition : %', def;
  end if;

  -- 4b. One customer may have only ONE subscription in force at a time.
  --     The predicate is the whole point: Paddle reuses `customer_id` after a
  --     cancellation, so an UNCONDITIONAL unique index would make any
  --     re-subscription fail with 409 and the webhook answer 503 forever.
  select indexdef into def
    from pg_indexes
   where schemaname = 'public'
     and tablename  = 'subscriptions'
     and indexname  = 'subscriptions_paddle_customer_id_idx';

  if def is null then
    execute wanted;
    raise notice '0002: index client créé (absent).';

  elsif def ilike '%CREATE UNIQUE INDEX%'
        and def ilike '%WHERE%'
        and def ilike '%paddle_customer_id%'
        and def ilike '%past_due%'
        and def ilike '%paused%'
        and def ilike '%trialing%'
        and def ilike '%active%' then
    raise notice '0002: index client déjà conforme, inchangé.';

  else
    select con.conname into backed_by
      from pg_constraint con
      join pg_class idx on idx.oid = con.conindid
     where idx.relname = 'subscriptions_paddle_customer_id_idx';

    if backed_by is not null then
      raise exception
        'Migration 0002 annulée : l''index subscriptions_paddle_customer_id_idx '
        'porte la contrainte "%" (définition : %). Il ne peut pas être remplacé '
        'par un `drop index`. Corrigez la contrainte manuellement, puis relancez. '
        'Aucune modification faite.',
        backed_by, def;
    end if;

    -- Rebuild inside the same transaction: the rule is never unenforced.
    execute 'drop index public.subscriptions_paddle_customer_id_idx';
    execute wanted;
    rebuilt := true;
    raise notice '0002: index client non conforme remplacé. Ancienne définition : %', def;
  end if;

  if rebuilt then
    raise warning
      '0002: le réabonnement d''un client existant était bloqué par l''ancien index. '
      'Il est désormais accepté : une ligne canceled n''empêche plus une nouvelle ligne active.';
  end if;
end
$$;

-- Read path: the account page filters on the signed-in user. An index on
-- `(user_id, status)` already exists and covers it, so the single-column index
-- is only created when nothing usable is present — no duplicate index.
do $$
declare
  has_covering boolean;
begin
  select exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename  = 'subscriptions'
       and (indexname = 'subscriptions_user_status_idx'
            or indexdef ilike '%(user_id, status)%'
            or indexdef ilike '%(user_id,status)%')
  ) into has_covering;

  if has_covering then
    raise notice '0002: lecture par utilisateur déjà couverte (index user_id/status). Rien à créer.';
  elsif not exists (
    select 1 from pg_indexes
     where schemaname = 'public'
       and tablename  = 'subscriptions'
       and indexname  = 'subscriptions_user_id_idx'
  ) then
    execute 'create index subscriptions_user_id_idx on public.subscriptions (user_id)';
    raise notice '0002: index user_id créé (aucun index couvrant).';
  else
    raise notice '0002: index user_id déjà présent.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Constraints — verified by name, added NOT VALID so no row is rejected
-- ---------------------------------------------------------------------
-- NOT VALID enforces the rule on every NEW write while leaving current rows
-- untouched: an existing row from an earlier manual test is never refused, and
-- never needs to be fixed or deleted before the migration can run.
--
-- These CHECKs cannot break the webhook, because the handler normalises
-- upstream: `status` is matched against the known list, `plan` comes from the
-- price-id mapping, `billing_interval` from BILLING_INTERVALS, and
-- `scheduled_change_action` / `currency_code` are validated before being sent
-- (unknown values become NULL).
do $$
declare
  added integer := 0;
  kept  integer := 0;
  user_id_attnum smallint;
begin
  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public' and rel.relname = 'subscriptions'
       and con.conname = 'subscriptions_plan_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_plan_check
      check (plan is null or plan in ('plus', 'pro')) not valid;
    added := added + 1;
  else
    kept := kept + 1;
  end if;

  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public' and rel.relname = 'subscriptions'
       and con.conname = 'subscriptions_status_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_status_check
      check (status is null or status in ('trialing', 'active', 'past_due', 'paused', 'canceled'))
      not valid;
    added := added + 1;
  else
    kept := kept + 1;
  end if;

  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public' and rel.relname = 'subscriptions'
       and con.conname = 'subscriptions_billing_interval_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_billing_interval_check
      check (billing_interval is null or billing_interval in ('month', 'year')) not valid;
    added := added + 1;
  else
    kept := kept + 1;
  end if;

  if not exists (
    select 1 from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace n on n.oid = rel.relnamespace
     where n.nspname = 'public' and rel.relname = 'subscriptions'
       and con.conname = 'subscriptions_scheduled_action_check'
  ) then
    alter table public.subscriptions
      add constraint subscriptions_scheduled_action_check
      check (scheduled_change_action is null
             or scheduled_change_action in ('cancel', 'pause', 'resume')) not valid;
    added := added + 1;
  else
    kept := kept + 1;
  end if;

  -- Deleting an account removes its subscription rows, which keeps `auth.users`
  -- and the cache consistent. Known trade-off: the billing history goes with
  -- the account. Flagged rather than silently accepted.
  ---------------------------------------------------------------------
  -- The FK is looked up by SHAPE (a foreign key from user_id to auth.users),
  -- not only by name: PostgreSQL names it `subscriptions_user_id_fkey` by
  -- default, but a differently named equivalent must not be duplicated.
  select a.attnum into user_id_attnum
    from pg_attribute a
   where a.attrelid = 'public.subscriptions'::regclass
     and a.attname  = 'user_id'
     and a.attnum > 0
     and not a.attisdropped;

  if not exists (
    select 1
      from pg_constraint con
     where con.conrelid  = 'public.subscriptions'::regclass
       and con.contype   = 'f'
       and con.confrelid = 'auth.users'::regclass
       and con.conkey    = array[user_id_attnum]
  ) then
    alter table public.subscriptions
      add constraint subscriptions_user_id_fkey
      foreign key (user_id) references auth.users (id) on delete cascade not valid;
    added := added + 1;
  else
    kept := kept + 1;
  end if;

  raise notice '0002: contraintes — % ajoutée(s) en NOT VALID, % déjà présente(s).', added, kept;
end
$$;

-- ---------------------------------------------------------------------
-- 6. Keep updated_at honest
-- ---------------------------------------------------------------------
-- Namespaced function name: a generic `touch_updated_at` would silently
-- replace a project-wide helper if one ever appears.
create or replace function public.subscriptions_touch_updated_at_fn()
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
  for each row execute function public.subscriptions_touch_updated_at_fn();

-- ---------------------------------------------------------------------
-- 7. Row level security
-- ---------------------------------------------------------------------
alter table public.subscriptions enable row level security;

-- `create policy` has no IF NOT EXISTS, and checking the NAME is not enough:
-- the project already has an equivalent policy called `subscriptions_select_own`.
-- A name-based guard would therefore create a SECOND permissive SELECT policy.
-- Two permissive policies are OR-ed, so this is not an immediate hole — but it
-- becomes one the day someone hardens `subscriptions_select_own` and the ghost
-- policy keeps granting access.
--
-- The guard below matches the SEMANTICS: a SELECT policy for `authenticated`
-- whose expression compares auth.uid() to user_id. Whatever its name, an
-- equivalent policy is left untouched.
do $$
declare
  canonical text;
begin
  select policyname into canonical
    from pg_policies
   where schemaname = 'public'
     and tablename  = 'subscriptions'
     and cmd        = 'SELECT'
     and roles::text like '%authenticated%'
     and coalesce(qual, '') ilike '%auth.uid()%'
     and coalesce(qual, '') ilike '%user_id%'
   order by policyname
   limit 1;

  if canonical is not null then
    raise notice '0002: politique SELECT « % » déjà en place et équivalente. Aucune création.', canonical;
  else
    execute 'create policy "read own subscription" on public.subscriptions '
            'for select to authenticated using (auth.uid() = user_id)';
    raise notice '0002: aucune politique SELECT équivalente — « read own subscription » créée.';
  end if;
end
$$;

-- Permissions. No write path from a browser, no access at all when anonymous.
revoke all on public.subscriptions from anon;
revoke insert, update, delete on public.subscriptions from anon, authenticated;
grant select on public.subscriptions to authenticated;

-- ---------------------------------------------------------------------
-- 8. webhook_events (does not exist yet)
-- ---------------------------------------------------------------------
-- One row per Paddle `event_id`: this is what makes delivery idempotent.
-- The primary key is the mechanism — a duplicate insert returns 409, which the
-- handler treats as "already seen" (see `recordEvent`).
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

-- If the table already existed with a different shape, the handler would fail
-- at runtime. Verify the six columns it relies on, rather than assume.
do $$
declare
  missing text;
begin
  select string_agg(c, ', ') into missing
    from unnest(array['event_id','event_type','occurred_at','received_at','status','reason']) c
   where not exists (
     select 1 from information_schema.columns
      where table_schema = 'public'
        and table_name   = 'webhook_events'
        and column_name  = c
   );

  if missing is not null then
    raise exception
      'Migration 0002 annulée : public.webhook_events existe mais il manque : %. '
      'Aucune modification faite. Vérifiez la table avant de relancer.',
      missing;
  end if;
end
$$;

comment on table public.webhook_events is
  'One row per Paddle event_id. Makes delivery idempotent and keeps a trace of refused events.';

alter table public.webhook_events enable row level security;

-- Intentionally unreadable from the browser: no policy AND no grant.
revoke all on public.webhook_events from anon, authenticated;

-- ---------------------------------------------------------------------
-- 9. Final report — read-only
-- ---------------------------------------------------------------------
do $$
declare
  total_rows bigint;
  active_rows bigint;
  dup_check integer;
  idx_customer text;
  policy_name text;
begin
  select count(*), count(*) filter (where status in ('trialing','active','past_due','paused'))
    into total_rows, active_rows
    from public.subscriptions;

  select count(*) into dup_check from (
    select paddle_subscription_id from public.subscriptions
     where paddle_subscription_id is not null
     group by paddle_subscription_id having count(*) > 1
  ) d;

  select indexdef into idx_customer
    from pg_indexes
   where schemaname = 'public' and tablename = 'subscriptions'
     and indexname = 'subscriptions_paddle_customer_id_idx';

  select string_agg(policyname, ', ') into policy_name
    from pg_policies
   where schemaname = 'public' and tablename = 'subscriptions' and cmd = 'SELECT';

  raise notice
    '0002 appliquée : % ligne(s) préservée(s), dont % en cours ; doublons : % ; webhook_events prête.',
    total_rows, active_rows, dup_check;
  raise notice '0002 : index client = %', idx_customer;
  raise notice '0002 : politique(s) SELECT sur subscriptions = %', policy_name;
end
$$;

commit;

-- =====================================================================
-- ORDER OF OPERATIONS (important)
-- =====================================================================
-- 1. Run this migration.
-- 2. Then point the Paddle notification destination at
--    https://<preview-host>/api/paddle-webhook
-- 3. Then deploy the Preview.
--
-- Why: before `webhook_events` exists, the handler answers 503 on every event
-- (it cannot deduplicate). The site keeps working; only subscription storage
-- is unavailable.
-- =====================================================================
