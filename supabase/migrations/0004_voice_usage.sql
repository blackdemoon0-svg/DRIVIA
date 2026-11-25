-- =====================================================================
-- VEYVRO — 0004 : quota vocal persistant, partagé, et facturé au temps
--                 réellement passé en conversation
-- =====================================================================
-- ⚠️ VERSION 2 — REMPLACE la version précédente, jamais exécutée.
--    La première version faisait transiter la durée par `p_actual_seconds`,
--    c'est-à-dire par un chiffre fourni par le navigateur. Un client envoyant
--    `durationSeconds: 0` ne payait rien. Le défaut est corrigé ici en
--    supprimant le paramètre : la durée n'est plus transmise, elle est
--    CALCULÉE dans cette fonction à partir de `started_at`.
--
-- CONTEXTE
--   Le quota vocal vivait dans un `Map` en mémoire. Deux conséquences :
--   perdu au redémarrage, et non partagé entre instances — 30 minutes par
--   instance au lieu de 30 minutes par jour. Il vit désormais dans Postgres.
--
-- LES DEUX PROBLÈMES QUE CETTE VERSION RÈGLE
--
--   1. LA DURÉE. Elle était fournie par l'appelant. Elle est maintenant
--      `now() - started_at`, calculée ici, et cette fonction n'accepte AUCUN
--      paramètre de durée. Un client ne peut donc plus ni se sous-facturer, ni
--      se sur-facturer.
--
--   2. LE TEMPS DE PRÉPARATION. `started_at` était posé à la réservation, donc
--      AVANT l'échange SDP avec le fournisseur — jusqu'à 20 s de préparation
--      étaient facturées à l'utilisateur. Une session a maintenant deux
--      phases :
--        • `pending` — la réservation est posée, `started_at` est NULL, rien
--          n'est facturable. C'est l'état où l'offre SDP voyage ;
--        • `active`  — `voice_activate` est appelé APRÈS la réponse réussie du
--          fournisseur, et c'est là que `started_at` est posé.
--      Seul le temps passé en `active` est facturé.
--
-- CE QUE LA BASE GARANTIT
--   • une seule session `pending` ou `active` par compte — index unique
--     partiel. Deux appareils ne peuvent pas converser en même temps ;
--   • une réservation atomique : la condition est dans le `UPDATE ... WHERE` ;
--   • règlement et remboursement idempotents, par état ;
--   • le bail (`lease_expires_at`) ne s'applique QU'AUX réservations en
--     attente. Une session `active` n'est jamais balayée : elle ne peut se
--     terminer que par un règlement, un remboursement, ou le plafond dur de
--     session.
--
--   C'est la réponse au scénario « deux appareils » : une conversation de plus
--   d'une heure ne peut pas être libérée par expiration. La seule sortie est le
--   plafond dur (`p_max_session_seconds`, 3600 s = la limite documentée de
--   GPT-Live), qui la CLÔT avant d'en autoriser une autre. Jamais deux
--   conversations réellement actives.
--
-- SÉCURITÉ
--   * RLS activée ; écriture réservée au service role (SECURITY DEFINER et
--     privilèges révoqués pour anon/authenticated) ;
--   * un utilisateur authentifié peut seulement LIRE sa propre consommation.
--
-- ⚠️ NON EXÉCUTÉE. Ce fichier est proposé, pas appliqué.
--    Idempotente : peut être rejouée sans erreur.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 0. Retrait de la version précédente, si elle avait été appliquée
-- ---------------------------------------------------------------------
-- Sans danger sur une base vierge. Nécessaire si quelqu'un avait exécuté la
-- v1 : la table `voice_sessions` y avait une autre forme.
drop function if exists public.voice_settle(uuid, uuid, integer);
drop function if exists public.voice_reserve(uuid, integer, integer, text, integer);
drop function if exists public.voice_refund(uuid, uuid);
drop function if exists public.voice_usage_read(uuid);
drop function if exists public.voice_expire_stale(uuid);
drop function if exists public.voice_activate(uuid, uuid, text);
drop function if exists public.voice_touch(uuid, uuid, integer);
drop table if exists public.voice_sessions;
drop table if exists public.voice_usage_daily;

-- ---------------------------------------------------------------------
-- 1. Consommation quotidienne, par compte et par jour UTC
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
  constraint voice_usage_daily_pkey primary key (user_id, usage_day),
  constraint voice_usage_daily_non_negative
    check (consumed_seconds >= 0 and reserved_seconds >= 0)
);

comment on table public.voice_usage_daily is
  'Compteur vocal quotidien (UTC) par compte. Écrit uniquement par les fonctions voice_* (service role).';

