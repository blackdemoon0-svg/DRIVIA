# Validation manuelle de Vocal Live — préparation (aucune modification effectuée)

**Date :** 2026-11-22 · **PR #14** (ouverte, non fusionnée) · Rien n'a été modifié :
ni variable, ni secret, ni donnée, ni configuration.

---

## 1. La variable d'environnement réellement lue

La route lit d'abord `VEYVRO_AI_API_KEY`, puis deux anciens noms en repli.

`api/voice-session.ts`, ligne 330 :

```ts
const apiKey = readEnvVar("VEYVRO_AI_API_KEY", "VEYDRIVO_AI_API_KEY", "DRIVIA_AI_API_KEY");
```

`readEnvVar` retourne la **première** valeur non vide, après `trim()`.

| Variable | Rôle | Statut |
| --- | --- | --- |
| **`VEYVRO_AI_API_KEY`** | Clé OpenAI (Live **et** chat texte) | **Celle à créer** |
| `VEYDRIVO_AI_API_KEY` | Ancien nom, repli | Ne pas définir |
| `DRIVIA_AI_API_KEY` | Ancien nom, repli | Ne pas définir |

Trois précisions qui comptent pour votre test :

1. **C'est la même variable que le chat texte.** `api/chat.ts` (ligne 565) lit
   exactement les mêmes noms. Si la Preview sait déjà discuter en texte, la clé
   existe déjà et il n'y a **rien à ajouter**.
2. **Facultatif** : `VEYVRO_AI_BASE_URL` (défaut `https://api.openai.com/v1`).
   À ne pas définir, sauf si vous passez par un proxy.
