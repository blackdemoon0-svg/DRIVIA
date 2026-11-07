-- =====================================================================
-- VEYVRO — 0004: P4-01 — cible de conflit nommée dans ai_usage_consume
-- =====================================================================
-- WHAT THIS MIGRATION DOES
--   Replaces public.ai_usage_consume(...) with the SAME body as 0003 §4.
--   Exactly ONE line changes:
--
--     before (0003, line 782):  on conflict (user_id, usage_day) do update
--     after  (this file):       on conflict on constraint ai_usage_daily_pkey do update
--
--   Nothing else: same parameter names, same defaults, same returned columns,
--   same SECURITY DEFINER, same `set search_path`, same owner, same ACL.
--
-- WHY (P4-01, measured on Preview on 2026-11-07)
--   The function returns `table (… usage_day date …)`. PL/pgSQL turns output
--   parameters into variables, and the ON CONFLICT target is parsed as an
--   expression list where variables are substituted. `usage_day` was therefore
--   ambiguous between the output variable and the column, and every call that
--   reached the quota upsert failed:
--
--     ERROR 42702: column reference "usage_day" is ambiguous
--
--   Only the two refusal branches that run BEFORE the upsert (limit = 0) worked.
--   The failure was reproduced under service_role, i.e. on the real PostgREST
--   path used by server/usageStore.ts.
--
--   Naming the constraint removes the ambiguity entirely: a named target
--   contains no column reference, so no name can collide with a variable.
--
-- WHAT IT DOES NOT DO
--   * it does not touch 0003, which stays byte-for-byte as applied;
--   * no table, column, index, constraint, trigger or policy change;
--   * no GRANT, no REVOKE, no role change: the function's ACL, owner and
--     attributes are captured before the replacement and compared afterwards —
--     any difference aborts the migration;
--   * no DML on any table;
--   * no new object: the only persistent change is the function's body.
--
-- WHY THE BEHAVIOUR IS PRESERVED BY CONSTRUCTION
--   The conflict target of an INSERT … ON CONFLICT designates the same index
--   whether it is given as a column list or by constraint name. Everything
--   that gives the quota its properties — the atomic claim on the ledger
--   primary key (§4.1), the conditional upsert whose WHERE carries the limit
--   (§4.6), the refusal that deletes its own claim (§4.7), the refund bound to
--   the event's day (§5) and the 3-attempt ceiling (§4.5) — is outside that one
--   line and is carried over verbatim.
--
-- FAIL-CLOSED
--   Three guards run first (function state, constraint shape, initial capture),
--   then a probe that proves the named target inserts, increments and honours
--   the WHERE limit. A failed guard or a failed probe rolls the whole
--   transaction back: nothing is applied.
--
-- NOT APPLIED. Prepared only: this file has not been executed against any
-- Supabase project. Applying it requires explicit authorisation (P4-bis).
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Guard — the function this migration replaces is the one P4-01 describes
-- ---------------------------------------------------------------------
do $$
declare
  n       integer;
  corps   text;
  config  text;
  owner_  text;
  definer boolean;
begin
  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'ai_usage_consume';

  if n <> 1 then
    raise exception
      '0004 annulée : % fonction(s) nommée(s) ai_usage_consume au lieu d''une seule. Aucune modification faite.', n;
  end if;

  select p.prosrc, p.proconfig::text, pg_get_userbyid(p.proowner), p.prosecdef
    into corps, config, owner_, definer
    from pg_proc p
   where p.oid = 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)'::regprocedure;

  if corps is null then
    raise exception
      '0004 annulée : ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz) est absente. Aucune modification faite.';
  end if;

  if not definer then
    raise exception
      '0004 annulée : ai_usage_consume n''est pas SECURITY DEFINER — état inattendu, la migration refuse de remplacer un objet qu''elle ne reconnaît pas. Aucune modification faite.';
  end if;

  if config is null or position('search_path=pg_catalog, public, pg_temp' in config) = 0 then
    raise exception
      '0004 annulée : search_path de ai_usage_consume non ancré (%). Aucune modification faite.',
      coalesce(config, 'NULL');
  end if;

  if owner_ in ('anon', 'authenticated', 'service_role') then
    raise exception
      '0004 annulée : ai_usage_consume appartient à un rôle d''API (%). Aucune modification faite.', owner_;
  end if;

  if position('on conflict on constraint' in lower(corps)) > 0 then
    raise exception
      '0004 annulée : ai_usage_consume porte déjà une cible de conflit nommée — correctif déjà appliqué, ou corps différent de celui de 0003. Aucune modification faite.';
  end if;

  if (select count(*) from regexp_matches(lower(corps), 'on conflict \(user_id, usage_day\)', 'g')) <> 1 then
    raise exception
      '0004 annulée : la cible défectueuse « on conflict (user_id, usage_day) » n''apparaît pas exactement une fois dans le corps actuel — ce n''est pas l''état laissé par 0003. Aucune modification faite.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 2. Guard — the constraint the new target names exists and is the right one