-- ---------------------------------------------------------------------
-- 2. Sessions vocales : réservation, puis session active
-- ---------------------------------------------------------------------
create table if not exists public.voice_sessions (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references auth.users (id) on delete cascade,
  voice_id           text        not null,
  usage_day          date        not null,
  reserved_seconds   integer     not null,
  state              text        not null default 'pending',
  -- Posé à la réservation, pour l'audit seulement. JAMAIS utilisé pour
  -- facturer : voir `started_at`.
  created_at         timestamptz not null default now(),
  -- Posé par `voice_activate`, APRÈS la réponse du fournisseur. C'est le seul
  -- horodatage dont la facturation dépend.
  started_at         timestamptz,
  -- Bail. Ne s'applique qu'aux réservations `pending`.
  lease_expires_at   timestamptz not null,
  last_heartbeat_at  timestamptz,
  provider_session_id text,
  closed_at          timestamptz,
  charged_seconds    integer,
  constraint voice_sessions_state_check
    check (state in ('pending', 'active', 'settled', 'refunded', 'expired')),
  constraint voice_sessions_reserved_positive check (reserved_seconds > 0),
  constraint voice_sessions_charged_non_negative
    check (charged_seconds is null or charged_seconds >= 0),
  -- Cohérence d'état : on ne facture pas une session qui n'a jamais démarré.
  --   • pending / expired : jamais activée, donc aucun horodatage ;
  --   • active / settled  : a réellement tourné, donc un horodatage ;
  --   • refunded          : peut venir des deux (réservation abandonnée OU
  --                         session active remboursée), d'où l'absence de
  --                         contrainte sur `started_at`.
  constraint voice_sessions_started_consistency check (
    (state in ('pending', 'expired') and started_at is null)
    or (state in ('active', 'settled') and started_at is not null)
    or state = 'refunded'
  )
);

comment on table public.voice_sessions is
  'Sessions vocales : pending (réservation) puis active (started_at posé). La durée facturée vient de started_at, jamais de l''appelant.';

create index if not exists voice_sessions_user_created_idx
  on public.voice_sessions (user_id, created_at desc);

-- Un compte ne peut avoir qu'UNE session en cours, réservation ou active.
-- C'est la garantie dure contre deux conversations simultanées.
create unique index if not exists voice_sessions_one_live_per_user
  on public.voice_sessions (user_id)
  where state in ('pending', 'active');

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'voice_usage_daily' and c.relrowsecurity
  ) then
    execute 'alter table public.voice_usage_daily enable row level security';
  end if;
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'voice_sessions' and c.relrowsecurity
  ) then
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

-- Aucune politique d'écriture : le navigateur ne peut rien écrire. Le service
-- role contourne la RLS, c'est lui qui écrit, et lui seul.

-- ---------------------------------------------------------------------
-- 4. Libération des RÉSERVATIONS expirées — jamais des sessions actives
-- ---------------------------------------------------------------------
-- C'est ici que se joue le scénario « deux appareils ». Une session `active`
-- n'est jamais balayée : une conversation de plus d'une heure reste protégée.
-- Seule une réservation `pending` dont l'offre SDP n'a jamais abouti est
-- libérée.
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
       set state = 'expired',
           closed_at = now(),
           charged_seconds = 0
     where id = v_row.id;

    update public.voice_usage_daily
       set reserved_seconds = greatest(0, reserved_seconds - v_row.reserved_seconds),
           updated_at = now()
     where user_id = p_user_id and usage_day = v_row.usage_day;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Clôture d'une session active au-delà du plafond dur