3. La voix nécessite aussi les trois variables Supabase déjà en place
   (`SUPABASE_URL`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`) :
   `api/voice-session.ts` appelle `authorizeRequest`, qui les exige.
   **Aucune variable nouvelle n'est introduite par la PR.**

---

## 2. Ajouter la variable à Preview uniquement

**Chemin exact dans le tableau de bord Vercel :**

```
Projet « drivia » → Settings → Environment Variables → Add New
```

Dans le formulaire :

| Champ | Valeur |
| --- | --- |
| Key | `VEYVRO_AI_API_KEY` |
| Value | votre clé OpenAI (projet ayant accès à GPT-Live) |
| Environments | **cocher `Preview` uniquement** — laisser `Production` et `Development` **décochés** |
| Sensitive | laisser activé si proposé |

Puis **Save**.

### Le piège à éviter absolument

Un déploiement Preview **existant ne verra pas** la variable : les variables
d'environnement sont figées au moment du build. Il faut **redéployer** après
l'ajout.

**Ne faites pas** « Promote to Production » ni un « Redeploy » du déploiement de
production. La bonne manière :

```
Deployments → choisir le déploiement de la branche arena/befab89c-drivia
           → menu « ⋯ » → Redeploy
           → décocher « Use existing Build Cache » n'est pas nécessaire
           → vérifier que la cible affichée est « Preview »
```

### Vérification que Production est intacte

```
Projet drivia → Settings → Environment Variables → VEYVRO_AI_API_KEY
```

La colonne des environnements doit afficher **`Preview` seul**. Si `Production`
apparaît, la variable a été créée au mauvais endroit : supprimez-la et
recommencez — ne la « décochez » pas, supprimez-la.

Après redéploiement, une vérification sans révéler la clé :

```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  "https://<url-preview>/api/voice-session" \
  -H "Content-Type: application/json" -d '{}'
```

`401` = la route répond et l'authentification passe avant tout appel
fournisseur. `503` avec `missing_api_key` = la clé n'est pas encore lue.
**Aucune clé n'apparaît dans cette réponse**, quelle que soit l'issue.

---

## 3. Le déploiement Preview correspond-il à `e000fb7` ?

**Non — il est plus récent, et c'est sans conséquence.** Voici l'état exact.

| Commit | Contenu | Déploiement Preview `drivia` |
| --- | --- | --- |
| `e000fb7` | Correctifs de la revue | ✅ déployé le 25/11 14:38 UTC |
| **`0ce7822`** | **Ce commit ne touche qu'un fichier `.md`** | ✅ déployé le 25/11 14:46 UTC — **c'est la Preview courante** |

`git diff --stat e000fb7..0ce7822` :

```
 docs/validation-vocale-reelle.md | 128 ++++++++++++++++++++++++++++++++
 1 file changed, 128 insertions(+)
```

Aucun fichier de code, aucune route, aucun composant. **Le code servi par la
Preview courante est identique, à l'octet, à celui de `e000fb7`** — le seul écart
est un document de procès-verbal qui n'est pas importé par l'application.

Le commit de tête de la branche est `0ce7822`. `e000fb7` n'est pas encore dans
`main` (`git merge-base --is-ancestor` → non), ce qui est normal : la PR est
ouverte.

---

## 4. URL exacte de la Preview

**Je ne peux pas la certifier, et je préfère vous le dire.**

Vercel renvoie la liste des déploiements via GitHub, mais **l'URL du déploiement
n'y figure pas** : le champ `payload` est vide (`{}`), `environment_url` et
`transient_environment_url` valent `null`. Le connecteur Vercel, seul à pouvoir
donner l'URL canonique, répond `Access denied`. `api.vercel.com` est injoignable
depuis mon environnement.

Deux façons fiables de l'obtenir, à la source :

- **Vercel** : `Projet drivia → Deployments → premier déploiement « Preview » de
  la branche arena/befab89c-drivia` → l'URL est sous le nom du déploiement
  (format `drivia-<hash>-<équipe>.vercel.app`).
- **GitHub** : onglet *Conversation* de la PR #14 → la section *Vercel Preview
  Comments* contient un lien vers la Preview courante.

**Ne confondez pas avec `drivia-web`** : son déploiement échoue systématiquement
(problème antérieur, hors périmètre) et il n'a **aucune** URL utilisable.
Seul le projet **`drivia`** vous intéresse.

### Un point de configuration à corriger avant de tester

Le projet Supabase **preview** a un `site_url` et un `uri_allow_list` qui
pointent vers `https://drivia-ncdrsj7oq-…vercel.app`, un déploiement **périmé**.

Conséquence : les liens de confirmation d'e-mail vous ramèneront sur ce vieux
déploiement, pas sur votre Preview actuelle. À corriger dans
`Supabase → vevro-preview → Authentication → URL Configuration`, en y mettant
l'URL de votre Preview courante. Sinon, utilisez un compte **déjà confirmé**
(voir §5) : le problème disparaît.

---

## 5. Tester avec un compte du projet Preview — sans toucher la Production

Les deux projets sont bien séparés :

| Projet Supabase | Réf. | Usage |
| --- | --- | --- |
| `veyvro-production` | `lzssvmpvqazhlrrmltct` | **À ne pas utiliser** |
| **`veyvro-preview`** | `jpxiextqorlsfmilctpc` | **Celui du test** |

La Preview `drivia` est branchée sur `veyvro-preview` par ses variables
d'environnement. **Le compte que vous créez sur la Preview va donc dans
`veyvro-preview`, jamais en Production.** C'est le point à vérifier au début du
test, et il se vérifie en une requête (voir §8).

Trois comptes existent déjà dans `veyvro-preview`, tous confirmés :

| Id | Avatar présent ? |
| --- | --- |
| `693ecd9b-93b5-4cc9-b654-731f9595e002` | Non |
| `3b728d9c-a390-4e8e-a909-5a9e07179ec2` | Non |
| `669c8e5a-f27b-4cca-9e98-685a6e90543c` | Non |

**Recommandation : créez un compte de test dédié** plutôt que de réutiliser un
compte réel. Un compte neuf évite deux pièges :

- **`mailer_autoconfirm` est à `false`** et **`rate_limit_email_sent` à `2`** :
  la confirmation par e-mail est obligatoire et limitée à deux envois par heure.
  Pour un test, le plus simple est d'activer temporairement l'auto-confirmation
  dans `Authentication → Providers → Email` du projet **preview**, ou de
  confirmer le compte par SQL :

```sql
UPDATE auth.users
SET email_confirmed_at = now()
WHERE email = '<votre-compte-test>@veyvro.test';
```

**Sans toucher à `veyvro-production`** : ces deux réglages et cette requête ne
concernent que le projet preview.

---

## 6. Vérifier que `avatar_url` survit au changement de voix

C'est le test le plus important de la série : il valide la correction n°6.

### Préparation — le compte doit avoir un avatar AVANT

Aucun compte preview n'a d'avatar aujourd'hui. Il faut donc en poser un, **via
l'application elle-même** (page Profil → photo), et non par SQL : c'est le chemin
que la vraie correction utilise.

Relevé de départ, à exécuter **avant** de changer de voix :

```sql
SELECT
  raw_user_meta_data->>'avatar_url'   AS avatar_url,
  raw_user_meta_data->>'avatar_path'  AS avatar_path,
  raw_user_meta_data->>'veyvro_voice' AS voice,
  (SELECT count(*) FROM jsonb_object_keys(raw_user_meta_data)) AS nb_cles
FROM auth.users
WHERE id = '<uuid du compte test>';
```

Notez `nb_cles` et l'`avatar_url`. Attendu à ce stade : `voice` à `null`.

### Le test

Dans la Preview : ouvrir le sélecteur de voix → choisir **Calandria** (voix
espagnole) ou `sillage`.

### Vérification — après

Re-exécutez la même requête.

**Verdict si la correction fonctionne :**

| Colonne | Attendu |
| --- | --- |
| `voice` | `calandria` (ou la voix choisie) |
| `avatar_url` | **identique à avant, non nul** |
| `avatar_path` | **identique à avant** |
| `nb_cles` | **+1 exactement** (la seule clé `veyvro_voice` a été ajoutée) |

**Verdict si le bug d'origine était revenu** (écriture par l'endpoint admin) :