-- ---------------------------------------------------------------------
do $$
declare
  def    text;
  valide boolean;
  cols   text;
begin
  select pg_get_constraintdef(c.oid), c.convalidated,
         (select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum))
            from pg_attribute a
           where a.attrelid = c.conrelid and a.attnum = any (c.conkey))
    into def, valide, cols
    from pg_constraint c
    join pg_class     t  on t.oid  = c.conrelid
    join pg_namespace ns on ns.oid = t.relnamespace
   where ns.nspname = 'public'
     and t.relname  = 'ai_usage_daily'
     and c.contype  = 'p'
     and c.conname  = 'ai_usage_daily_pkey';

  if def is null then
    raise exception
      '0004 annulée : la contrainte ai_usage_daily_pkey est absente de public.ai_usage_daily — la cible nommée serait invalide. Aucune modification faite.';
  end if;

  if cols is distinct from 'user_id,usage_day' then
    raise exception
      '0004 annulée : ai_usage_daily_pkey porte sur « % » au lieu de (user_id, usage_day). Aucune modification faite.',
      coalesce(cols, 'inconnu');
  end if;

  if not valide then
    raise exception
      '0004 annulée : ai_usage_daily_pkey n''est pas validée. Aucune modification faite.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Capture the state that must NOT change
-- ---------------------------------------------------------------------
create temp table a4_avant on commit drop as
select p.proacl::text                as acl,
       p.proowner                    as owner,
       p.prosecdef                   as definer,
       p.proconfig::text             as config,
       pg_get_function_result(p.oid) as resultat
  from pg_proc p
 where p.oid = 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)'::regprocedure;

do $$
begin
  if not exists (select 1 from a4_avant) then
    raise exception '0004 annulée : état initial de ai_usage_consume illisible. Aucune modification faite.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 4. Probe — the new construct, exercised before anything is replaced
--
--    The probe reproduces the exact condition of P4-01: a variable named
--    `usage_day` is in scope while the statement names the conflict target.
--    It then checks that the NAMED target inserts, increments on conflict and
--    still honours the WHERE that carries the limit — the three properties the
--    quota upsert relies on.
--    Everything happens in a temporary table, dropped before the file ends.
-- ---------------------------------------------------------------------
do $$
declare
  usage_day   date := date '2026-01-01';
  v_msg       integer;
  v_reproduit boolean := false;
begin
  create temp table a4_probe (
    user_id   uuid    not null,
    usage_day date    not null,
    messages  integer not null default 0,
    constraint a4_probe_pkey primary key (user_id, usage_day)
  );

  -- (a) Witness: the form used by 0003 must be ambiguous in this context too.
  begin
    insert into a4_probe as u (user_id, usage_day, messages)
    values ('00000000-0000-4000-8000-000000000001'::uuid, usage_day, 1)
    on conflict (user_id, usage_day) do update
       set messages = u.messages + 1;
  exception
    when sqlstate '42702' then v_reproduit := true;
  end;

  -- (b) The corrected form: plain insert.
  insert into a4_probe as u (user_id, usage_day, messages)
  values ('00000000-0000-4000-8000-000000000002'::uuid, usage_day, 1)
  on conflict on constraint a4_probe_pkey do update
     set messages = u.messages + 1
   where u.messages < 10
  returning u.messages into v_msg;

  if v_msg is distinct from 1 then
    raise exception
      '0004 annulée : la cible de conflit nommée n''insère pas comme attendu (retour %). Aucune modification faite.',
      coalesce(v_msg::text, 'NULL');
  end if;

  -- (c) Same statement again: it must conflict and increment.
  insert into a4_probe as u (user_id, usage_day, messages)
  values ('00000000-0000-4000-8000-000000000002'::uuid, usage_day, 1)
  on conflict on constraint a4_probe_pkey do update
     set messages = u.messages + 1
   where u.messages < 10
  returning u.messages into v_msg;

  if v_msg is distinct from 2 then
    raise exception
      '0004 annulée : la cible de conflit nommée n''incrémente pas sur conflit (retour %). Aucune modification faite.',
      coalesce(v_msg::text, 'NULL');
  end if;

  -- (d) The WHERE carried by the named target must still refuse the last unit.
  insert into a4_probe as u (user_id, usage_day, messages)
  values ('00000000-0000-4000-8000-000000000002'::uuid, usage_day, 1)
  on conflict on constraint a4_probe_pkey do update
     set messages = u.messages + 1
   where u.messages < 2
  returning u.messages into v_msg;

  if v_msg is not null then
    raise exception
      '0004 annulée : la limite portée par le WHERE de la cible nommée n''est pas respectée (retour %). Aucune modification faite.', v_msg;
  end if;

  drop table a4_probe;

  if v_reproduit then
    raise notice '0004 sonde : la forme de 0003 est bien ambiguë (42702) dans ce contexte ; la cible nommée insère, incrémente et respecte la limite.';
  else
    raise notice '0004 sonde : cible nommée vérifiée (insertion, incrément, limite) ; le témoin d''ambiguïté ne s''est pas déclenché ici.';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 4 bis. The replacement — identical body, one line changed
