# Trois précisions avant le test manuel — et trois constats qui changent la lecture

**Date :** 2026-11-22 · **PR #14** ouverte, non fusionnée.
**Rien n'a été modifié** : aucun compte créé, aucune donnée touchée, aucun
secret lu, aucun déploiement lancé.

---

## 1. Le nom exact de la propriété : `veyvro_voice`

**Ce n'est pas `voice`.** C'est `veyvro_voice`, préfixé.

`api/voice-profiles.ts`, ligne 48 :

```ts
/** Metadata key, prefixed like the other application keys. */
export const VOICE_METADATA_KEY = "veyvro_voice";
```

L'écriture, ligne 102 :

```ts
body: JSON.stringify({ data: { [VOICE_METADATA_KEY]: voiceId } }),
```

La lecture, ligne 67, passe par la même constante — un seul point de vérité, donc
pas de risque de divergence entre écriture et lecture.

**Où exactement :** `auth.users → raw_user_meta_data → 'veyvro_voice'`. C'est un
objet JSON, d'où l'opérateur `->>` en SQL.

Au passage, la propriété `voice` que vous verrez dans des réponses d'API est une
**autre chose** : c'est un champ de la réponse HTTP (`{ voice: {...} }`), pas une
colonne Supabase. Ne cherchez pas de clé `voice` dans les métadonnées, elle
n'existera jamais.