| Colonne | Symptôme |
| --- | --- |
| `avatar_url` | `null` |
| `nb_cles` | retombé à **1** — l'objet entier a été remplacé |

### Pourquoi ce test est concluant

La correction n'utilise plus `PUT /auth/v1/admin/users/{id}`, qui **remplace**
`raw_user_meta_data`, mais `PUT /auth/v1/user` avec le jeton de l'utilisateur,
qui **fusionne**. La preuve est donc directement observable : si `nb_cles`
n'augmente que de 1, la fusion a eu lieu ; s'il retombe à 1, elle n'a pas eu lieu.

### Second point à vérifier dans le même test

Après le changement de voix, **rechargez la page** : la voix choisie doit
revenir. C'est la preuve que la préférence est bien lue depuis le compte, et non
depuis le cache local du navigateur.

---

## 7. Attribuer un accès Pro au compte de test, uniquement en Preview

Le vocal exige un plan Plus ou Pro. `Découverte` = 0 minute.

La façon **la moins invasive** est une ligne dans `public.subscriptions` du
projet preview. J'ai vérifié le schéma réel :

| Contrainte | Valeur |
| --- | --- |
| `plan` | `CHECK (plan IN ('plus','pro'))` |
| `status` | `CHECK (status IN ('active','trialing','past_due','paused','canceled'))` |
| `currency_code` | `NOT NULL`, défaut `'USD'`, **longueur 3** |
| `current_period_ends_at` | si les deux bornes sont fournies : `end > start` |
| `paddle_subscription_id` | `NOT NULL` **et UNIQUE** |
| `paddle_customer_id` | `NOT NULL` ; index unique partiel sur les statuts `trialing/active/past_due/paused` |
| `user_id` | FK vers `auth.users`, `ON DELETE CASCADE` |

