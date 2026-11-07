-- =====================================================================
-- VEYVRO — 0003: durable AI usage quotas (consume / refund / read)
-- =====================================================================
-- WHAT THIS MIGRATION CREATES
--   public.ai_usage_daily    one row per (account, UTC day): the counters
--   public.ai_usage_events   one row per consumption_id: the ledger + the
--                            attempt counter + the refund state
--   public.ai_usage_consume  charge one message, atomically and idempotently
--   public.ai_usage_refund   give one message back, idempotently
--   public.ai_usage_read     read one day's counters, read-only
--
-- WHY TWO TABLES
--   The counter alone cannot answer "did this exact message already pay?".
--   The ledger row is what makes a retry a no-op instead of a second charge,
--   and what makes a refund land on the day that was actually charged.
--
-- WHAT IS GUARANTEED BY CONSTRUCTION
--   * one consumption = ONE SQL function call = ONE transaction: the ledger
--     insert and the counter increment cannot be separated, so there is no
--     state where a message is counted without a trace, or traced without
--     being counted;
--   * concurrency: the primary key of ai_usage_events serialises two calls
--     that carry the same consumption_id, and the counter is incremented by a
--     single conditional upsert whose WHERE carries the limit. There is no
--     read-then-write window, so two parallel callers cannot both take the
--     last unit;
--   * a quota refusal leaves NOTHING behind: the freshly inserted claim is
--     deleted in the same transaction, and no counter is touched;
--   * a refund is idempotent (only the first consumed → refunded transition
--     decrements) and applies to the day stored on the event, never to
--     "today" — a refund at 00:00:05 for a 23:59:59 message corrects the day
--     that was actually charged;
--   * a refunded identifier can be consumed again, at most 3 times in total;
--   * the server (service_role) holds NO privilege on either table: it can
--     only go through the three functions, so a future refactor cannot
--     reintroduce a non-atomic path — the request would simply fail.
--
-- WHAT IS *NOT* GUARANTEED HERE, AND MUST BE PROVEN BY RUNNING IT
--   Nothing in this file has been executed. Every claim above is a property of
--   the code below, to be verified in P3 (catalogue probes + single-statement
--   trials in the Preview SQL Editor) and P4 (the live suite). Until then, no
--   comment in `server/usageStore.ts` may state more than "obligation".
--
-- NOT APPLIED. Prepared only: no SQL has been executed against any Supabase
-- project. Review, then run it yourself in the Preview SQL Editor (P3).
--
-- CONVENTIONS (same as 0001 / 0002)
--   * one transaction: exactly one `begin;` and one `commit;`;
--   * idempotent on re-run: `create ... if not exists`, `create or replace`,
--     `drop trigger if exists`, grants/revokes;
--   * the shape is VERIFIED before anything is assumed: a pre-existing table
--     with unexpected columns, a missing primary key or missing CHECK
--     constraints stops the migration instead of being silently reused;
--   * no DROP TABLE, no DROP COLUMN, no RENAME, no TRUNCATE. The only DROP is
--     on the functions and the trigger this file owns and recreates;
--   * the two tables are written ONLY by the SECURITY DEFINER functions
--     below. The UPDATE and DELETE statements visible further down live
--     inside those functions and touch nothing else.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------
-- `usage_day` is a UTC date, computed by the functions from `now()` (or from
-- the test-only `p_now`). Storing the day on the row — rather than deriving it
-- from created_at — is what lets a refund at 00:00:05 correct the previous day.
create table if not exists public.ai_usage_daily (
  user_id     uuid        not null references auth.users (id) on delete cascade,
  usage_day   date        not null,
  messages    integer     not null default 0 check (messages >= 0),
  quotes      integer     not null default 0 check (quotes >= 0),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  -- One row per account per day: the upsert below depends on this exact key.
  constraint ai_usage_daily_pkey primary key (user_id, usage_day)
);

comment on table public.ai_usage_daily is
  'Durable per-account, per-UTC-day AI usage counters. Written only by public.ai_usage_consume / ai_usage_refund (SECURITY DEFINER); service_role holds no table privilege.';

comment on column public.ai_usage_daily.messages is
  'Messages consumed on that UTC day, after refunds. Never negative (checked).';
comment on column public.ai_usage_daily.quotes is
  'Garage-quote analyses consumed on that UTC day, after refunds. Never negative (checked).';

-- The ledger. `consumption_id` is produced by the server from the verified
-- account id and the client request id (server/consumptionId.ts), so a client
-- can never choose the key of a row that grants it a free message.
create table if not exists public.ai_usage_events (
  consumption_id uuid        not null,
  user_id        uuid        not null references auth.users (id) on delete cascade,
  usage_day      date        not null,
  is_quote       boolean     not null,
  state          text        not null default 'consumed'
                             check (state in ('consumed', 'refunded')),
  -- Number of times this identifier has been consumed. 1 on first use, +1 on
  -- each accepted re-consumption after a refund. The hard ceiling is 3; the
  -- functions refuse the 4th attempt BEFORE the point where this check could
  -- ever fire, so a refusal is a clean verdict, never an error.
  attempts       integer     not null default 1 check (attempts between 1 and 3),
  created_at     timestamptz not null default now(),
  refunded_at    timestamptz,
  updated_at     timestamptz not null default now(),
  constraint ai_usage_events_pkey primary key (consumption_id)
);

comment on table public.ai_usage_events is
  'One row per consumption_id: idempotency ledger, attempt counter and refund state. Written only by the SECURITY DEFINER functions.';
comment on column public.ai_usage_events.state is
  'consumed: the message has been charged. refunded: it has been given back and may be consumed again (attempts < 3).';
comment on column public.ai_usage_events.usage_day is
  'UTC day the CURRENT consumption is charged on. Moved to the new day only on an accepted re-consumption after a refund.';

-- ---------------------------------------------------------------------
-- 2. Verify the structure before assuming it
-- ---------------------------------------------------------------------
-- `create table if not exists` only compares NAMES. A pre-existing table with
-- an unexpected column, a column that lost its NOT NULL, a missing default, a
-- weakened CHECK or a foreign key pointing elsewhere would be silently reused,
-- and the upserts below would then write into a table that cannot enforce the
-- rules. Every block of this section stops the migration instead of reusing a
-- doubtful table: nothing is modified, and the operator can look.

