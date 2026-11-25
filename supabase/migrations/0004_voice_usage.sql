-- =====================================================================
-- VEYVRO — 0004 : quota vocal persistant, facturé au temps réellement passé
-- =====================================================================
-- ⚠️ VERSION 3. Remplace les versions précédentes, jamais exécutées.
--
--   v1 → la durée facturée venait du navigateur (`p_actual_seconds`) : un
--        client envoyant 0 ne payait rien.
--   v2 → la durée est mesurée par PostgreSQL, mais le début de la migration
--        faisait `DROP TABLE IF EXISTS` : rejouable destructif, inacceptable.
--   v3 → AUCUNE destruction. Les tables existantes sont RÉPARÉES en place
--        (colonnes et contraintes ajoutées si absentes), leurs données
--        conservées. La réservation couvre tout le crédit restant.
--
-- ─────────────────────────────────────────────────────────────────────────────
--  LES TROIS GARANTIES, ET OÙ ELLES VIVENT
-- ─────────────────────────────────────────────────────────────────────────────
-- 1. LA DURÉE VIENT DE POSTGRESQL.
--    `voice_settle` n'accepte aucun paramètre de durée. Elle calcule
--    `now() - started_at`, et `started_at` n'est posé qu'à l'activation —
--    après la réponse du fournisseur, donc hors temps de préparation.
--
-- 2. LA RÉSERVATION EST LE PLAFOND.
--    `voice_reserve` réserve TOUT le crédit restant, borné par :
--      • la limite de session fournie par l'appelant (une seule source : le
--        TypeScript, dérivé de la limite fournisseur vérifiée) ;
--      • le crédit restant du jour ;
--      • le temps restant jusqu'à minuit UTC.
--    Une session ne peut donc jamais consommer plus que ce qui a été réservé,
--    ni plus que ce qui restait. `voice_settle` borne à la réservation, et
--    `voice_close_overdue` clôt à `started_at + réservation`.
--    → Le dépassement de quota devient structurellement impossible.
--
-- 3. UN SEUL PLAFOND, PARAMÉTRÉ.
--    `p_max_session_seconds` n'a AUCUNE valeur par défaut en SQL : un défaut
--    serait une seconde source de vérité, et deux chemins de facturation
--    pourraient diverger. Le TypeScript le dérive de
--    `LIVE_MAX_SESSION_MINUTES` (60), seule définition du chiffre.
--
-- CAS DE MINUIT UTC
--    Une session ne traverse pas minuit : elle est bornée par le temps restant
--    jusqu'à minuit. Tout ce qu'elle consomme appartient donc à un seul jour,
--    et le crédit d'un jour n'est jamais entamé par la veille. Conséquence
--    assumée : une conversation commencée à 23:58 s'arrête à minuit et doit
--    être relancée. C'est le prix d'un comptage non ambigu, et c'est écrit ici
--    plutôt que découvert en production.
--
-- ─────────────────────────────────────────────────────────────────────────────
--  IDEMPOTENCE SANS PERTE (exigence explicite)
-- ─────────────────────────────────────────────────────────────────────────────
--  Rejouer cette migration ne supprime rien :
--    • tables créées seulement si absentes ;
--    • colonnes ajoutées seulement si absentes, données existantes reprises
--      par `coalesce` (aucune valeur présente n'est écrasée) ;
--    • contraintes et index créés seulement s'ils manquent, en `not valid`
--      pour ne jamais exiger la suppression d'une ligne existante ;
--    • fonctions remplacées : c'est du code, pas des données ;
--    • une structure INCOMPATIBLE n'est jamais écrasée : la migration s'arrête
--      avec un message explicite.
--
-- ⚠️ NON EXÉCUTÉE. Proposée, pas appliquée.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Structure incompatible : on s'arrête, on n'écrase pas
-- ---------------------------------------------------------------------
do $$
begin
  if exists (
    select 1 from information_schema.tables
    where table_schema = 'public' and table_name = 'voice_sessions'
  ) and not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'voice_sessions'
      and column_name = 'reserved_seconds'
  ) then
    raise exception
      'voice_sessions existe avec une structure inconnue (reserved_seconds '
      'absente). Aucune donnée n''a été modifiée. Écrivez une migration '
      'dédiée plutôt que de supprimer la table.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 1. Consommation quotidienne
