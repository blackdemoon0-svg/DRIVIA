-- =====================================================================
-- VEYVRO — 0004 : quota vocal persistant et partagé entre instances
-- =====================================================================
-- CONTEXTE
--   Le quota vocal vivait dans un `Map` en mémoire, dans `server/quotas.ts`.
--   Deux conséquences, écrites noir sur blanc dans le code :
--     • un redémarrage à froid ou un redéploiement remettait le compteur à
--       zéro — un compte Pro pouvait donc consommer 30 minutes par instance ;
--     • deux instances Vercel ne partageaient rien : ouvrir deux onglets
--       routés vers deux instances doublait le quota réellement utilisable.
--
--   Cette migration déplace le compteur dans Postgres, où il est partagé et
--   durable. Elle ajoute deux tables et cinq fonctions.
--
--   Rien n'est modifié dans l'existant : `subscriptions`, `webhook_events`,
--   `profiles`, `ai_usage_daily` et `ai_usage_events` ne sont pas touchés.
--
-- CE QUE LA BASE GARANTIT, ET QUE LE CODE SEUL NE POUVAIT PAS GARANTIR
--   1. Réservation atomique : l'incrément est un UPDATE verrouillé par ligne,
--      avec la condition d'autorisation DANS le WHERE. Deux réservations
--      concurrentes ne peuvent pas passer toutes les deux.
--   2. Une seule session ouverte par compte : index unique partiel. Deux
--      onglets ne peuvent pas facturer deux fois.
--   3. Remboursement : `voice_refund` rend la réservation, sans effet si la
--      session est déjà réglée (idempotence par état).
--   4. Régularisation : `voice_settle` remplace la réservation par la durée
--      réelle, une seule fois, et ne peut pas être rejouée.
--   5. Bail : une session dont la réservation expire est libérée
--      automatiquement. Un onglet tué sans `voice-end` ne bloque pas le compte
--      indéfiniment et ne consomme pas de minutes fantômes.
--
-- SÉCURITÉ
--   * RLS activée sur les deux tables ;
--   * l'écriture n'est possible que par `service_role` (le serveur) : les
--     fonctions sont SECURITY DEFINER, révoquées pour anon et authenticated ;
--   * un utilisateur authentifié peut seulement LIRE sa propre consommation.
--
-- ⚠️ NON EXÉCUTÉE. Ce fichier est proposé, pas appliqué. À relire puis à
--    lancer soi-même (Supabase → SQL Editor) sur le projet voulu.
--    Idempotente : peut être rejouée sans erreur.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Consommation quotidienne, par compte et par jour UTC
-- ---------------------------------------------------------------------
-- `reserved_seconds` et `consumed_seconds` sont séparés volontairement :
-- une réservation peut être rendue, une consommation ne l'est pas. Les
-- mélanger rendrait le remboursement impossible à distinguer d'une remise.
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
-- 2. Sessions vocales : la réservation, et sa preuve d'expiration
-- ---------------------------------------------------------------------
-- Une ligne par session ouverte. C'est l'équivalent durable de l'ancien
-- registre en mémoire : la durée facturée est celle de `started_at` ici, pas
-- celle que le navigateur prétend.
create table if not exists public.voice_sessions (
  id                     uuid        primary key default gen_random_uuid(),
  user_id                uuid        not null references auth.users (id) on delete cascade,
  voice_id               text        not null,
  usage_day              date        not null,
  reserved_seconds       integer     not null,
  state                  text        not null default 'open',
  started_at             timestamptz not null default now(),
  reservation_expires_at timestamptz not null,
  closed_at              timestamptz,
  charged_seconds        integer,
  constraint voice_sessions_state_check
    check (state in ('open', 'settled', 'refunded', 'expired')),
  constraint voice_sessions_reserved_positive check (reserved_seconds > 0),
  constraint voice_sessions_charged_non_negative
    check (charged_seconds is null or charged_seconds >= 0)
);

comment on table public.voice_sessions is
  'Sessions vocales ouvertes et réglées. La durée facturée vient de started_at, jamais du client.';

create index if not exists voice_sessions_user_started_idx
  on public.voice_sessions (user_id, started_at desc);