-- 2a. Columns, types, superfluous columns, NOT NULL and defaults
do $$
declare
  expected constant text[][] := array[
    ['user_id',    'uuid'],
    ['usage_day',  'date'],
    ['messages',   'integer'],
    ['quotes',     'integer'],
    ['created_at', 'timestamp with time zone'],
    ['updated_at', 'timestamp with time zone']
  ];
  i         integer;
  actual    text;
  n_cols    integer;
  manquants text;
begin
  for i in 1 .. array_length(expected, 1) loop
    select data_type into actual
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'ai_usage_daily'
       and column_name  = expected[i][1];

    if actual is null then
      raise exception
        'Migration 0003 annulée : public.ai_usage_daily n''a pas de colonne « % ». Aucune modification faite.',
        expected[i][1];
    elsif actual <> expected[i][2] then
      raise exception
        'Migration 0003 annulée : public.ai_usage_daily.% est de type « % » au lieu de « % ». Aucune modification faite.',
        expected[i][1], actual, expected[i][2];
    end if;
  end loop;

  -- A foreign table may carry columns this file knows nothing about; a row-level
  -- insert that omits them would then rely on defaults nobody verified.
  select count(*) into n_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_usage_daily';

  if n_cols <> 6 then
    raise exception
      'Migration 0003 annulée : public.ai_usage_daily a % colonnes au lieu de 6 (colonne surnuméraire ?). Aucune modification faite.',
      n_cols;
  end if;

  -- NOT NULL is what keeps the arithmetic total: a NULL counter would turn
  -- `u.messages + 1` into NULL, and the limit test would then be unknown
  -- instead of false.
  select string_agg(column_name, ', ' order by column_name) into manquants
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'ai_usage_daily'
     and column_name in ('user_id', 'usage_day', 'messages', 'quotes', 'created_at', 'updated_at')
     and is_nullable <> 'NO';

  if manquants is not null then
    raise exception
      'Migration 0003 annulée : public.ai_usage_daily.% sans NOT NULL. Aucune modification faite.',
      manquants;
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_usage_daily'
       and column_name = 'messages' and column_default = '0'
  ) then
    raise exception
      'Migration 0003 annulée : public.ai_usage_daily.messages n''a pas de valeur par défaut à 0. Aucune modification faite.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_usage_daily'
       and column_name = 'quotes' and column_default = '0'
  ) then
    raise exception
      'Migration 0003 annulée : public.ai_usage_daily.quotes n''a pas de valeur par défaut à 0. Aucune modification faite.';
  end if;

  select string_agg(column_name, ', ' order by column_name) into manquants
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'ai_usage_daily'
     and column_name in ('created_at', 'updated_at')
     and (column_default is null or column_default !~ 'now\(\)');

  if manquants is not null then
    raise exception
      'Migration 0003 annulée : public.ai_usage_daily.% n''a pas de défaut now(). Aucune modification faite.',
      manquants;
  end if;
end
$$;

do $$
declare
  expected constant text[][] := array[
    ['consumption_id', 'uuid'],
    ['user_id',        'uuid'],
    ['usage_day',      'date'],
    ['is_quote',       'boolean'],
    ['state',          'text'],
    ['attempts',       'integer'],
    ['created_at',     'timestamp with time zone'],
    ['refunded_at',    'timestamp with time zone'],
    ['updated_at',     'timestamp with time zone']
  ];
  i         integer;
  actual    text;
  n_cols    integer;
  manquants text;
begin
  for i in 1 .. array_length(expected, 1) loop
    select data_type into actual
      from information_schema.columns
     where table_schema = 'public'
       and table_name   = 'ai_usage_events'
       and column_name  = expected[i][1];

    if actual is null then
      raise exception
        'Migration 0003 annulée : public.ai_usage_events n''a pas de colonne « % ». Aucune modification faite.',
        expected[i][1];
    elsif actual <> expected[i][2] then
      raise exception
        'Migration 0003 annulée : public.ai_usage_events.% est de type « % » au lieu de « % ». Aucune modification faite.',
        expected[i][1], actual, expected[i][2];
    end if;
  end loop;

  select count(*) into n_cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'ai_usage_events';

  if n_cols <> 9 then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events a % colonnes au lieu de 9 (colonne surnuméraire ?). Aucune modification faite.',
      n_cols;
  end if;

  -- `refunded_at` is the one column that must stay nullable: a consumed event
  -- has no refund timestamp.
  select string_agg(column_name, ', ' order by column_name) into manquants
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'ai_usage_events'
     and column_name in ('consumption_id', 'user_id', 'usage_day', 'is_quote',
                         'state', 'attempts', 'created_at', 'updated_at')
     and is_nullable <> 'NO';

  if manquants is not null then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events.% sans NOT NULL. Aucune modification faite.',
      manquants;
  end if;

  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_usage_events'
       and column_name = 'refunded_at' and is_nullable <> 'YES'
  ) then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events.refunded_at doit rester NULLable. Aucune modification faite.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_usage_events'
       and column_name = 'attempts' and column_default = '1'
  ) then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events.attempts n''a pas de valeur par défaut à 1. Aucune modification faite.';
  end if;

  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ai_usage_events'
       and column_name = 'state' and column_default ~ 'consumed'
  ) then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events.state n''a pas pour défaut « consumed ». Aucune modification faite.';
  end if;

  select string_agg(column_name, ', ' order by column_name) into manquants
    from information_schema.columns
   where table_schema = 'public'
     and table_name   = 'ai_usage_events'
     and column_name in ('created_at', 'updated_at')
     and (column_default is null or column_default !~ 'now\(\)');

  if manquants is not null then
    raise exception
      'Migration 0003 annulée : public.ai_usage_events.% n''a pas de défaut now(). Aucune modification faite.',
      manquants;
  end if;
end
$$;

-- The primary keys are load-bearing, not decorative: the ledger key serialises
-- concurrent calls, and (user_id, usage_day) is the conflict target of the
-- counter upsert. A table without them would accept duplicates silently.
do $$
declare
  pk_daily  text;
  pk_events text;
