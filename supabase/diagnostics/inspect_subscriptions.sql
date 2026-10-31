-- =====================================================================
-- VEYVRO — READ-ONLY inspection of public.subscriptions
-- =====================================================================
-- Purpose: produce the exact current schema so the corrective migration can be
-- written against reality instead of assumptions.
--
-- This script contains ONLY `select` statements. It writes nothing, changes
-- nothing, and is safe to run in the Supabase SQL Editor.
--
-- Run it, then copy the output back. The corrective migration is gated on it.
-- =====================================================================

-- 1. Columns: name, type, nullability, default
select
  c.ordinal_position                as position,
  c.column_name,
  c.data_type,
  c.udt_name,                       -- distinguishes text from citext, enums, etc.
  c.is_nullable,
  c.column_default,
  c.character_maximum_length
from information_schema.columns c
where c.table_schema = 'public'
  and c.table_name   = 'subscriptions'
order by c.ordinal_position;

-- 2. Constraints: primary key, unique, foreign keys, checks
select
  con.conname                                   as constraint_name,
  con.contype                                   as kind,  -- p=PK, u=unique, f=FK, c=check
  pg_get_constraintdef(con.oid)                 as definition,
  con.convalidated                              as validated
from pg_constraint con
join pg_class     rel on rel.oid = con.conrelid
join pg_namespace nsp on nsp.oid = rel.relnamespace
where nsp.nspname = 'public'
  and rel.relname = 'subscriptions'
order by con.contype, con.conname;

-- 3. Indexes, including partial predicates and uniqueness
select
  i.indexname,
  i.indexdef
from pg_indexes i
where i.schemaname = 'public'
  and i.tablename  = 'subscriptions'
order by i.indexname;

-- 4. Row level security state and policies
select
  c.relname        as table_name,
  c.relrowsecurity as rls_enabled,
  c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public'
  and c.relname in ('subscriptions', 'webhook_events');

select
  p.policyname,
  p.permissive,
  p.roles,
  p.cmd,
  p.qual        as using_expression,
  p.with_check  as check_expression
from pg_policies p
where p.schemaname = 'public'
  and p.tablename  = 'subscriptions'
order by p.policyname;

-- 5. Grants actually in force (who can do what)
select
  grantee,
  privilege_type
from information_schema.role_table_grants
where table_schema = 'public'
  and table_name   = 'subscriptions'
order by grantee, privilege_type;

-- 6. Existing data: shape, not content
select
  count(*)                                                        as total_rows,
  count(distinct user_id)                                         as distinct_users,
  count(distinct paddle_customer_id)                              as distinct_paddle_customers,
  count(*) filter (where user_id is null)                         as rows_without_user_id,
  count(*) filter (where paddle_subscription_id is null)          as rows_without_subscription_id,
  min(occurred_at)                                                as oldest_event,
  max(occurred_at)                                                as newest_event
from public.subscriptions;

-- 7. Status distribution, to see which enum values are really used
select status, count(*)
from public.subscriptions
group by status
order by count(*) desc;

-- 8. Duplicates that would block a unique index
select paddle_customer_id, count(*) as occurrences
from public.subscriptions
where paddle_customer_id is not null
group by paddle_customer_id
having count(*) > 1;

select paddle_subscription_id, count(*) as occurrences
from public.subscriptions
where paddle_subscription_id is not null
group by paddle_subscription_id
having count(*) > 1;

-- 9. Does webhook_events exist yet?
select
  to_regclass('public.webhook_events') is not null as webhook_events_exists,
  to_regclass('public.subscriptions')  is not null as subscriptions_exists;

-- 10. Triggers on the table
select
  t.tgname                       as trigger_name,
  pg_get_triggerdef(t.oid)       as definition,
  t.tgenabled                    as enabled
from pg_trigger t
join pg_class rel on rel.oid = t.tgrelid
join pg_namespace n on n.oid = rel.relnamespace
where n.nspname = 'public'
  and rel.relname = 'subscriptions'
  and not t.tgisinternal
order by t.tgname;

-- 11. Sample of a single row (structure only: ids are Paddle public ids)
--     Uncomment if useful; it reveals no secret, only Paddle entity ids.
-- select * from public.subscriptions limit 1;