-- ---------------------------------------------------------------------
-- Une session ne peut pas durer plus que le maximum documenté de GPT-Live.
-- Passé ce plafond, elle n'est plus une conversation : c'est une session
-- abandonnée. On la clôt et on la facture au plafond, AVANT d'en autoriser une
-- autre. C'est la seule façon dont une session `active` peut se terminer sans
-- que le client demande sa fermeture.
create or replace function public.voice_close_overdue(
  p_user_id uuid,
  p_max_session_seconds integer default 3600
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_row    record;
  v_charge integer;
  v_max    integer := greatest(60, coalesce(p_max_session_seconds, 3600));
  v_count  integer := 0;
begin
  for v_row in
    select id, usage_day, reserved_seconds, started_at
      from public.voice_sessions
     where user_id = p_user_id
       and state = 'active'
       and started_at is not null
       and started_at + make_interval(secs => v_max) <= now()
     for update
  loop
    -- Facturé au plafond : la session a bien duré au moins cela.
    v_charge := v_max;

    update public.voice_usage_daily
       set reserved_seconds = greatest(0, reserved_seconds - v_row.reserved_seconds),
           consumed_seconds = consumed_seconds + v_charge,
           updated_at = now()
     where user_id = p_user_id and usage_day = v_row.usage_day;

    update public.voice_sessions
       set state = 'settled',
           closed_at = now(),
           charged_seconds = v_charge
     where id = v_row.id;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- 6. Réservation atomique
-- ---------------------------------------------------------------------
-- Refus dans l'ordre du produit :
--   a) formule sans voix          → voice_not_in_plan
--   b) session déjà en cours      → voice_session_open
--   c) quota insuffisant          → voice_minutes_exhausted
create or replace function public.voice_reserve(
  p_user_id           uuid,
  p_allowance_seconds integer,
  p_reserve_seconds   integer,
  p_voice_id          text,
  p_ttl_seconds       integer default 300,
  p_max_session_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day        date;
  v_consumed   integer := 0;
  v_reserved   integer := 0;
  v_session    uuid;
  v_live       record;
  v_used       integer;
begin
  if p_user_id is null then
    raise exception 'voice_reserve: p_user_id is required';
  end if;
  if p_reserve_seconds is null or p_reserve_seconds <= 0 then
    raise exception 'voice_reserve: p_reserve_seconds must be positive';
  end if;

  v_day := (now() at time zone 'utc')::date;

  -- a) Aucun droit vocal : refus avant tout appel fournisseur, donc avant
  --    toute dépense.
  if coalesce(p_allowance_seconds, 0) <= 0 then
    return jsonb_build_object(
      'ok', false, 'kind', 'voice_not_in_plan',
      'used_seconds', 0, 'limit_seconds', 0
    );
  end if;

  -- Les réservations abandonnées sont libérées ; les sessions ACTIVES ne le
  -- sont jamais.
  perform public.voice_expire_stale(p_user_id);

  -- Une session active au-delà du plafond dur est close avant tout examen :
  -- elle n'est plus une conversation, et elle seule peut libérer la place.
  perform public.voice_close_overdue(p_user_id, p_max_session_seconds);

  -- b) Une session est-elle encore en cours ? À ce stade, `active` comme
  --    `pending` comptent. C'est la protection principale.
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
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_live.lease_expires_at - now())))::integer)
    );
  end if;

  insert into public.voice_usage_daily (user_id, usage_day)
  values (p_user_id, v_day)
  on conflict (user_id, usage_day) do nothing;

  begin
    update public.voice_usage_daily
       set reserved_seconds = reserved_seconds + p_reserve_seconds,
           updated_at = now()
     where user_id = p_user_id
       and usage_day = v_day
       -- Condition d'autorisation DANS le WHERE : c'est ce qui rend
       -- l'opération atomique sous concurrence.
       and consumed_seconds + reserved_seconds + p_reserve_seconds <= p_allowance_seconds
    returning consumed_seconds, reserved_seconds
      into v_consumed, v_reserved;

    if v_reserved is null then
      select consumed_seconds + reserved_seconds
        into v_used
        from public.voice_usage_daily
       where user_id = p_user_id and usage_day = v_day;

      return jsonb_build_object(
        'ok', false, 'kind', 'voice_minutes_exhausted',
        'used_seconds', coalesce(v_used, 0), 'limit_seconds', p_allowance_seconds
      );
    end if;

    insert into public.voice_sessions (
      user_id, voice_id, usage_day, reserved_seconds, state, lease_expires_at
    ) values (
      p_user_id, coalesce(p_voice_id, 'brise'), v_day, p_reserve_seconds, 'pending',
      now() + make_interval(secs => greatest(30, coalesce(p_ttl_seconds, 300)))
    )
    returning id into v_session;
  exception
    when unique_violation then
      -- Une autre requête a ouvert une session au même instant. Le bloc annule
      -- l'incrément : refus propre, pas une erreur 500.
      return jsonb_build_object(
        'ok', false, 'kind', 'voice_session_open', 'retry_after_seconds', 30
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session,
    'state', 'pending',
    'reserved_seconds', p_reserve_seconds,
    'used_seconds', v_consumed + v_reserved,
    'remaining_seconds', greatest(0, p_allowance_seconds - (v_consumed + v_reserved))
  );
end
$$;