La route ne lit que `user_id, plan, status, current_period_ends_at`
(`ACCESS_COLUMNS`). Les statuts qui ouvrent l'accès sont
`active`, `trialing`, `past_due`, `canceled` (`ENTITLED_STATUSES`).

### Requête d'attribution (5 minutes de test, plan Pro)

```sql
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

Deux détails qui évitent un échec :

- `paddle_subscription_id` est **UNIQUE** : utilisez une valeur unique (l'UUID du
  compte suffit). Une valeur déjà présente fera échouer l'insertion.
- `paddle_customer_id` est soumis à un **index unique partiel** sur les statuts
  actifs : ne réutilisez pas un `paddle_customer_id` existant.

Durée de 5 minutes, volontairement courte : le droit expire de lui-même, et il
ne reste rien à nettoyer. La réservation vocale est de 60 s par session ; 5
minutes suffisent largement pour la salutation et un changement de voix.

### Nettoyage, à faire dans tous les cas

```sql
DELETE FROM public.subscriptions
WHERE user_id = '<uuid du compte test>'
  AND paddle_subscription_id LIKE 'test-voice-preview-%';
```

### Pourquoi cela ne peut pas atteindre la Production

Ces requêtes s'exécutent sur `jpxiextqorlsfmilctpc` (`veyvro-preview`).
`veyvro-production` est `lzssvmpvqazhlrrmltct` : un autre projet, un autre
serveur, un autre mot de passe. Aucune instruction SQL ne traverse les deux.

### Une alternative sans SQL

Si vous préférez ne toucher à aucune table, l'accès Pro peut aussi être posé via
le flux Paddle en mode Sandbox — mais cela écrit les mêmes lignes et implique le
webhook. Pour un test de 5 minutes, l'insertion directe ci-dessus est plus simple
et plus sûre.

---

## 8. Vérifier, en une requête, que vous êtes sur le bon projet

À exécuter avant tout test, pour lever tout doute :

```sql
-- sur jpxiextqorlsfmilctpc (veyvro-preview)
SELECT current_database(), count(*) AS comptes
FROM auth.users;
```

`veyvro-preview` a **3 comptes** aujourd'hui. Si vous en voyez davantage,
vous êtes probablement sur la Production : arrêtez.

---

## Récapitulatif de la séquence

1. Vérifier si `VEYVRO_AI_API_KEY` existe déjà en Preview (le chat texte
   fonctionne-t-il sur la Preview ? si oui, la clé est là).
2. Sinon : `Projet drivia → Settings → Environment Variables → Add New`,
   environnement **Preview seul**, puis **redéployer la Preview**.
3. Ouvrir la Preview depuis `Deployments` (Vercel) ou depuis la PR #14.
4. Créer un compte de test sur la Preview (→ va dans `veyvro-preview`),
   le confirmer.
5. Poser un avatar via la page Profil, relever `nb_cles` (§6).
6. Attribuer Pro pour 5 minutes (§7).
7. Tester : salutation, micro, réception audio.
8. Choisir une voix espagnole, **relever `nb_cles` et `avatar_url`** (§6).
9. Changer de voix en cours de session, vérifier la conservation du contexte.
10. Terminer la session, puis vérifier le quota consommé et la fermeture.
11. Nettoyer : `DELETE` de la ligne d'abonnement de test.

**Point 8 = le test décisif.** Le reste est sensoriel et ne peut être jugé que
par vous : je ne peux pas entendre la salutation à votre place.

---

## Ce que je ferai de vos résultats

Donnez-moi les valeurs de la requête du §6 avant/après, et le comportement
observé aux points 7-10. Je pourrai :

- confirmer objectivement la correction de l'avatar (les chiffres suffisent) ;
- diagnostiquer une absence de salutation ou une erreur de session à partir du
  code d'erreur affiché (`voice_not_in_plan`, `voice_minutes_exhausted`,
  `voice_unavailable`, `invalid_api_key`, `provider_error`) ;
- corriger dans la PR #14 ce qui doit l'être, puis relancer les 94 tests.