-- Garantie dure : un compte ne peut avoir qu'UNE session ouverte à la fois,
-- quelle que soit l'instance qui la crée. Deux onglets, deux instances, deux
-- régions : c'est la base qui tranche, pas une vérification applicative.
create unique index if not exists voice_sessions_one_open_per_user
  on public.voice_sessions (user_id)
  where state = 'open';

-- ---------------------------------------------------------------------
-- 3. RLS : lecture de sa propre consommation, écriture serveur uniquement
-- ---------------------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'voice_usage_daily' and c.relrowsecurity
  ) then
    execute 'alter table public.voice_usage_daily enable row level security';
  end if;
  if not exists (
    select 1 from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'voice_sessions' and c.relrowsecurity
  ) then
    execute 'alter table public.voice_sessions enable row level security';
  end if;
end
$$;

drop policy if exists "voice_usage_daily_own_read" on public.voice_usage_daily;
create policy "voice_usage_daily_own_read"
  on public.voice_usage_daily
  for select
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "voice_sessions_own_read" on public.voice_sessions;
create policy "voice_sessions_own_read"
  on public.voice_sessions
  for select
  to authenticated
  using (user_id = auth.uid());

-- Aucune politique d'écriture : le navigateur ne peut rien écrire ici. Le
-- service role contourne la RLS, c'est lui qui écrit, et lui seul.

-- ---------------------------------------------------------------------
-- 4. Libération des réservations expirées
-- ---------------------------------------------------------------------
-- Appelée au début de chaque réservation, pour ce compte uniquement : le coût
-- reste borné et on n'attend pas un cron.
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
       and state = 'open'
       and reservation_expires_at < now()
     for update
  loop
    update public.voice_sessions
       set state = 'expired',
           closed_at = now(),
           charged_seconds = 0
     where id = v_row.id;

    -- La réservation est rendue intégralement : une session dont on n'a
    -- jamais su la durée ne doit rien coûter.
    update public.voice_usage_daily
       set reserved_seconds = greatest(0, reserved_seconds - v_row.reserved_seconds),
           updated_at = now()
     where user_id = p_user_id
       and usage_day = v_row.usage_day;

    v_count := v_count + 1;
  end loop;

  return v_count;
end
$$;