-- ---------------------------------------------------------------------
-- `reserved_seconds` et `consumed_seconds` sont distincts : une réservation se
-- rend, une consommation non. Les confondre rendrait le remboursement
-- indiscernable d'une remise.
create table if not exists public.voice_usage_daily (
  user_id          uuid    not null references auth.users (id) on delete cascade,
  usage_day        date    not null,
  consumed_seconds integer not null default 0,
  reserved_seconds integer not null default 0,
  updated_at       timestamptz not null default now(),
  constraint voice_usage_daily_pkey primary key (user_id, usage_day)
);

comment on table public.voice_usage_daily is
  'Compteur vocal quotidien (UTC) par compte. Écrit uniquement par les fonctions voice_* (service role).';

-- ---------------------------------------------------------------------
-- 2. Sessions vocales
-- ---------------------------------------------------------------------
create table if not exists public.voice_sessions (
  id                  uuid        primary key default gen_random_uuid(),
  user_id             uuid        not null references auth.users (id) on delete cascade,
  voice_id            text        not null,
  usage_day           date,
  reserved_seconds    integer     not null,
  state               text        not null default 'pending',
  -- Posé à la réservation, pour l'audit seulement. Ne sert jamais à facturer.
  created_at          timestamptz not null default now(),
  -- Posé par `voice_activate`, APRÈS la réponse du fournisseur.
  started_at          timestamptz,
  -- Bail. Ne s'applique qu'aux réservations `pending`.
  lease_expires_at    timestamptz not null default (now() + interval '5 minutes'),
  last_heartbeat_at   timestamptz,
  provider_session_id text,
  closed_at           timestamptz,
  charged_seconds     integer
);

comment on table public.voice_sessions is
  'Sessions vocales : pending (réservation) puis active (started_at posé). La durée facturée vient de started_at, jamais de l''appelant.';

-- ---------------------------------------------------------------------
-- 3. Réparation en place, sans destruction
-- ---------------------------------------------------------------------
alter table public.voice_sessions add column if not exists usage_day date;
alter table public.voice_sessions add column if not exists created_at timestamptz;
alter table public.voice_sessions add column if not exists started_at timestamptz;
alter table public.voice_sessions add column if not exists lease_expires_at timestamptz;
alter table public.voice_sessions add column if not exists last_heartbeat_at timestamptz;
alter table public.voice_sessions add column if not exists provider_session_id text;
alter table public.voice_sessions add column if not exists closed_at timestamptz;
alter table public.voice_sessions add column if not exists charged_seconds integer;

alter table public.voice_usage_daily add column if not exists updated_at timestamptz;

-- Reprise des valeurs manquantes. `coalesce` garantit qu'une valeur présente
-- n'est jamais écrasée : la migration complète, elle n'efface pas.
update public.voice_sessions
   set created_at = coalesce(created_at, now())
 where created_at is null;

update public.voice_sessions
   set usage_day = coalesce(usage_day, (created_at at time zone 'utc')::date)
 where usage_day is null;

update public.voice_sessions
   set lease_expires_at = coalesce(lease_expires_at, created_at + interval '5 minutes')
 where lease_expires_at is null;

-- Une session `active` sans `started_at` est incohérente. On lui donne son
-- `created_at`, jamais `now()` : cela ni ne rallonge ni ne raccourcit à tort.
update public.voice_sessions
   set started_at = coalesce(started_at, created_at)
 where state in ('active', 'settled') and started_at is null;

update public.voice_usage_daily
   set updated_at = coalesce(updated_at, now())
 where updated_at is null;

comment on column public.voice_sessions.started_at is
  'Début de la facturation, posé par voice_activate. Jamais fourni par le client.';