begin
  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_daily
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
   where n.nspname = 'public' and t.relname = 'ai_usage_daily' and c.contype = 'p';

  if pk_daily is distinct from 'user_id,usage_day' then
    raise exception
      'Migration 0003 annulée : la clé primaire de public.ai_usage_daily est « % » au lieu de (user_id, usage_day).',
      coalesce(pk_daily, 'absente');
  end if;

  select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
    into pk_events
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
    join pg_attribute a on a.attrelid = t.oid and a.attnum = any (c.conkey)
   where n.nspname = 'public' and t.relname = 'ai_usage_events' and c.contype = 'p';

  if pk_events is distinct from 'consumption_id' then
    raise exception
      'Migration 0003 annulée : la clé primaire de public.ai_usage_events est « % » au lieu de (consumption_id).',
      coalesce(pk_events, 'absente');
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 2b. Verify the invariants themselves, by their real definition
--
-- A table with the right name, the right columns and the right primary key
-- could still carry weakened CHECK constraints. Counting them, or trusting
-- their names, proves nothing: `check (messages >= 0 or true)` carries the
-- same name as the constraint this file creates, contains every expected word,
-- and guarantees nothing at all.
--
-- So each definition is read back with pg_get_constraintdef and must pass four
-- independent conditions:
--   * `convalidated` — a NOT VALID constraint is not applied to existing rows,
--     so it can sit there looking correct while enforcing nothing;
--   * no OR anywhere — an alternative is the canonical way to neutralise an
--     invariant while keeping its words;
--   * no boolean literal — `or true` and `or 1=1` style escapes;
--   * an EXACT normalised form. PostgreSQL renders `between 1 and 3` as
--     `>= 1 AND <= 3`, and `in ('a','b')` as `= ANY (ARRAY[...])`; once
--     lowercased and stripped of spaces and parentheses, each definition must
--     equal the expected string, character for character.
-- ---------------------------------------------------------------------
do $$
declare
  attendus constant text[][] := array[
    ['ai_usage_daily',  'ai_usage_daily_messages_check',  'messages>=0'],
    ['ai_usage_daily',  'ai_usage_daily_quotes_check',    'quotes>=0'],
    ['ai_usage_events', 'ai_usage_events_state_check',    'state=anyarray[''consumed''::text,''refunded''::text]'],
    ['ai_usage_events', 'ai_usage_events_attempts_check', 'attempts>=1andattempts<=3']
  ];
  i      integer;
  def    text;
  norme  text;
  valide boolean;
  n_ch   integer;
begin
  for i in 1 .. array_length(attendus, 1) loop
    select pg_get_constraintdef(c.oid), c.convalidated
      into def, valide
      from pg_constraint c
      join pg_class     t on t.oid = c.conrelid
      join pg_namespace n on n.oid = t.relnamespace
     where n.nspname = 'public'
       and t.relname = attendus[i][1]
       and c.contype = 'c'
       and c.conname = attendus[i][2];

    if def is null then
      raise exception
        'Migration 0003 annulée : la contrainte « %.% » est absente. Aucune modification faite.',
        attendus[i][1], attendus[i][2];
    end if;

    if not valide then
      raise exception
        'Migration 0003 annulée : la contrainte « %.% » n''est pas validée (convalidated = false) : elle ne couvre pas les lignes existantes. Aucune modification faite.',
        attendus[i][1], attendus[i][2];
    end if;

    -- `\y` est la frontière de mot de PostgreSQL : `\yor\y` ne se déclenche ni
    -- sur « format » ni sur « order », seulement sur le mot « or ».
    if def ~* '\yor\y' then
      raise exception
        'Migration 0003 annulée : la contrainte « %.% » contient un OR (définition réelle : %). Une alternative annule la garantie. Aucune modification faite.',
        attendus[i][1], attendus[i][2], def;
    end if;

    if def ~* '\ytrue\y' or def ~* '\yfalse\y' then
      raise exception
        'Migration 0003 annulée : la contrainte « %.% » contient un littéral booléen (définition réelle : %). Aucune modification faite.',
        attendus[i][1], attendus[i][2], def;
    end if;

    norme := regexp_replace(lower(def), '[[:space:]()]', '', 'g');
    norme := regexp_replace(norme, '^check', '');

    if norme <> attendus[i][3] then
      raise exception
        'Migration 0003 annulée : « %.% » ne correspond pas à l''invariant attendu. Attendu (normalisé) : « % ». Réel (normalisé) : « % ». Définition réelle : %. Aucune modification faite.',
        attendus[i][1], attendus[i][2], attendus[i][3], norme, def;
    end if;
  end loop;

  -- No fifth CHECK: an extra constraint means a table whose rules were written
  -- by someone else, and this file's guarantees would then be partial.
  select count(*) into n_ch
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname in ('ai_usage_daily', 'ai_usage_events')
     and c.contype = 'c';

  if n_ch <> 4 then
    raise exception
      'Migration 0003 annulée : % contraintes CHECK sur les deux tables au lieu de 4 (règle étrangère ?). Aucune modification faite.',
      n_ch;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 2c. Foreign keys — the account, the column, and the cascade
--
-- Both tables reference auth.users with ON DELETE CASCADE (the convention of
-- 0001 and 0002). A missing foreign key would let counters outlive the
-- account; a foreign key on the wrong column, or one that is NOT VALID, would
-- look right in a listing and enforce nothing. The catalog is read precisely:
-- the local column must be user_id, the referenced column must be id, the
-- deleted-row action must be CASCADE, and the constraint must be validated.
-- ---------------------------------------------------------------------
do $$
declare
  tables_  constant text[] := array['ai_usage_daily', 'ai_usage_events'];
  t        text;
  def      text;
  locale   text;
  distante text;
  valide   boolean;
  deltype  text;
  n_cols   integer;
  n_fk     integer;