-- ---------------------------------------------------------------------
-- 7. Activation : c'est ICI que la facturation commence
-- ---------------------------------------------------------------------
-- Appelée après la réponse réussie du fournisseur, une fois l'offre SDP
-- échangée. `started_at` est posé maintenant : le temps de préparation de la
-- connexion n'est donc pas facturé.
--
-- Le bail passe de « quelques minutes » (réservation) à la durée d'une session :
-- une conversation active n'expire pas au bout de cinq minutes.
create or replace function public.voice_activate(
  p_user_id            uuid,
  p_session_id         uuid,
  p_lease_seconds      integer default 3900,
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
  select id, state, lease_expires_at
    into v_session
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  -- Déjà activée : idempotent, on ne recule pas `started_at`. Un appel réseau
  -- rejoué ne doit pas raccourcir la facturation.
  if v_session.state = 'active' then
    return jsonb_build_object('ok', true, 'kind', 'already_active', 'started_at', null);
  end if;

  if v_session.state <> 'pending' then
    return jsonb_build_object('ok', false, 'kind', 'not_pending', 'state', v_session.state);
  end if;

  update public.voice_sessions
     set state = 'active',
         started_at = now(),
         lease_expires_at = now() + make_interval(secs => greatest(120, coalesce(p_lease_seconds, 3900))),
         last_heartbeat_at = now(),
         provider_session_id = coalesce(p_provider_session_id, provider_session_id)
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'kind', 'activated');
end
$$;

-- ---------------------------------------------------------------------
-- 8. Battement de cœur : prolonge le bail d'une session active
-- ---------------------------------------------------------------------
-- Utile pour l'observabilité et pour distinguer une session vivante d'une
-- session oubliée. Il ne sert JAMAIS à facturer, et son absence ne prolonge
-- rien : le plafond dur reste la seule borne.
create or replace function public.voice_touch(
  p_user_id uuid,
  p_session_id uuid,
  p_lease_seconds integer default 3900
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
begin
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
     set lease_expires_at = now() + make_interval(secs => greatest(120, coalesce(p_lease_seconds, 3900))),
         last_heartbeat_at = now()
   where id = p_session_id;

  return jsonb_build_object('ok', true, 'kind', 'touched');
end
$$;

-- ---------------------------------------------------------------------
-- 9. Règlement — LA DURÉE EST CALCULÉE ICI, PAS REÇUE
-- ---------------------------------------------------------------------
-- Aucun paramètre de durée. C'est la correction du défaut bloquant : la valeur
-- facturée est `now() - started_at`, bornée par le plafond dur. Un client ne
-- peut ni se sous-facturer (`durationSeconds: 0`), ni se sur-facturer.
--
-- Idempotent : un second appel renvoie `already_settled` avec la durée
-- enregistrée au premier.
create or replace function public.voice_settle(
  p_user_id uuid,
  p_session_id uuid,
  p_max_session_seconds integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session    record;
  v_max        integer := greatest(60, coalesce(p_max_session_seconds, 3600));
  v_duration   integer;
  v_charge     integer;
  v_used       integer;
begin
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

  -- Session active : durée mesurée par PostgreSQL, puis bornée.
  v_duration := greatest(0, floor(extract(epoch from (now() - v_session.started_at))))::integer;
  v_charge := least(v_duration, v_max);

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
    'measured_seconds', v_duration,
    'used_seconds', coalesce(v_used, 0)
  );
end
$$;

-- ---------------------------------------------------------------------
-- 10. Remboursement d'une session qui n'a jamais abouti
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

  update public.voice_usage_daily
     set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
         updated_at = now()
   where user_id = p_user_id and usage_day = v_session.usage_day;

  update public.voice_sessions
     set state = 'refunded', closed_at = now(), charged_seconds = 0
   where id = v_session.id;

  return jsonb_build_object('ok', true, 'kind', 'refunded', 'charged_seconds', 0);
end
$$;

-- ---------------------------------------------------------------------
-- 11. Lecture de la consommation
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
-- 12. Privilèges : le serveur seul écrit
-- ---------------------------------------------------------------------
revoke all on function public.voice_expire_stale(uuid) from public, anon, authenticated;
revoke all on function public.voice_close_overdue(uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_reserve(uuid, integer, integer, text, integer, integer) from public, anon, authenticated;
revoke all on function public.voice_activate(uuid, uuid, integer, text) from public, anon, authenticated;
revoke all on function public.voice_touch(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_refund(uuid, uuid) from public, anon, authenticated;
revoke all on function public.voice_usage_read(uuid) from public, anon, authenticated;

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
-- -- 1) Réservation, puis activation
-- select public.voice_reserve('<uuid>', 600, 60, 'brise', 300, 3600);
-- -- → {"ok": true, "session_id": "...", "state": "pending", ...}
-- select public.voice_activate('<uuid>', '<session_id>', 3900, null);
-- -- → {"ok": true, "kind": "activated"}
--
-- -- 2) La durée NE PEUT PAS venir de l'appelant
-- select public.voice_settle('<uuid>', '<session_id>', 3600);
-- -- → charged_seconds = temps réel écoulé depuis l'activation, pas 0
--
-- -- 3) Deux appareils : refus tant que la session est active
-- select public.voice_reserve('<uuid>', 600, 60, 'brise');  -- après activation
-- -- → {"ok": false, "kind": "voice_session_open", "open_state": "active"}
-- =====================================================================