-- ---------------------------------------------------------------------
-- 4. Contraintes et index, seulement s'ils manquent
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_constraint where conrelid = 'public.voice_sessions'::regclass
                 and conname = 'voice_sessions_state_check') then
    alter table public.voice_sessions
      add constraint voice_sessions_state_check
      check (state in ('pending', 'active', 'settled', 'refunded', 'expired')) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.voice_sessions'::regclass
                 and conname = 'voice_sessions_reserved_positive') then
    alter table public.voice_sessions
      add constraint voice_sessions_reserved_positive
      check (reserved_seconds > 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.voice_sessions'::regclass
                 and conname = 'voice_sessions_charged_non_negative') then
    alter table public.voice_sessions
      add constraint voice_sessions_charged_non_negative
      check (charged_seconds is null or charged_seconds >= 0) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.voice_sessions'::regclass
                 and conname = 'voice_sessions_started_consistency') then
    alter table public.voice_sessions
      add constraint voice_sessions_started_consistency
      check (
        (state in ('pending', 'expired') and started_at is null)
        or (state in ('active', 'settled') and started_at is not null)
        or state = 'refunded'
      ) not valid;
  end if;

  if not exists (select 1 from pg_constraint where conrelid = 'public.voice_usage_daily'::regclass
                 and conname = 'voice_usage_daily_non_negative') then
    alter table public.voice_usage_daily
      add constraint voice_usage_daily_non_negative
      check (consumed_seconds >= 0 and reserved_seconds >= 0) not valid;
  end if;
end
$$;

create index if not exists voice_sessions_user_created_idx
  on public.voice_sessions (user_id, created_at desc);

-- Un compte ne peut avoir qu'UNE session en cours, réservation ou active.
create unique index if not exists voice_sessions_one_live_per_user
  on public.voice_sessions (user_id)
  where state in ('pending', 'active');

-- ---------------------------------------------------------------------
-- 5. RLS
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'voice_usage_daily' and c.relrowsecurity) then
    execute 'alter table public.voice_usage_daily enable row level security';
  end if;
  if not exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                 where n.nspname = 'public' and c.relname = 'voice_sessions' and c.relrowsecurity) then
    execute 'alter table public.voice_sessions enable row level security';
  end if;
end
$$;

drop policy if exists "voice_usage_daily_own_read" on public.voice_usage_daily;
create policy "voice_usage_daily_own_read"
  on public.voice_usage_daily for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "voice_sessions_own_read" on public.voice_sessions;
create policy "voice_sessions_own_read"
  on public.voice_sessions for select to authenticated
  using (user_id = auth.uid());

-- Aucune politique d'écriture : le navigateur ne peut rien écrire.

-- ---------------------------------------------------------------------
-- 6. Fonctions internes
-- ---------------------------------------------------------------------
create or replace function public.voice_usage_row(p_user_id uuid, p_day date)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.voice_usage_daily (user_id, usage_day)
  values (p_user_id, p_day)
  on conflict (user_id, usage_day) do nothing;
end
$$;

-- Libère les RÉSERVATIONS expirées, jamais une session active.
create or replace function public.voice_expire_stale(p_user_id uuid)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row   record;
  v_count integer := 0;
begin
  for v_row in
    select id, usage_day, reserved_seconds
      from public.voice_sessions
     where user_id = p_user_id
       and state = 'pending'
       and lease_expires_at < now()
     for update
  loop
    update public.voice_sessions
       set state = 'expired', closed_at = now(), charged_seconds = 0
     where id = v_row.id;

    if v_row.usage_day is not null then
      update public.voice_usage_daily
         set reserved_seconds = greatest(0, reserved_seconds - v_row.reserved_seconds),
             updated_at = now()
       where user_id = p_user_id and usage_day = v_row.usage_day;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- Clôt une session active arrivée au bout de SA RÉSERVATION, et la facture à