-- ---------------------------------------------------------------------
-- 5. Réservation atomique
-- ---------------------------------------------------------------------
-- Renvoie un JSON : { ok, kind, ... }. Pas d'exception pour un refus, qui
-- n'est pas une erreur mais une décision métier.
--
-- L'ordre des refus est celui du produit :
--   a) formule sans voix      → voice_not_in_plan
--   b) session déjà ouverte   → voice_session_open
--   c) quota insuffisant      → voice_minutes_exhausted
create or replace function public.voice_reserve(
  p_user_id           uuid,
  p_allowance_seconds integer,
  p_reserve_seconds   integer,
  p_voice_id          text,
  p_ttl_seconds       integer default 3600
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_day       date;
  v_consumed  integer := 0;
  v_reserved  integer := 0;
  v_session   uuid;
  v_open_id   uuid;
  v_open_until timestamptz;
  v_used      integer;
begin
  if p_user_id is null then
    raise exception 'voice_reserve: p_user_id is required';
  end if;
  if p_reserve_seconds is null or p_reserve_seconds <= 0 then
    raise exception 'voice_reserve: p_reserve_seconds must be positive';
  end if;

  v_day := (now() at time zone 'utc')::date;

  -- a) La formule n'ouvre aucun droit vocal : on refuse avant tout appel
  --    fournisseur, et donc avant toute dépense.
  if coalesce(p_allowance_seconds, 0) <= 0 then
    return jsonb_build_object(
      'ok', false,
      'kind', 'voice_not_in_plan',
      'used_seconds', 0,
      'limit_seconds', 0
    );
  end if;

  -- a bis) Libère les baux périmés de CE compte.
  perform public.voice_expire_stale(p_user_id);

  -- b) Une session est-elle déjà ouverte ? La contrainte d'unicité ci-dessous
  --    le garantirait de toute façon, mais le dire ici permet un message juste.
  select id, reservation_expires_at
    into v_open_id, v_open_until
    from public.voice_sessions
   where user_id = p_user_id and state = 'open'
   limit 1;

  if v_open_id is not null then
    return jsonb_build_object(
      'ok', false,
      'kind', 'voice_session_open',
      'open_session_id', v_open_id,
      'retry_after_seconds', greatest(1, ceil(extract(epoch from (v_open_until - now())))::integer)
    );
  end if;

  -- La ligne du jour doit exister : insertion idempotente, sans effet si elle
  -- est déjà là. Hors du bloc protégé, elle doit survivre à un refus, ce qui
  -- est sans conséquence (une ligne à zéro n'accorde rien).
  insert into public.voice_usage_daily (user_id, usage_day)
  values (p_user_id, v_day)
  on conflict (user_id, usage_day) do nothing;

  -- b bis) et c) Incrément et création de session dans un MÊME bloc protégé :
  --    si l'insertion de la session échoue (course sur l'index unique), le
  --    bloc annule l'incrément. Aucune seconde n'est perdue au passage.
  begin
    update public.voice_usage_daily
       set reserved_seconds = reserved_seconds + p_reserve_seconds,
           updated_at = now()
     where user_id = p_user_id
       and usage_day = v_day
       -- La condition d'autorisation est DANS le WHERE : c'est ce qui rend
       -- l'opération atomique sous concurrence. Un compte à court de minutes
       -- ne peut pas passer entre deux lectures.
       and consumed_seconds + reserved_seconds + p_reserve_seconds <= p_allowance_seconds
    returning consumed_seconds, reserved_seconds
      into v_consumed, v_reserved;

    if v_reserved is null then
      -- Plus assez de minutes : on relit pour donner un chiffre exact.
      select consumed_seconds + reserved_seconds
        into v_used
        from public.voice_usage_daily
       where user_id = p_user_id and usage_day = v_day;

      return jsonb_build_object(
        'ok', false,
        'kind', 'voice_minutes_exhausted',
        'used_seconds', coalesce(v_used, 0),
        'limit_seconds', p_allowance_seconds
      );
    end if;

    insert into public.voice_sessions (
      user_id, voice_id, usage_day, reserved_seconds, reservation_expires_at
    ) values (
      p_user_id, coalesce(p_voice_id, 'brise'), v_day, p_reserve_seconds,
      now() + make_interval(secs => greatest(60, coalesce(p_ttl_seconds, 3600)))
    )
    returning id into v_session;
  exception
    when unique_violation then
      -- Une autre requête a ouvert une session au même instant. Le bloc annule
      -- l'incrément : on renvoie un refus propre, pas une erreur 500.
      return jsonb_build_object(
        'ok', false,
        'kind', 'voice_session_open',
        'retry_after_seconds', 60
      );
  end;

  return jsonb_build_object(
    'ok', true,
    'session_id', v_session,
    'reserved_seconds', p_reserve_seconds,
    'used_seconds', v_consumed + v_reserved,
    'remaining_seconds', greatest(0, p_allowance_seconds - (v_consumed + v_reserved))
  );
end
$$;

-- ---------------------------------------------------------------------
-- 6. Régularisation à la fermeture
-- ---------------------------------------------------------------------
-- Remplace la réservation par la durée réelle. Idempotent : une seconde
-- fermeture (beacon tardif, onglet rouvert) ne facture rien de plus.
create or replace function public.voice_settle(
  p_user_id        uuid,
  p_session_id     uuid,
  p_actual_seconds integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_session record;
  v_charge  integer;
  v_used    integer;
begin
  -- Verrou de ligne : deux fermetures simultanées ne peuvent pas régler deux
  -- fois la même session.
  select id, user_id, usage_day, reserved_seconds, state, charged_seconds
    into v_session
    from public.voice_sessions
   where id = p_session_id and user_id = p_user_id
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'kind', 'unknown_session');
  end if;

  if v_session.state = 'settled' then
    select consumed_seconds
      into v_used
      from public.voice_usage_daily
     where user_id = p_user_id and usage_day = v_session.usage_day;
    return jsonb_build_object(
      'ok', true,
      'kind', 'already_settled',
      'charged_seconds', coalesce(v_session.charged_seconds, 0),
      'used_seconds', coalesce(v_used, 0)
    );
  end if;

  if v_session.state in ('refunded', 'expired') then
    -- La réservation a déjà été rendue : rien à facturer, et surtout pas deux
    -- fois.
    return jsonb_build_object(
      'ok', true,
      'kind', 'already_released',
      'charged_seconds', 0
    );
  end if;

  -- On facture ce qui a réellement été consommé, même au-delà de la
  -- réservation : une session de 90 s coûte 90 s. Le dépassement est ensuite
  -- bloquant pour la réservation suivante, ce qui est le comportement voulu.
  v_charge := greatest(0, coalesce(p_actual_seconds, 0));

  update public.voice_usage_daily
     set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
         consumed_seconds = consumed_seconds + v_charge,
         updated_at = now()
   where user_id = p_user_id
     and usage_day = v_session.usage_day
  returning consumed_seconds into v_used;

  update public.voice_sessions
     set state = 'settled',
         closed_at = now(),
         charged_seconds = v_charge
   where id = p_session_id;

  return jsonb_build_object(
    'ok', true,
    'kind', 'settled',
    'charged_seconds', v_charge,
    'used_seconds', coalesce(v_used, 0)
  );