**Deux clés d'avatar coexistent**, écrites par `src/lib/avatar.ts` :
`avatar_url` (l'URL affichable) et `avatar_path` (le chemin Storage). Les deux
doivent survivre au changement de voix — surveiller `avatar_url` seul laisserait
passer une régression partielle.

---

## 2. Requête de contrôle, lecture seule

### Avant le changement de voix

```sql
-- LECTURE SEULE — projet veyvro-preview (jpxiextqorlsfmilctpc)
SELECT
  u.id,
  u.email,
  u.raw_user_meta_data->>'avatar_url'  AS avatar_url,
  u.raw_user_meta_data->>'avatar_path' AS avatar_path,
  u.raw_user_meta_data->>'veyvro_voice' AS voix,
  (SELECT count(*) FROM jsonb_object_keys(u.raw_user_meta_data)) AS nb_cles,
  u.raw_user_meta_data->'veyvro_voice' IS NULL AS voix_absente
FROM auth.users u
WHERE u.email = '<votre-compte-test>@veyvro.test';
```

Notez **`nb_cles`** et `avatar_url` : ce sont les deux valeurs qui trancheront.

### Après le changement de voix

La même requête, à l'identique. Comparaison :

| Colonne | Correction OK | Régression |
| --- | --- | --- |
| `voix` | `sillage` ou `calandria` | `null` |
| `avatar_url` | **identique à l'avant** | `null` |
| `avatar_path` | **identique à l'avant** | `null` |
| `nb_cles` | **+1** | **retombé à 1** |

`nb_cles` qui retombe à 1 signifie que l'objet entier a été **remplacé** — la
signature exacte du bug d'origine (`PUT /auth/v1/admin/users/{id}`). S'il passe
de N à N+1, l'écriture a **fusionné** (`PUT /auth/v1/user` avec le jeton de
l'utilisateur). C'est pour cela que ce test est concluant sans instrumenter quoi
que ce soit.

### Variante si vous ne connaissez pas l'e-mail

```sql
SELECT id, email FROM auth.users ORDER BY created_at DESC LIMIT 5;
```

Il y a 3 comptes dans `veyvro-preview` aujourd'hui ; le vôtre sera le plus
récent.

### Vérification de la bonne base, en une ligne

```sql
SELECT current_database(), count(*) AS comptes FROM auth.users;
```

3 comptes = vous êtes sur `veyvro-preview`. Sinon, arrêtez : vous êtes
probablement sur la Production.

---

## 3. Attribution du plan Pro — requête et nettoyage

**Non exécutées.** Le schéma a été vérifié sur `veyvro-preview` (contraintes,
index et colonnes `NOT NULL` lus dans `information_schema` et `pg_constraint`).

### Attribution (5 minutes)

```sql
-- ÉCRITURE — projet veyvro-preview UNIQUEMENT (jpxiextqorlsfmilctpc)
INSERT INTO public.subscriptions (
  user_id, plan, status, currency_code,
  paddle_subscription_id, paddle_customer_id,
  current_period_started_at, current_period_ends_at
) VALUES (
  '<uuid du compte test>',
  'pro',
  'active',
  'USD',
  'test-voice-preview-<uuid>',
  'test-customer-preview-<uuid>',
  now(),
  now() + interval '5 minutes'
);
```

### Nettoyage

```sql
-- ÉCRITURE — même projet
DELETE FROM public.subscriptions
WHERE paddle_subscription_id LIKE 'test-voice-preview-%';
```

### Pourquoi ces valeurs, précisément

J'ai lu les contraintes réelles plutôt que de les supposer :

| Contrainte vérifiée | Conséquence sur la requête |
| --- | --- |
| `plan IN ('plus','pro')` | `'pro'` est valide |
| `status IN ('active','trialing','past_due','paused','canceled')` | `'active'` est valide |
| `char_length(currency_code) = 3` | `'USD'` — pas `'usd'` en un autre format, pas `'EUR '` |
| `current_period_ends_at > current_period_started_at` si les deux sont fournies | `now()` → `now() + 5 min` respecte l'ordre |
| `paddle_subscription_id` **NOT NULL et UNIQUE** | valeur unique obligatoire, d'où votre UUID dedans |
| index unique partiel sur `paddle_customer_id` (statuts actifs) | ne pas réutiliser un `paddle_customer_id` existant |
| `user_id` FK → `auth.users` `ON DELETE CASCADE` | l'UUID doit exister |

**Pourquoi la date de fin compte :** `toGrant()` (`src/lib/subscriptionAccess.ts`,
ligne 131) refuse toute ligne dont `current_period_ends_at` est absent, illisible
ou **déjà passé**. Sans cette colonne, l'accès Pro n'est pas accordé — la ligne
existerait sans effet. C'est le piège le plus probable de cette étape.

**Pourquoi 5 minutes suffisent :** la durée n'a pas besoin de couvrir la
conversation. Elle doit couvrir le moment où la session vocale **demande** ses
droits. Ensuite le quota est réservé et la session vit sa vie. 5 minutes laissent
une marge confortable pour la salutation et un changement de voix, et le droit
expire seul.

**Effet de bord accepté :** cette ligne apparaît dans l'interface comme un
véritable abonnement Pro, avec `paddle_subscription_id` factice. C'est
précisément pour cela qu'elle porte un préfixe `test-voice-preview-` : il rend le
nettoyage non ambigu et évite de supprimer une vraie ligne par erreur.

### Isolation de la Production

Ces requêtes s'exécutent sur `jpxiextqorlsfmilctpc`. La Production est
`lzssvmpvqazhlrrmltct` : autre projet, autre serveur, autre jeu de clés. Aucune
instruction SQL ne traverse les deux, et le `DELETE` de nettoyage filtre sur le
préfixe de test — il ne pourrait pas emporter un abonnement réel même lancé par
erreur sur la mauvaise base.

⚠️ **Vérifiez deux fois l'identifiant du projet avant d'exécuter.** C'est le seul
garde-fou qui dépend de vous.

---

## 4. L'URL de la Preview — trouvée

```
https://drivia-git-arena-befab89c-drivia-blackdemoon0-2303s-projects.vercel.app
```

**Comment je l'ai obtenue**, sans le connecteur Vercel (qui refuse : jeton
invalide) et sans accès réseau à Vercel : le bot Vercel publie dans la PR #14 un
commentaire contenant une charge utile signée. Celle-ci nomme, pour chaque
projet, `previewUrl`. Lu et décodé depuis `api.github.com`.

**Ce que cela garantit et ce que cela ne garantit pas :**

| Point | État |
| --- | --- |
| Le projet est `drivia` (pas `drivia-web`) | ✅ explicite dans la charge utile |
| C'est bien la branche `arena/befab89c-drivia` | ✅ l'alias contient le nom de branche |
| Le déploiement est réussi | ✅ `nextCommitStatus: DEPLOYED` |
| Le commit servi est le dernier de la branche | ⚠️ **déduit, non prouvé** |

La dernière ligne est le point d'honnêteté. Un alias `-git-<branche>-` suit le
dernier déploiement réussi de la branche. Or le dernier commit poussé,
`739fa74`, a bien un déploiement `drivia` en état `success`
(déploiement `8060912957`, 14:49 UTC) — et ce commit ne touche que des fichiers
`.md`. **Le code servi est donc celui de `e000fb7`**, quel que soit le commit
exact affiché.

Pour lever le doute en trois secondes : ouvrez l'URL, puis vérifiez dans l'onglet
*Conversation* de la PR #14 que le lien « Preview » du commentaire Vercel pointe
vers la même adresse.

---

## 5. Trois constats qui changent la lecture de vos tests

Ils sont dans le code livré, pas dans la documentation. Je les signale
maintenant parce qu'ils vont se manifester pendant vos tests, et qu'il vaut
mieux savoir à l'avance ce qu'ils signifient.