-- la réservation — le maximum qu'elle pouvait consommer. C'est un règlement
-- automatique, et il doit donner EXACTEMENT le même montant qu'un règlement
-- manuel au même instant : les deux lisent `started_at` et la même limite.
--
-- La limite passée ici est un plafond de sécurité ; la réservation, elle, est
-- toujours inférieure ou égale.
create or replace function public.voice_close_overdue(
  p_user_id uuid,
  p_max_session_seconds integer
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_charge integer;
  v_count  integer := 0;
begin
  if p_max_session_seconds is null or p_max_session_seconds <= 0 then
    raise exception 'voice_close_overdue: p_max_session_seconds is required';
  end if;

  for v_row in
    select id, usage_day, reserved_seconds, started_at
      from public.voice_sessions
     where user_id = p_user_id
       and state = 'active'
       and started_at is not null
       and started_at + make_interval(secs => least(reserved_seconds, p_max_session_seconds)) <= now()
     for update
  loop
    -- Même calcul que `voice_settle` : durée mesurée, bornée à la réservation.
    v_charge := least(
      greatest(0, floor(extract(epoch from (now() - v_row.started_at)))::integer),
      least(v_row.reserved_seconds, p_max_session_seconds)
    );

    if v_row.usage_day is not null then
      update public.voice_usage_daily
         set reserved_seconds = greatest(0, reserved_seconds - v_row.reserved_seconds),
             consumed_seconds = consumed_seconds + v_charge,
             updated_at = now()
       where user_id = p_user_id and usage_day = v_row.usage_day;
    end if;

    update public.voice_sessions
       set state = 'settled', closed_at = now(), charged_seconds = v_charge
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- 7. Réservation : tout le crédit restant, borné par trois limites
-- ---------------------------------------------------------------------
-- Défaut corrigé : la v2 réservait 60 s alors qu'une session pouvait durer
-- une heure. Un compte Pro avec 60 s restantes ouvrait 20 minutes et
-- dépassait son quota. La réservation couvre désormais tout ce que la session
-- PEUT consommer, donc le dépassement devient impossible.
create or replace function public.voice_reserve(
  p_user_id                  uuid,
  p_allowance_seconds        integer,
  p_max_session_seconds      integer,
  p_voice_id                 text,
  p_ttl_seconds              integer,
  p_min_reservation_seconds  integer default 60
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_now       timestamptz := now();
  v_day       date := (v_now at time zone 'utc')::date;
  v_consumed  integer := 0;
  v_reserved  integer := 0;
  v_live      record;
  v_used      integer;
  v_room      integer;
  v_cap       integer;
  v_to_midnight integer;
  v_session   uuid;
begin
  if p_user_id is null then
    raise exception 'voice_reserve: p_user_id is required';
  end if;
  if p_max_session_seconds is null or p_max_session_seconds <= 0 then
    raise exception 'voice_reserve: p_max_session_seconds is required (no SQL default: one source of truth)';
  end if;
  if p_ttl_seconds is null or p_ttl_seconds <= 0 then
    raise exception 'voice_reserve: p_ttl_seconds is required';
  end if;

  -- a) Aucun droit vocal : refus avant tout appel fournisseur.
  if coalesce(p_allowance_seconds, 0) <= 0 then
    return jsonb_build_object(
      'ok', false, 'kind', 'voice_not_in_plan',
      'used_seconds', 0, 'limit_seconds', 0, 'remaining_seconds', 0
    );
  end if;

  perform public.voice_usage_row(p_user_id, v_day);

  -- Libère les réservations abandonnées ; ne touche jamais une session active.
  perform public.voice_expire_stale(p_user_id);

  -- Une session active arrivée au bout de sa réservation est close et
  -- facturée AVANT tout examen : le quota qu'elle consomme est donc déjà
  -- décompté au moment où l'on calcule le crédit restant.
  perform public.voice_close_overdue(p_user_id, p_max_session_seconds);

  -- b) Une session est-elle encore en cours ?
  select id, state, lease_expires_at
    into v_live
    from public.voice_sessions
   where user_id = p_user_id and state in ('pending', 'active')
   limit 1;

  if v_live.id is not null then
    return jsonb_build_object(
      'ok', false,
      'kind', 'voice_session_open',
      'open_session_id', v_live.id,
      'open_state', v_live.state,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_live.lease_expires_at - v_now)))::integer)
    );
  end if;

  -- c) Crédit restant aujourd'hui.
  select consumed_seconds, reserved_seconds
    into v_consumed, v_reserved
    from public.voice_usage_daily
   where user_id = p_user_id and usage_day = v_day;

  v_room := p_allowance_seconds - coalesce(v_consumed, 0) - coalesce(v_reserved, 0);

  -- d) Temps restant avant minuit UTC : une session ne traverse pas le jour.
  v_to_midnight := greatest(
    1,
    floor(extract(epoch from (
      ((v_now at time zone 'utc')::date + interval '1 day') at time zone 'utc' - v_now
    )))::integer
  );

  -- La réservation est le minimum des trois bornes.
  v_cap := least(p_max_session_seconds, v_room, v_to_midnight);

  if v_room < p_min_reservation_seconds then
    return jsonb_build_object(
      'ok', false, 'kind', 'voice_minutes_exhausted',
      'used_seconds', coalesce(v_consumed, 0) + coalesce(v_reserved, 0),
      'limit_seconds', p_allowance_seconds,
      'remaining_seconds', greatest(0, v_room)
    );
  end if;

  if v_cap < p_min_reservation_seconds then
    -- Moins d'une minute avant minuit : on refuse proprement plutôt que
    -- d'ouvrir une session de quelques secondes.
    return jsonb_build_object(
      'ok', false, 'kind', 'voice_curfew',
      'used_seconds', coalesce(v_consumed, 0) + coalesce(v_reserved, 0),
      'limit_seconds', p_allowance_seconds,
      'remaining_seconds', greatest(0, v_room),
      'seconds_to_midnight', v_to_midnight
    );
  end if;

  begin
    update public.voice_usage_daily
       set reserved_seconds = reserved_seconds + v_cap,
           updated_at = now()
     where user_id = p_user_id
       and usage_day = v_day
       -- Condition d'autorisation DANS le WHERE : atomique sous concurrence.
       and consumed_seconds + reserved_seconds + v_cap <= p_allowance_seconds
    returning reserved_seconds into v_reserved;

    if v_reserved is null then
      -- Une réservation concurrente est passée entre-temps.
      select consumed_seconds + reserved_seconds
        into v_used
        from public.voice_usage_daily
       where user_id = p_user_id and usage_day = v_day;

      return jsonb_build_object(
        'ok', false, 'kind', 'voice_minutes_exhausted',
        'used_seconds', coalesce(v_used, 0),
        'limit_seconds', p_allowance_seconds,
        'remaining_seconds', greatest(0, p_allowance_seconds - coalesce(v_used, 0))
      );
    end if;

    insert into public.voice_sessions (
      user_id, voice_id, usage_day, reserved_seconds, state, lease_expires_at
    ) values (
      p_user_id, coalesce(p_voice_id, 'brise'), v_day, v_cap, 'pending',
      v_now + make_interval(secs => p_ttl_seconds)
    )
    returning id into v_session;
  exception
    when unique_violation then
      -- Une autre requête a ouvert une session au même instant : le bloc
      -- annule l'incrément. Refus propre, pas une erreur 500.
      return jsonb_build_object(
        'ok', false, 'kind', 'voice_session_open', 'retry_after_seconds', 30
      );
  end;

  select consumed_seconds + reserved_seconds
    into v_used
    from public.voice_usage_daily
   where user_id = p_user_id and usage_day = v_day;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session,
    'state', 'pending',
    -- La réservation EST la durée maximale facturable de cette session.
    'reserved_seconds', v_cap,
    'max_session_seconds', v_cap,
    'used_seconds', coalesce(v_used, 0),
    'remaining_seconds', greatest(0, p_allowance_seconds - coalesce(v_used, 0))
  );