begin
  foreach t in array tables_ loop
    select pg_get_constraintdef(c.oid),
           a.attname,
           fa.attname,
           c.convalidated,
           c.confdeltype::text,
           coalesce(array_length(c.conkey, 1), 0)
      into def, locale, distante, valide, deltype, n_cols
      from pg_constraint c
      join pg_class     tb on tb.oid = c.conrelid
      join pg_namespace n  on n.oid  = tb.relnamespace
      join pg_class     ct on ct.oid = c.confrelid
      join pg_namespace cn on cn.oid = ct.relnamespace
      join pg_attribute a  on a.attrelid  = c.conrelid  and a.attnum  = c.conkey[1]
      join pg_attribute fa on fa.attrelid = c.confrelid and fa.attnum = c.confkey[1]
     where n.nspname = 'public'
       and tb.relname = t
       and c.contype  = 'f'
       and cn.nspname = 'auth'
       and ct.relname = 'users';

    if def is null then
      raise exception
        'Migration 0003 annulée : public.% ne référence pas auth.users. Aucune modification faite.', t;
    end if;

    if n_cols <> 1 then
      raise exception
        'Migration 0003 annulée : la clé étrangère de public.% porte sur % colonnes au lieu d''une seule. Aucune modification faite.',
        t, n_cols;
    end if;

    if locale is distinct from 'user_id' then
      raise exception
        'Migration 0003 annulée : la clé étrangère de public.% part de « % » au lieu de « user_id ». Aucune modification faite.',
        t, coalesce(locale, 'aucune colonne');
    end if;

    if distante is distinct from 'id' then
      raise exception
        'Migration 0003 annulée : la clé étrangère de public.% pointe sur auth.users.% au lieu de auth.users.id. Aucune modification faite.',
        t, coalesce(distante, 'inconnue');
    end if;

    if deltype is distinct from 'c' then
      raise exception
        'Migration 0003 annulée : la clé étrangère de public.% n''est pas ON DELETE CASCADE (confdeltype = « % »). Aucune modification faite.',
        t, coalesce(deltype, 'null');
    end if;

    if not valide then
      raise exception
        'Migration 0003 annulée : la clé étrangère de public.% n''est pas validée (convalidated = false). Aucune modification faite.', t;
    end if;

    if def !~* 'on delete cascade' then
      raise exception
        'Migration 0003 annulée : « on delete cascade » absent de la définition réelle de public.% (%). Aucune modification faite.',
        t, def;
    end if;
  end loop;

  select count(*) into n_fk
    from pg_constraint c
    join pg_class     t on t.oid = c.conrelid
    join pg_namespace n on n.oid = t.relnamespace
   where n.nspname = 'public'
     and t.relname in ('ai_usage_daily', 'ai_usage_events')
     and c.contype = 'f';

  if n_fk <> 2 then
    raise exception
      'Migration 0003 annulée : % clés étrangères sur les deux tables au lieu de 2 (règle étrangère ?). Aucune modification faite.',
      n_fk;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Immutability of the ledger
-- ---------------------------------------------------------------------
-- Two and only two transitions are legal:
--   consumed → refunded   (attempts unchanged, usage_day unchanged)
--   refunded → consumed   (attempts + 1, usage_day may move to the new day)
-- Everything else — changing the owner, the kind of message, the identifier or
-- the creation date — is refused. This is the second line of defence behind
-- the privileges: even a role that could reach the table could not rewrite
-- history to obtain a free message.
create or replace function public.ai_usage_events_guard_fn()
returns trigger
language plpgsql
set search_path = pg_catalog, public, pg_temp
as $$
begin
  if new.consumption_id <> old.consumption_id
     or new.user_id  <> old.user_id
     or new.is_quote <> old.is_quote
     or new.created_at <> old.created_at then
    raise exception
      'ai_usage_events: colonnes immuables modifiées (consumption_id=%)', old.consumption_id
      using errcode = '23514';
  end if;

  if old.state = 'consumed' and new.state = 'refunded' then
    if new.attempts <> old.attempts then
      raise exception 'ai_usage_events: un remboursement ne modifie pas attempts (consumption_id=%)', old.consumption_id
        using errcode = '23514';
    end if;
    -- A refund must correct the day that was charged, never move it.
    if new.usage_day <> old.usage_day then
      raise exception 'ai_usage_events: un remboursement ne déplace pas la journée (consumption_id=%)', old.consumption_id
        using errcode = '23514';
    end if;
    if new.refunded_at is null then
      raise exception 'ai_usage_events: refunded_at doit être renseigné (consumption_id=%)', old.consumption_id
        using errcode = '23514';
    end if;
    return new;
  end if;

  if old.state = 'refunded' and new.state = 'consumed' then
    if new.attempts <> old.attempts + 1 then
      raise exception 'ai_usage_events: une reconsommation incrémente attempts de 1 exactement (consumption_id=%)', old.consumption_id
        using errcode = '23514';
    end if;
    if new.refunded_at is not null then
      raise exception 'ai_usage_events: refunded_at doit être remis à null (consumption_id=%)', old.consumption_id
        using errcode = '23514';
    end if;
    return new;
  end if;

  raise exception
    'ai_usage_events: transition « % » → « % » interdite (consumption_id=%)',
    old.state, new.state, old.consumption_id
    using errcode = '23514';
end;
$$;

drop trigger if exists ai_usage_events_guard on public.ai_usage_events;
create trigger ai_usage_events_guard
  before update on public.ai_usage_events
  for each row execute function public.ai_usage_events_guard_fn();

-- ---------------------------------------------------------------------
-- 4. ai_usage_consume — the only way to charge a message
-- ---------------------------------------------------------------------
-- Signature is frozen by server/usageStore.ts: parameter names are the JSON
-- body keys PostgREST receives, and the returned column names are the keys the
-- server reads. Renaming either side breaks the chat route in P5.
--
-- `p_now` exists for the live tests only; production never sends it, so the day
-- is always derived from the database clock.
drop function if exists public.ai_usage_consume(uuid, uuid, integer, integer, boolean, timestamptz);

