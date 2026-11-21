-- =====================================================================
-- VEYVRO — 0003 : photos de profil (bucket Supabase Storage « avatars »)
-- =====================================================================
-- CONTEXTE
--   La photo de profil est stockée dans le bucket public `avatars`, dans un
--   dossier qui porte EXACTEMENT l'identifiant de l'utilisateur :
--
--       avatars/<auth.uid()>/avatar.webp
--
--   L'URL publique est ensuite enregistrée dans les métadonnées du compte
--   (user_metadata.avatar_url) par l'application, via auth.updateUser().
--   Aucune table applicative n'est créée : la source de vérité reste le compte
--   Supabase, donc la photo revient après connexion et rafraîchissement.
--
-- SÉCURITÉ
--   * lecture publique : les avatars sont affichés dans l'interface sans
--     signature d'URL (bucket public) ;
--   * écriture, modification et suppression réservées aux utilisateurs
--     authentifiés, et UNIQUEMENT dans leur propre dossier. Un utilisateur ne
--     peut donc jamais modifier la photo d'un autre ;
--   * limites imposées par le bucket : 5 Mo, JPG / PNG / WEBP uniquement.
--
-- IDEMPOTENT
--   Le script peut être exécuté plusieurs fois : le bucket est mis à jour s'il
--   existe déjà, et les politiques sont recréées dans la même transaction (aucun
--   intervalle pendant lequel la règle ne serait plus appliquée).
--
-- À EXÉCUTER MANUELLEMENT dans le SQL Editor du projet Supabase.
-- Non appliqué automatiquement par le déploiement.
-- =====================================================================

begin;

-- ---------------------------------------------------------------------
-- 1. Bucket `avatars` : public en lecture, 5 Mo, 3 formats acceptés
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880, -- 5 Mo
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
  set public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------------
-- 2. RLS sur storage.objects
-- ---------------------------------------------------------------------
-- Supabase l'active par défaut. Le bloc ne fait rien si c'est déjà le cas,
-- et évite un échec de privilège inutile si le rôle courant n'est pas
-- propriétaire de la table.
do $$
begin
  if not exists (
    select 1
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'storage'
      and c.relname = 'objects'
      and c.relrowsecurity
  ) then
    execute 'alter table storage.objects enable row level security';
  end if;
end
$$;

-- ---------------------------------------------------------------------
-- 3. Politiques du bucket
-- ---------------------------------------------------------------------
-- Lecture : tout le monde peut afficher un avatar public.
drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read"
  on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

-- Envoi : uniquement dans son propre dossier <uid>/.
drop policy if exists "avatars_insert_own" on storage.objects;
create policy "avatars_insert_own"
  on storage.objects
  for insert
  to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Remplacement : USING protège la ligne existante, WITH CHECK interdit de la
-- déplacer vers le dossier d'un autre utilisateur.
drop policy if exists "avatars_update_own" on storage.objects;
create policy "avatars_update_own"
  on storage.objects
  for update
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Suppression : uniquement ses propres fichiers.
drop policy if exists "avatars_delete_own" on storage.objects;
create policy "avatars_delete_own"
  on storage.objects
  for delete
  to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

commit;

-- =====================================================================
-- VÉRIFICATION (facultatif, à exécuter ensuite)
-- =====================================================================
-- select id, public, file_size_limit, allowed_mime_types
-- from storage.buckets where id = 'avatars';
--
-- select policyname, cmd, roles, qual, with_check
-- from pg_policies
-- where schemaname = 'storage' and tablename = 'objects'
--   and policyname like 'avatars_%'
-- order by policyname;
-- =====================================================================