end
$$;

-- ---------------------------------------------------------------------
-- 8. Activation : c'est ici que la facturation commence
-- ---------------------------------------------------------------------
create or replace function public.voice_activate(
  p_user_id             uuid,
  p_session_id          uuid,
  p_max_session_seconds integer,
  p_provider_session_id text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  if p_max_session_seconds is null or p_max_session_seconds <= 0 then
    raise exception 'voice_activate: p_max_session_seconds is required';
  end if;

  select id, state, usage_day, reserved_seconds
    into v_session
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  -- Déjà activée : idempotent. `started_at` ne recule pas, un appel réseau
  -- rejoué ne doit pas raccourcir la facturation.
  if v_session.state = 'active' then
    return jsonb_build_object('ok', true, 'kind', 'already_active');
  end if;

  if v_session.state <> 'pending' then
    return jsonb_build_object('ok', false, 'kind', 'not_pending', 'state', v_session.state);
  end if;

  update public.voice_sessions
     set state = 'active',
         started_at = now(),
         -- Le bail couvre la réservation entière : une session active ne doit
         -- jamais expirer avant d'avoir été facturée.
         lease_expires_at = now() + make_interval(
           secs => greatest(120, least(v_session.reserved_seconds, p_max_session_seconds) + 300)
         ),
         last_heartbeat_at = now(),
         provider_session_id = coalesce(p_provider_session_id, provider_session_id)
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'kind', 'activated');
end
$$;