create or replace function public.ai_usage_consume(
  p_user_id        uuid,
  p_consumption_id uuid,
  p_limit_messages integer,
  p_limit_quotes   integer,
  p_is_quote       boolean,
  p_now            timestamptz default null
)
returns table (
  allowed       boolean,
  reason        text,
  used_messages integer,
  used_quotes   integer,
  usage_day     date,
  replayed      boolean
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_day      date;
  v_event    public.ai_usage_events%rowtype;
  v_inserted integer := 0;
  v_refuse   text;
  v_messages integer;
  v_quotes   integer;
begin
  -- 4.0 Parameters. A NULL limit is a programming error, not "unlimited":
  -- `p_limit_messages` must always be a number (the server refuses first).
  if p_user_id is null then
    raise exception 'ai_usage_consume: p_user_id est obligatoire' using errcode = '22004';
  end if;
  if p_consumption_id is null then
    raise exception 'ai_usage_consume: p_consumption_id est obligatoire' using errcode = '22004';
  end if;
  if p_is_quote is null then
    raise exception 'ai_usage_consume: p_is_quote est obligatoire' using errcode = '22004';
  end if;
  if p_limit_messages is null or p_limit_messages < 0 then
    raise exception 'ai_usage_consume: p_limit_messages doit être un entier >= 0 (reçu %)', p_limit_messages
      using errcode = '22023';
  end if;
  if p_limit_quotes is not null and p_limit_quotes < 0 then
    raise exception 'ai_usage_consume: p_limit_quotes doit être >= 0 ou NULL (reçu %)', p_limit_quotes
      using errcode = '22023';
  end if;

  v_day := (v_now at time zone 'utc')::date;

  -- 4.1 Atomic claim. The primary key serialises callers that carry the same
  -- consumption_id: one inserts, the others block here until it commits and
  -- then see zero rows. No lock is taken for a brand-new identifier.
  insert into public.ai_usage_events (consumption_id, user_id, usage_day, is_quote, state, attempts)
  values (p_consumption_id, p_user_id, v_day, p_is_quote, 'consumed', 1)
  on conflict (consumption_id) do nothing;

  get diagnostics v_inserted = row_count;

  if v_inserted = 0 then
    -- 4.2 The identifier already exists: lock the row and decide. `for update`
    -- makes two concurrent refunded → consumed transitions queue up, so the
    -- second one sees the first one's result instead of replaying it.
    select * into v_event
      from public.ai_usage_events
     where consumption_id = p_consumption_id
       for update;

    if not found then
      -- Impossible: the claim above conflicts with a row that then vanished.
      raise exception 'ai_usage_consume: réclamation introuvable pour % — état incohérent', p_consumption_id
        using errcode = '40001';
    end if;

    -- 4.3 Identifier reuse across accounts (or across message types). The
    -- counters returned are the CALLER's, never the owner's: a conflict must
    -- not leak another account's usage.
    if v_event.user_id <> p_user_id or v_event.is_quote <> p_is_quote then
      select d.messages, d.quotes into v_messages, v_quotes
        from public.ai_usage_daily d
       where d.user_id = p_user_id and d.usage_day = v_event.usage_day;

      return query select
        false,
        'consumption_conflict'::text,
        coalesce(v_messages, 0),
        coalesce(v_quotes, 0),
        v_event.usage_day,
        false;
      return;
    end if;

    -- 4.4 Already consumed: a replay. No increment, no second charge. The
    -- caller answers 409 and must not call the AI provider.
    if v_event.state = 'consumed' then
      select d.messages, d.quotes into v_messages, v_quotes
        from public.ai_usage_daily d
       where d.user_id = p_user_id and d.usage_day = v_event.usage_day;

      return query select
        true,
        null::text,
        coalesce(v_messages, 0),
        coalesce(v_quotes, 0),
        v_event.usage_day,
        true;
      return;
    end if;

    -- 4.5 Refunded: re-consumable, but never more than 3 consumptions in total.
    if v_event.attempts >= 3 then
      select d.messages, d.quotes into v_messages, v_quotes
        from public.ai_usage_daily d
       where d.user_id = p_user_id and d.usage_day = v_event.usage_day;

      return query select
        false,
        'consumption_conflict'::text,
        coalesce(v_messages, 0),
        coalesce(v_quotes, 0),
        v_event.usage_day,
        false;
      return;
    end if;
  end if;

  -- 4.6 Quota. A limit of 0 can never be honoured by the upsert below: the
  -- INSERT branch of an upsert does not evaluate the UPDATE's WHERE clause, so
  -- it would insert the first unit. That case is therefore refused explicitly.
  if p_limit_messages < 1 or (p_is_quote and p_limit_quotes is not null and p_limit_quotes < 1) then
    v_refuse := case when p_limit_messages < 1 then 'daily_messages' else 'daily_quotes' end;

    select d.messages, d.quotes into v_messages, v_quotes
      from public.ai_usage_daily d
     where d.user_id = p_user_id and d.usage_day = v_day;
  else
    -- One statement, no read-then-write window: the limit lives in the WHERE
    -- clause of the conflicting update, so two parallel callers cannot both
    -- take the last unit. Returning no row means "the limit was reached".
    insert into public.ai_usage_daily as u (user_id, usage_day, messages, quotes)
    values (p_user_id, v_day, 1, case when p_is_quote then 1 else 0 end)
    on conflict (user_id, usage_day) do update
       set messages   = u.messages + 1,
           quotes     = u.quotes + case when p_is_quote then 1 else 0 end,
           updated_at = v_now
     where u.messages < p_limit_messages
       and (p_limit_quotes is null or not p_is_quote or u.quotes < p_limit_quotes)
    returning u.messages, u.quotes into v_messages, v_quotes;

    if v_messages is null then
      -- Nothing was incremented. Read the counters back to report them, and
      -- name the limit that was actually reached.
      select d.messages, d.quotes into v_messages, v_quotes
        from public.ai_usage_daily d
       where d.user_id = p_user_id and d.usage_day = v_day;

      if p_limit_quotes is not null and p_is_quote and coalesce(v_quotes, 0) >= p_limit_quotes then
        v_refuse := 'daily_quotes';
      else
        v_refuse := 'daily_messages';
      end if;
    end if;
  end if;

  -- 4.7 Refusal: nothing is written. The claim inserted in 4.1 is removed in
  -- the SAME transaction, so no row and no counter survives the refusal. Only a
  -- brand-new claim (attempts = 1, state consumed) is ever deleted: a refunded
  -- event is never touched here.
  if v_refuse is not null then
    if v_inserted = 1 then
      delete from public.ai_usage_events
       where consumption_id = p_consumption_id
         and user_id        = p_user_id
         and state          = 'consumed'
         and attempts       = 1;
    end if;

    return query select
      false,
      v_refuse,
      coalesce(v_messages, 0),
      coalesce(v_quotes, 0),
      v_day,
      false;
    return;
  end if;

  -- 4.8 Accepted. A re-consumption after a refund records a fresh consumption:
  -- attempts + 1, and the day moves to the one just charged — so a later refund
  -- of THIS consumption decrements the right day.
  if v_inserted = 0 then
    update public.ai_usage_events
       set state      = 'consumed',
           attempts   = attempts + 1,
           usage_day  = v_day,
           refunded_at = null,
           updated_at = v_now
     where consumption_id = p_consumption_id;
  end if;

  return query select true, null::text, v_messages, v_quotes, v_day, false;
end;
$$;

-- ---------------------------------------------------------------------
-- 5. ai_usage_refund — give one message back
-- ---------------------------------------------------------------------
-- Idempotent: only the first consumed → refunded transition decrements. The
-- day decremented is the one stored on the event, never "today". A message
-- that does not exist and a message that belongs to another account produce
-- the SAME answer, so the call cannot be used to probe for identifiers.
drop function if exists public.ai_usage_refund(uuid, uuid, timestamptz);

create or replace function public.ai_usage_refund(
  p_user_id        uuid,
  p_consumption_id uuid,
  p_now            timestamptz default null
)
returns table (
  refunded  boolean,
  reason    text,
  usage_day date
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_now      timestamptz := coalesce(p_now, now());
  v_event    public.ai_usage_events%rowtype;
  v_messages integer;
  v_quotes   integer;
  v_rows     integer;
begin
  if p_user_id is null then
    raise exception 'ai_usage_refund: p_user_id est obligatoire' using errcode = '22004';
  end if;
  if p_consumption_id is null then
    raise exception 'ai_usage_refund: p_consumption_id est obligatoire' using errcode = '22004';
  end if;

  select * into v_event
    from public.ai_usage_events
   where consumption_id = p_consumption_id
     for update;

  -- Absent and "belongs to someone else" are deliberately indistinguishable.
  if not found or v_event.user_id <> p_user_id then
    return query select false, 'not_refundable'::text, null::date;
    return;
  end if;

  -- Already refunded: no second decrement, and the original day is reported.
  if v_event.state = 'refunded' then
    return query select false, 'already_refunded'::text, v_event.usage_day;
    return;
  end if;

  -- The counter row must exist AND be decrementable before anything is
  -- written. Locked first, so the verification and the decrement cannot
  -- interleave with another refund of the same day. The lock order is the same
  -- as in ai_usage_consume (ledger, then counters), so no deadlock can form.
  select d.messages, d.quotes
    into v_messages, v_quotes
    from public.ai_usage_daily d
   where d.user_id   = p_user_id
     and d.usage_day = v_event.usage_day
     for update;

  if not found then
    raise exception
      'ai_usage_refund: aucun compteur pour la journée % — quota non rendu, remboursement annulé (consumption_id=%)',
      v_event.usage_day, p_consumption_id
      using errcode = '23514';
  end if;

  -- A quote consumption charged one message AND one quote: anything below that
  -- is an accounting state this function must not paper over with greatest().
  if v_messages < 1 or (v_event.is_quote and v_quotes < 1) then
    raise exception
      'ai_usage_refund: compteurs incohérents (messages=%, quotes=%) pour la journée % — quota non rendu, remboursement annulé (consumption_id=%)',
      v_messages, v_quotes, v_event.usage_day, p_consumption_id
      using errcode = '23514';
  end if;

  -- The guard trigger only accepts this exact transition.
  update public.ai_usage_events
     set state       = 'refunded',
         refunded_at = v_now,
         updated_at  = v_now
   where consumption_id = p_consumption_id;

  -- Decrement the day the message was charged on. greatest(0, …) stays as a
  -- last line of defence, but it is now unreachable: the counters were
  -- verified above, under the same lock.
  update public.ai_usage_daily as d
     set messages   = greatest(0, d.messages - 1),
         quotes     = greatest(0, d.quotes - case when v_event.is_quote then 1 else 0 end),
         updated_at = v_now
   where d.user_id   = p_user_id
     and d.usage_day = v_event.usage_day;

  get diagnostics v_rows = row_count;

  -- Exactly one row, or the quota was not returned: the whole transaction rolls
  -- back, including the state change above. `refunded = true` is only ever
  -- reported after this check.
  if v_rows <> 1 then
    raise exception
      'ai_usage_refund: % ligne(s) de compteur modifiée(s) au lieu d''une — remboursement annulé (consumption_id=%)',
      v_rows, p_consumption_id
      using errcode = '23514';
  end if;

  return query select true, null::text, v_event.usage_day;
end;
$$;

-- ---------------------------------------------------------------------
-- 6. ai_usage_read — read one day's counters, never write
-- ---------------------------------------------------------------------
-- Always returns exactly one row, zeros included, for the CURRENT UTC day. The
-- quota endpoint (P6) can therefore render a badge without special-casing an
-- account that has never consumed anything.
drop function if exists public.ai_usage_read(uuid, timestamptz);

create or replace function public.ai_usage_read(
  p_user_id uuid,
  p_now     timestamptz default null
)
returns table (
  usage_day     date,
  used_messages integer,
  used_quotes   integer
)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_day date := (coalesce(p_now, now()) at time zone 'utc')::date;
begin
  if p_user_id is null then
    raise exception 'ai_usage_read: p_user_id est obligatoire' using errcode = '22004';
  end if;

  return query
    select v_day,
           coalesce(d.messages, 0)::integer,
           coalesce(d.quotes, 0)::integer
      from (values (1)) as one(marker)
      left join public.ai_usage_daily d
             on d.user_id = p_user_id
            and d.usage_day = v_day;
end;
$$;

-- ---------------------------------------------------------------------
-- 7. Privileges and row level security
-- ---------------------------------------------------------------------
-- The tables are unreadable and unwritable from outside the functions:
--   * RLS is enabled with NO policy, so the browser cannot see anything even
--     by name;
--   * anon and authenticated are revoked outright;
--   * service_role is revoked too. This is the decision that makes the
--     atomicity structural: the server holds no table privilege, so a future
--     refactor cannot rewrite a counter without going through a function that
--     keeps the ledger and the counter in one transaction;
--   * the functions are SECURITY DEFINER and owned by the migration role,
--     which bypasses RLS as the table owner. Nothing needs FORCE ROW LEVEL
--     SECURITY, and it is deliberately NOT enabled: it would block the
--     functions themselves.
alter table public.ai_usage_daily  enable row level security;
alter table public.ai_usage_events enable row level security;

revoke all on public.ai_usage_daily  from public;
revoke all on public.ai_usage_daily  from anon, authenticated, service_role;
revoke all on public.ai_usage_events from public;
revoke all on public.ai_usage_events from anon, authenticated, service_role;

-- Column-level privileges live in `pg_attribute.attacl`, which is a DIFFERENT
-- ACL from the table's `pg_class.relacl`. A table-level REVOKE is not
-- guaranteed to remove a `grant select (usage_day) on … to anon` left by an
-- earlier experiment, and `has_table_privilege` would never report it. So the
-- columns are revoked by name as well, for the same four grantees.
--
-- This statement can only REMOVE privileges: on a table that never carried a
-- column grant it is a no-op, and it never grants anything. The column lists
-- match, name for name, the tables created in section 1 — which section 2a has
-- already proved to be exact.
revoke all (user_id, usage_day, messages, quotes, created_at, updated_at)
  on table public.ai_usage_daily
  from public, anon, authenticated, service_role;

revoke all (consumption_id, user_id, usage_day, is_quote, state, attempts, created_at, refunded_at, updated_at)
  on table public.ai_usage_events
  from public, anon, authenticated, service_role;

-- Functions are executable by PUBLIC by default: this revoke is what actually
-- closes them, before the single grant below.
revoke all on function public.ai_usage_consume(uuid, uuid, integer, integer, boolean, timestamptz)
  from public, anon, authenticated;
revoke all on function public.ai_usage_refund(uuid, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.ai_usage_read(uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function public.ai_usage_events_guard_fn()
  from public, anon, authenticated;

grant execute on function public.ai_usage_consume(uuid, uuid, integer, integer, boolean, timestamptz)
  to service_role;
grant execute on function public.ai_usage_refund(uuid, uuid, timestamptz)
  to service_role;
grant execute on function public.ai_usage_read(uuid, timestamptz)
  to service_role;

-- ---------------------------------------------------------------------
-- 7b. The public schema itself must not be writable by the API roles
--
-- SECURITY DEFINER functions are only as safe as the schema they resolve names
-- in. This file qualifies every object (public.ai_usage_*) and puts pg_catalog
-- first and pg_temp last, but on a project where anon or authenticated can
-- CREATE inside public, an attacker can still plant an object that shadows a
-- builtin used inside the DEFINER context — or swap an object between two
-- statements. That is not a property this migration can fix alone: it would
-- mean changing a global ACL, which belongs to the project, not to one feature.
-- So it verifies the ACL and refuses to install otherwise. Same for the
-- ownership of the schema.
-- ---------------------------------------------------------------------
do $$
declare
  role_        text;
  fautifs      text := '';
  proprietaire text;
begin
  for role_ in
    select r.rolname
      from pg_roles r
     where r.rolname in ('anon', 'authenticated', 'service_role')
  loop
    if has_schema_privilege(role_, 'public', 'CREATE') then
      fautifs := fautifs || ' ' || role_;
    end if;
  end loop;

  if fautifs <> '' then
    raise exception
      'Migration 0003 annulée : le schéma public est inscriptible par%. Un rôle d''API peut y créer un objet qui usurpe une référence. Révoquez CREATE sur le schéma public, puis relancez. Aucune modification faite.',
      fautifs;
  end if;

  select pg_get_userbyid(n.nspowner)
    into proprietaire
    from pg_namespace n
   where n.nspname = 'public';

  if proprietaire in ('anon', 'authenticated', 'service_role') then
    raise exception
      'Migration 0003 annulée : le schéma public appartient à « % », un rôle d''API. Aucune modification faite.',
      proprietaire;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 8. Self-check — the migration refuses to commit a half-secured state
-- ---------------------------------------------------------------------
-- These are assertions, not reports: any violation rolls the whole transaction
-- back. This is the cheapest possible protection against a silently
-- mis-installed privilege set.
do $$
declare
  problems text := '';
  entry    record;
begin
  for entry in
    select c.relname as name, c.relrowsecurity as rls
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('ai_usage_daily', 'ai_usage_events')
  loop
    if not entry.rls then
      problems := problems || format(' RLS désactivée sur %s;', entry.name);
    end if;
  end loop;

  if exists (
    select 1 from pg_policies
     where schemaname = 'public'
       and tablename in ('ai_usage_daily', 'ai_usage_events')
  ) then
    problems := problems || ' une politique RLS existe sur une table qui ne doit en avoir aucune;';
  end if;

  if has_table_privilege('anon', 'public.ai_usage_daily', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_usage_daily', 'SELECT')
     or has_table_privilege('service_role', 'public.ai_usage_daily', 'SELECT')
     or has_table_privilege('service_role', 'public.ai_usage_daily', 'INSERT')
     or has_table_privilege('service_role', 'public.ai_usage_daily', 'UPDATE')
     or has_table_privilege('service_role', 'public.ai_usage_daily', 'DELETE') then
    problems := problems || ' privilège de table subsistant sur ai_usage_daily;';
  end if;

  if has_table_privilege('anon', 'public.ai_usage_events', 'SELECT')
     or has_table_privilege('authenticated', 'public.ai_usage_events', 'SELECT')
     or has_table_privilege('service_role', 'public.ai_usage_events', 'SELECT')
     or has_table_privilege('service_role', 'public.ai_usage_events', 'INSERT')
     or has_table_privilege('service_role', 'public.ai_usage_events', 'UPDATE')
     or has_table_privilege('service_role', 'public.ai_usage_events', 'DELETE') then
    problems := problems || ' privilège de table subsistant sur ai_usage_events;';
  end if;

  -- The has_table_privilege calls above answer "what does this role
  -- effectively hold" for the six combinations that matter most. They say
  -- nothing about TRUNCATE, REFERENCES or TRIGGER, and nothing about a direct
  -- entry granted to PUBLIC. `pg_class.relacl` does: aclexplode lists every
  -- entry verbatim, grantee 0 being PUBLIC, so any surviving direct grant — for
  -- ANY verb, to ANY of the four grantees — aborts the transaction here. There
  -- is deliberately no filter on privilege_type: whitelisting verbs is how a
  -- check goes blind on the next PostgreSQL release that adds one.
  --
  -- New tables carry a NULL relacl: aclexplode(NULL) yields zero rows, so this
  -- check is green on a fresh install. Expected — and verified by P3, not
  -- assumed here.
  for entry in
    select c.relname as name
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
      cross join lateral aclexplode(c.relacl) as x
     where n.nspname = 'public'
       and c.relname in ('ai_usage_daily', 'ai_usage_events')
       and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon', 'authenticated', 'service_role'))
     group by c.relname
  loop
    problems := problems || format(' privilège de TABLE subsistant (ACL directe) sur %s;', entry.name);
  end loop;

  -- Column ACLs are invisible to has_table_privilege: a `grant select (col)`
  -- leaves `pg_attribute.attacl` untouched by any table-level check. aclexplode
  -- reports PUBLIC as grantee 0, so a leftover grant to PUBLIC is caught too.
  -- An empty ACL — `{}`, what a revoke leaves behind — explodes to zero rows,
  -- so re-running this very migration stays green.
  if exists (
    select 1
      from pg_attribute a
      cross join lateral aclexplode(a.attacl) as x
     where a.attrelid = 'public.ai_usage_daily'::regclass
       and a.attnum > 0
       and not a.attisdropped
       and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon', 'authenticated', 'service_role'))
  ) then
    problems := problems || ' privilège de COLONNE subsistant sur ai_usage_daily;';
  end if;

  if exists (
    select 1
      from pg_attribute a
      cross join lateral aclexplode(a.attacl) as x
     where a.attrelid = 'public.ai_usage_events'::regclass
       and a.attnum > 0
       and not a.attisdropped
       and (x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon', 'authenticated', 'service_role'))
  ) then
    problems := problems || ' privilège de COLONNE subsistant sur ai_usage_events;';
  end if;

  if not has_function_privilege(
       'service_role',
       'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)',
       'EXECUTE')
     or not has_function_privilege(
       'service_role',
       'public.ai_usage_refund(uuid,uuid,timestamptz)',
       'EXECUTE')
     or not has_function_privilege(
       'service_role',
       'public.ai_usage_read(uuid,timestamptz)',
       'EXECUTE') then
    problems := problems || ' service_role ne peut pas exécuter une des trois fonctions;';
  end if;

  if has_function_privilege('anon', 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_usage_refund(uuid,uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_usage_refund(uuid,uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('anon', 'public.ai_usage_read(uuid,timestamptz)', 'EXECUTE')
     or has_function_privilege('authenticated', 'public.ai_usage_read(uuid,timestamptz)', 'EXECUTE') then
    problems := problems || ' anon ou authenticated peut exécuter une fonction de quota;';
  end if;

  if problems <> '' then
    raise exception 'Migration 0003 annulée : contrôles de sécurité échoués —%', problems;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 8b. Owner compatibility — SECURITY DEFINER against RLS
--
-- The four functions are the only writers, and they run as their OWNER. Three
-- conditions must hold at once, or the RPCs fail at runtime while every
-- privilege check above still passes:
--   * the four functions and the two tables must belong to the same role —
--     otherwise the DEFINER context is some role with no privilege on the
--     tables, and every call answers 42501;
--   * that role must not be one of the API roles (anon, authenticated,
--     service_role), which this file deliberately starves of privileges;
--   * FORCE ROW LEVEL SECURITY must be OFF: the tables carry no policy, so a
--     forced owner would see and write nothing at all.
--
-- The search_path is verified here rather than trusted to the text above: the
-- declared option must be present, and must be exactly
-- `pg_catalog, public, pg_temp` — pg_catalog first, so that no object created
-- in public can shadow a builtin, and pg_temp last, so that no temporary object
-- can shadow anything; nothing may be appended after it.
do $$
declare
  owner_daily  oid;
  owner_events oid;
  probleme     text := '';
  entry        record;
begin
  select c.relowner into owner_daily
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'ai_usage_daily';

  select c.relowner into owner_events
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relname = 'ai_usage_events';

  if owner_daily is distinct from owner_events then
    probleme := probleme || ' les deux tables n''ont pas le même propriétaire;';
  end if;

  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('ai_usage_daily', 'ai_usage_events')
       and c.relforcerowsecurity
  ) then
    probleme := probleme || ' FORCE ROW LEVEL SECURITY active : sans politique, même le propriétaire ne pourrait plus écrire;';
  end if;

  if exists (
    select 1
      from pg_class c
      join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public'
       and c.relname in ('ai_usage_daily', 'ai_usage_events')
       and pg_get_userbyid(c.relowner) in ('anon', 'authenticated', 'service_role')
  ) then
    probleme := probleme || ' une table appartient à un rôle d''API;';
  end if;

  for entry in
    select p.oid                       as fnoid,
           p.proname,
           p.prosecdef,
           p.proowner,
           pg_get_userbyid(p.proowner) as owner,
           p.oid::regprocedure::text   as signature
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('ai_usage_consume', 'ai_usage_refund', 'ai_usage_read', 'ai_usage_events_guard_fn')
  loop
    if not exists (
      select 1
        from pg_proc p2
        cross join lateral unnest(p2.proconfig) as cfg
       where p2.oid = entry.fnoid
         and cfg ~ '^\s*search_path\s*=\s*pg_catalog,\s*public,\s*pg_temp\s*$'
    ) then
      probleme := probleme || format(' search_path non figé sur « pg_catalog, public, pg_temp » pour %s;', entry.signature);
    end if;

    if entry.proowner <> owner_daily then
      probleme := probleme || format(' %s n''appartient pas au propriétaire des tables (%s);',
                                     entry.signature, entry.owner);
    end if;

    if entry.owner in ('anon', 'authenticated', 'service_role') then
      probleme := probleme || format(' %s appartient à un rôle d''API (%s);', entry.signature, entry.owner);
    end if;

    if entry.proname = 'ai_usage_events_guard_fn' then
      if entry.prosecdef then
        probleme := probleme || ' la fonction de trigger est SECURITY DEFINER sans en avoir besoin;';
      end if;
    elsif not entry.prosecdef then
      probleme := probleme || format(' %s n''est pas SECURITY DEFINER;', entry.signature);
    end if;
  end loop;

  if (
    select count(*)
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('ai_usage_consume', 'ai_usage_refund', 'ai_usage_read', 'ai_usage_events_guard_fn')
  ) <> 4 then
    probleme := probleme || ' une des quatre fonctions est absente ou surchargée (surcharge inattendue ?);';
  end if;

  if probleme <> '' then
    raise exception 'Migration 0003 annulée : compatibilité propriétaire / RLS / SECURITY DEFINER non établie —%', probleme;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 9. Final report (read-only)
-- ---------------------------------------------------------------------
do $$
declare
  definer_count integer;
  policy_count  integer;
begin
  select count(*) into definer_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('ai_usage_consume', 'ai_usage_refund', 'ai_usage_read')
     and p.prosecdef;

  select count(*) into policy_count
    from pg_policies
   where schemaname = 'public'
     and tablename in ('ai_usage_daily', 'ai_usage_events');

  raise notice
    '0003 appliquée : % fonction(s) SECURITY DEFINER, % politique(s) RLS, tables verrouillées, aucune écriture directe pour service_role.',
    definer_count, policy_count;
end
$$;

-- PostgREST caches the schema: without this, the new RPCs answer 404 until the
-- next reload.
notify pgrst, 'reload schema';

commit;