end
$$;

-- ---------------------------------------------------------------------
-- 7. Remboursement d'une session qui n'a jamais abouti
-- ---------------------------------------------------------------------
-- Appelé quand le fournisseur refuse, tombe, ou ne renvoie pas de SDP : la
-- réservation est rendue en entier. Idempotent par état.
create or replace function public.voice_refund(
  p_user_id    uuid,
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

  if v_session.state <> 'open' then
    -- Déjà réglée, remboursée ou expirée : ne rien faire est la bonne réponse.
    return jsonb_build_object('ok', true, 'kind', 'already_released', 'charged_seconds', 0);
  end if;

  update public.voice_usage_daily
     set reserved_seconds = greatest(0, reserved_seconds - v_session.reserved_seconds),
         updated_at = now()
   where user_id = p_user_id
     and usage_day = v_session.usage_day;

  update public.voice_sessions
     set state = 'refunded',
         closed_at = now(),
         charged_seconds = 0
   where id = v_session.id;

  return jsonb_build_object('ok', true, 'kind', 'refunded', 'charged_seconds', 0);
end
$$;

-- ---------------------------------------------------------------------
-- 8. Lecture de la consommation (interface et diagnostic)
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
-- 9. Privilèges : le serveur seul écrit
-- ---------------------------------------------------------------------
revoke all on function public.voice_expire_stale(uuid) from public, anon, authenticated;
revoke all on function public.voice_reserve(uuid, integer, integer, text, integer) from public, anon, authenticated;
revoke all on function public.voice_settle(uuid, uuid, integer) from public, anon, authenticated;
revoke all on function public.voice_refund(uuid, uuid) from public, anon, authenticated;
revoke all on function public.voice_usage_read(uuid) from public, anon, authenticated;

grant execute on function public.voice_expire_stale(uuid) to service_role;
grant execute on function public.voice_reserve(uuid, integer, integer, text, integer) to service_role;
grant execute on function public.voice_settle(uuid, uuid, integer) to service_role;
grant execute on function public.voice_refund(uuid, uuid) to service_role;
grant execute on function public.voice_usage_read(uuid) to service_role;

-- Lecture seule de ses propres lignes (RLS ci-dessus s'applique).
grant select on public.voice_usage_daily to authenticated;
grant select on public.voice_sessions to authenticated;

commit;

-- =====================================================================
-- VÉRIFICATION (facultatif, à exécuter ensuite)
-- =====================================================================
-- select id, name from storage.buckets where id = 'avatars';          -- témoin
--
-- -- Formule Plus, 10 minutes, une réservation de 60 s :
-- select public.voice_reserve('<uuid>', 600, 60, 'brise', 3600);
-- -- → {"ok": true, "session_id": "...", "remaining_seconds": 540, ...}
--
-- -- Deuxième réservation immédiate : refusée, une session est ouverte.
-- select public.voice_reserve('<uuid>', 600, 60, 'brise', 3600);
-- -- → {"ok": false, "kind": "voice_session_open", ...}
--
-- -- Fermeture après 20 s : 20 s consommées, 40 s rendues.
-- select public.voice_settle('<uuid>', '<session_id>', 20);
-- select public.voice_usage_read('<uuid>');
-- -- → {"consumed_seconds": 20, "reserved_seconds": 0}
-- =====================================================================