-- ---------------------------------------------------------------------
-- 9. Battement de cœur (diagnostic ; ne sert jamais à facturer)
-- ---------------------------------------------------------------------
create or replace function public.voice_touch(
  p_user_id uuid,
  p_session_id uuid,
  p_lease_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
begin
  if p_lease_seconds is null or p_lease_seconds <= 0 then
    raise exception 'voice_touch: p_lease_seconds is required';
  end if;

  select state into v_state
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  if v_state <> 'active' then
    return jsonb_build_object('ok', false, 'kind', 'not_active', 'state', v_state);
  end if;

  update public.voice_sessions
     set lease_expires_at = now() + make_interval(secs => p_lease_seconds),
         last_heartbeat_at = now()
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'kind', 'touched');
end
$$;

-- ---------------------------------------------------------------------
-- 10. Règlement : la durée est MESURÉE, bornée par la réservation
-- ---------------------------------------------------------------------
-- Aucun paramètre de durée. `p_max_session_seconds` est un plafond de
-- sécurité, pas une durée : la borne réelle est la réservation.
--
-- Le montant est calculé exactement comme dans `voice_close_overdue`
-- (durée mesurée, puis `least(..., réservation)`) : un règlement manuel et un
-- règlement automatique au même instant donnent le même chiffre.
create or replace function public.voice_settle(
  p_user_id             uuid,
  p_session_id          uuid,
  p_max_session_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session  record;
  v_bound    integer;
  v_measured integer;
  v_charge   integer;
  v_used     integer;
begin
  if p_max_session_seconds is null or p_max_session_seconds <= 0 then
    raise exception 'voice_settle: p_max_session_seconds is required (no SQL default)';
  end if;

  select id, user_id, usage_day, reserved_seconds, state, charged_seconds, started_at
    into v_session
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  if v_session.state = 'settled' then
    select consumed_seconds into v_used
      from public.voice_usage_daily
     where user_id = p_user_id and usage_day = v_session.usage_day;
    return jsonb_build_object(
      'ok', true, 'kind', 'already_settled',
      'charged_seconds', coalesce(v_session.charged_seconds, 0),
      'used_seconds', coalesce(v_used, 0)
    );
  end if;

  if v_session.state in ('refunded', 'expired') then
    return jsonb_build_object('ok', true, 'kind', 'already_released', 'charged_seconds', 0);
  end if;

  -- Réservation jamais activée : rien ne s'est passé, rien n'est facturé.
  if v_session.state = 'pending' then
    update public.voice_usage_daily
       set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
           updated_at = now()
     where user_id = p_user_id and usage_day = v_session.usage_day;

    update public.voice_sessions
       set state = 'refunded', closed_at = now(), charged_seconds = 0
     where id = p_session_id;

    return jsonb_build_object('ok', true, 'kind', 'never_started', 'charged_seconds', 0);
  end if;

  -- Session active : durée mesurée par PostgreSQL, bornée par la réservation.
  v_bound := least(v_session.reserved_seconds, p_max_session_seconds);
  v_measured := greatest(0, floor(extract(epoch from (now() - v_session.started_at)))::integer);
  v_charge := least(v_measured, v_bound);

  update public.voice_usage_daily
     set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
         consumed_seconds = consumed_seconds + v_charge,
         updated_at = now()
   where user_id = p_user_id and usage_day = v_session.usage_day
  returning consumed_seconds into v_used;

  update public.voice_sessions
     set state = 'settled', closed_at = now(), charged_seconds = v_charge
   where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'kind', 'settled',
    'charged_seconds', v_charge,
    'measured_seconds', v_measured,
    'used_seconds', coalesce(v_used, 0)
  );