### a) Le changement de voix en cours de session **redémarre** la session

`src/lib/useVoiceLive.js`, `restartWithVoice()` : la connexion WebRTC est
démontée (`cleanupPeer()`), puis une **nouvelle** session est ouverte avec la
nouvelle voix. Ce n'est pas un `session.update` à chaud — c'est une session
neuve.

**Conséquence pour votre test n°4 (contexte conservé) :** le contexte ne survit
que par ce que le client transmet dans `history`. Or `history` vient de
`chat.messages` (`src/App.jsx` ligne 36), c'est-à-dire la **conversation texte**.
Le transcript vocal (`transcript` de `useVoiceLive`) **n'est pas** réinjecté dans
`chat.messages` — je n'ai trouvé aucun consommateur.

Donc, tel que je lis le code : **le contexte d'une conversation vocale ne
survivra pas à un changement de voix**, sauf si les mêmes échanges existent aussi
dans le fil texte. À vérifier sur pièce, mais attendez-vous à ce que l'assistant
perde le fil.

Ce n'est pas forcément un défaut : la session redémarre, elle n'a aucune raison
de deviner ce qui a été dit avant. Mais si votre critère est « le contexte doit
être conservé », **alors ce test échouera**, et ce sera un vrai résultat, à
corriger en PR #14 si vous le voulez.

### b) Le quota vocal est un compteur **en mémoire**, par instance

`server/quotas.ts`, ligne 51 : `const counters = new Map<string, AccountCounters>()`.
Le fichier le dit lui-même : ce sont des « soft limits, per instance », pas un
compteur durable, et **pas** un compteur de facturation.

**Conséquence pour votre test n°6 (consommation réelle du quota) :** ce que vous
verrez est un **refus après épuisement**, pas une consommation mesurée en minutes.
Et un cold start remet le compteur à zéro. Concrètement, le test observable est :
une 2ᵉ session immédiate doit être refusée en `429` avec
`voice_minutes_exhausted` (Forfait = 10 min/jour, Pro = 30 min/jour, réservation
de 60 s par session). Le test « le quota est-il durablement décompté » ne peut pas
réussir : le mécanisme n'existe pas encore, et le code l'assume explicitement.

### c) Une voix par défaut peut masquer un échec d'enregistrement

`DEFAULT_VOICE_ID = "brise"` (`server/ai/voiceCatalog.ts` ligne 126). Et
`useVoicePreference` retombe sur `'brise'` si le cache local est vide.

**Conséquence :** si vous choisissez une voix et que l'écriture échoue, l'interface
affiche un avertissement (`VoiceLiveButton.jsx` ligne 58) mais **conserve le choix
localement**. Après un rechargement, `brise` revient — et si vous n'y prenez pas
garde, cela ressemble à « la voix n'a pas été enregistrée », alors que c'est
simplement le défaut. **La requête SQL est le seul juge fiable ici**, pas
l'apparence de l'interface.

### Point rassurant, en revanche

La correction de l'avatar est solide. `api/voice-profiles.ts` ligne 102 n'envoie
que `{ data: { veyvro_voice: ... } }` vers `PUT /auth/v1/user` — Supabase
**fusionne** cet objet dans `raw_user_meta_data`. Il n'y a plus aucun appel à
`PUT /auth/v1/admin/users/{id}`, qui remplaçait l'objet entier. C'est la cause
racine du bug d'origine, et elle a disparu du code.

---

## Ce que j'attends de vous

Les valeurs de la requête du §2 **avant** et **après**, et le code d'erreur
affiché le cas échéant. Les codes possibles, lus dans `api/voice-session.ts` :

| Code | Signification |
| --- | --- |
| `voice_not_in_plan` | plan lu en base = Découverte (la ligne Pro manque ou a expiré) |
| `voice_minutes_exhausted` | quota quotidien épuisé (compteur mémoire) |
| `invalid_api_key` | clé OpenAI absente ou refusée |
| `insufficient_quota` | crédit OpenAI épuisé |
| `rate_limited` | limite de débit fournisseur |
| `voice_unavailable` | modèle ou voix non autorisés sur la clé |
| `provider_error` / `timeout` | incident côté fournisseur |
| `identity_unavailable` | Supabase injoignable |
| `invalid_offer` / `invalid_session` | problème WebRTC/SDP côté navigateur |

Une fois vos résultats en main, je corrige ce qui doit l'être **dans la PR #14**,
puis je relance les 94 tests. Je ne fusionne rien, je ne déploie rien en
Production.