-- ---------------------------------------------------------------------
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
    on conflict on constraint ai_usage_daily_pkey do update
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
-- 5. Post-checks — nothing but the body may have changed
-- ---------------------------------------------------------------------
do $$
declare
  acl_avant    text;
  owner_avant  oid;
  res_avant    text;
  acl_apres    text;
  owner_apres  oid;
  res_apres    text;
  config       text;
  corps        text;
  definer      boolean;
  n            integer;
  mauvais      integer;
begin
  select acl, owner, resultat into acl_avant, owner_avant, res_avant from a4_avant;

  select p.proacl::text, p.proowner, p.proconfig::text, p.prosrc, p.prosecdef,
         pg_get_function_result(p.oid)
    into acl_apres, owner_apres, config, corps, definer, res_apres
    from pg_proc p
   where p.oid = 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)'::regprocedure;

  if not definer then
    raise exception '0004 annulée : ai_usage_consume a perdu SECURITY DEFINER. Aucune modification faite.';
  end if;

  if config is null or position('search_path=pg_catalog, public, pg_temp' in config) = 0 then
    raise exception '0004 annulée : search_path non ancré après remplacement (%). Aucune modification faite.', coalesce(config, 'NULL');
  end if;

  if owner_apres is distinct from owner_avant then
    raise exception '0004 annulée : le propriétaire de ai_usage_consume a changé. Aucune modification faite.';
  end if;

  if acl_apres is distinct from acl_avant then
    raise exception
      '0004 annulée : l''ACL de ai_usage_consume a changé (avant « % », après « % »). Cette migration ne doit modifier aucun privilège. Aucune modification faite.',
      acl_avant, acl_apres;
  end if;

  if res_apres is distinct from res_avant then
    raise exception
      '0004 annulée : les colonnes retournées ont changé (« % » au lieu de « % »). Le contrat lu par server/usageStore.ts serait rompu. Aucune modification faite.',
      res_apres, res_avant;
  end if;

  if position('on conflict on constraint ai_usage_daily_pkey' in lower(corps)) = 0 then
    raise exception '0004 annulée : le nouveau corps ne porte pas la cible nommée attendue. Aucune modification faite.';
  end if;

  if position('on conflict (user_id, usage_day)' in lower(corps)) > 0 then
    raise exception '0004 annulée : la cible ambiguë subsiste dans le nouveau corps. Aucune modification faite.';
  end if;

  select count(*) into n
    from pg_proc p
    join pg_namespace ns on ns.oid = p.pronamespace
   where ns.nspname = 'public' and p.proname = 'ai_usage_consume';

  if n <> 1 then
    raise exception '0004 annulée : % fonction(s) nommée(s) ai_usage_consume après remplacement (surcharge créée ?). Aucune modification faite.', n;
  end if;

  select count(*) into mauvais
    from aclexplode((select proacl from pg_proc
                      where oid = 'public.ai_usage_consume(uuid,uuid,integer,integer,boolean,timestamptz)'::regprocedure)) x
   where x.grantee = 0 or pg_get_userbyid(x.grantee) in ('anon', 'authenticated');

  if mauvais > 0 then
    raise exception '0004 annulée : % entrée(s) d''ACL exécutable(s) par PUBLIC/anon/authenticated sur ai_usage_consume. Aucune modification faite.', mauvais;
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 6. Report (read-only)
-- ---------------------------------------------------------------------
do $$
begin
  raise notice
    '0004 appliquée : ai_usage_consume remplacée — une seule ligne changée (cible de conflit nommée ai_usage_daily_pkey), signature, colonnes retournées, SECURITY DEFINER, search_path, propriétaire et ACL inchangés.';
end
$$;

commit;