end
$$;

-- ---------------------------------------------------------------------
-- 11. Remboursement
-- ---------------------------------------------------------------------
create or replace function public.voice_refund(
  p_user_id uuid,
  p_session_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
begin
  select id, usage_day, reserved_seconds, state
    into v_session
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  if v_session.state not in ('pending', 'active') then
    return jsonb_build_object('ok', true, 'kind', 'already_released', 'charged_seconds', 0);
  end if;

  if v_session.usage_day is not null then
    update public.voice_usage_daily
       set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
           updated_at = now()
     where user_id = p_user_id and usage_day = v_session.usage_day;
  end if;

  update public.voice_sessions
     set state = 'refunded', closed_at = now(), charged_seconds = 0
   where id = v_session.id;

  return jsonb_build_object('ok', true, 'kind', 'refunded', 'charged_seconds', 0);
end
$$;

-- ---------------------------------------------------------------------
-- 12. Lecture de la consommation
-- ---------------------------------------------------------------------
create or replace function public.voice_usage_read(p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day      date := (now() at time zone 'utc')::date;
  v_consumed integer := 0;
  v_reserved integer := 0;
begin
  select consumed_seconds, reserved_seconds
    into v_consumed, v_reserved
    from public.voice_usage_daily
   where user_id = p_user_id and usage_day = v_day;

  return jsonb_build_object(
    'day', v_day,
    'consumed_seconds', coalesce(v_consumed, 0),
    'reserved_seconds', coalesce(v_reserved, 0)
  );
end
$$;

-- ---------------------------------------------------------------------
-- 13. Privilèges : le serveur seul écrit
-- ---------------------------------------------------------------------
revoke all on function public.voice_usage_row(uuid, date) from public, anon, authenticated;
revoke all on function public.voice_expire_stale(uuid) from public, anon, authenticated;
revoke all on function public.voice_close_overdue(uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_reserve(uuid, integer, integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.voice_activate(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.voice_touch(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_refund(uuid, uuid) from public, anon, authenticated;
revoke all on function public.voice_usage_read(uuid) from public, anon, authenticated;

grant execute on function public.voice_usage_row(uuid, date) to service_role;
grant execute on function public.voice_expire_stale(uuid) to service_role;
grant execute on function public.voice_close_overdue(uuid, integer) to service_role;
grant execute on function public.voice_reserve(uuid, integer, integer, text, integer, integer) to service_role;
grant execute on function public.voice_activate(uuid, uuid, integer, text) to service_role;
grant execute on function public.voice_touch(uuid, uuid, integer) to service_role;
grant execute on function public.voice_settle(uuid, uuid, integer) to service_role;
grant execute on function public.voice_refund(uuid, uuid) to service_role;
grant execute on function public.voice_usage_read(uuid) to service_role;

grant select on public.voice_usage_daily to authenticated;
grant select on public.voice_sessions to authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (facultatif, à exécuter ensuite)
-- =====================================================================
-- -- 1) Réservation avec 60 s restantes sur un plan Plus (600 s)
-- select public.voice_reserve('<uuid>', 600, 3600, 'brise', 300, 60);
-- -- → reserved_seconds = 60 (le crédit restant), PAS 3600
--
-- -- 2) La durée ne vient jamais de l'appelant
-- select public.voice_settle('<uuid>', '<session_id>', 3600);
-- -- → charged_seconds = temps écoulé, borné par la réservation
--
-- -- 3) Deux appareils
-- select public.voice_reserve('<uuid>', 600, 3600, 'brise', 300, 60);
-- -- → {"ok": false, "kind": "voice_session_open"}
--
-- -- 4) Rejouable sans perte
-- select count(*) from public.voice_sessions;   -- avant
-- -- relancer le fichier entier
-- select count(*) from public.voice_sessions;   -- après : identique
-- =====================================================================
