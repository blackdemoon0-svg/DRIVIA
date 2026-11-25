# Procès-verbal de validation réelle — Vocal Live (PR #14)

**Date :** 2026-11-22 · **Branche :** `arena/befab89c-drivia` @ `e000fb7` · **PR :** #14 (ouverte, non fusionnée)

## Résumé en une ligne

**Aucun test réel n'a pu être exécuté.** Trois verrous indépendants, tous hors de
mon contrôle, bloquent chaque étape de la demande. Rien n'est déclaré réussi.

---

## Ce qui bloque, précisément

| # | Verrou | Constat factuel | Conséquence |
| --- | --- | --- | --- |
| 1 | **Aucune clé OpenAI** | `VEYVRO_AI_API_KEY`, `VEYDRIVO_AI_API_KEY`, `DRIVIA_AI_API_KEY`, `OPENAI_API_KEY` : toutes absentes de l'environnement. Aucun `.env`/`.env.local` (seul `.env.example` existe). | Impossible de créer une session GPT-Live : `POST /v1/live/sessions` exige la clé. |
| 2 | **Réseau sortant bloqué** | `api.openai.com`, `api.vercel.com`, `<projet>.supabase.co` : tous en `SSL_ERROR_SYSCALL` / `000`. Seul `api.github.com` répond (`200`). | Aucun appel HTTP réel possible vers OpenAI, Vercel ou Supabase depuis l'exécution. |
| 3 | **Connecteur Vercel refusé** | `list_projects`, `list_env_vars`, `get_authenticated_user` → `Access denied` (token sans la permission ou mauvais scope d'équipe). | Impossible de lire les variables du projet `drivia`, les logs de build, ni de poser une variable d'environnement sur la Preview. |

Les trois ensemble signifient : je ne peux ni appeler OpenAI, ni configurer la
clé sur Vercel, ni joindre la Preview `drivia` depuis ici.

## Ce qui a quand même pu être vérifié (faits, pas suppositions)

Le connecteur **Supabase** fonctionne. J'ai donc pu inspecter l'état réel qui
conditionne le test n° 5.

| Constat | Détail |
| --- | --- |
| Deux projets distincts | `veyvro-production` (`lzssvmpvqazhlrrmltct`) et **`veyvro-preview`** (`jpxiextqorlsfmilctpc`) — le test peut se faire sans toucher la Production. |
| Comptes existants | 3 comptes par projet. |
| **Un compte porte déjà un avatar** | En **production** : `bf91e9c7-…` a `avatar_url` dans `raw_user_meta_data` (7 clés de métadonnées). En **preview** : aucun avatar sur les 3 comptes. |
| Aucune préférence de voix | `veyvro_voice` est `null` partout : la fonctionnalité n'a jamais tourné. |
| Colonnes `subscriptions` | Vérifiées, compatibles avec `server/access.ts`. |

**Conséquence importante pour votre test n° 5** : le seul compte portant un
avatar est **en Production**. Le tester là-bas exigerait de toucher la
Production, ce que vous m'avez interdit. J'ai donc préparé le test côté
**preview**, sur un compte jetable.

## Préparation effectuée, puis annulée

J'ai créé un compte de test dans `veyvro-preview`
(`validation-vocale-2026-11@veyvro.test`, id `7f3a1c2d-…`) pour porter un faux
avatar et exécuter le test n° 5. Le réseau étant bloqué, je n'ai pas pu
l'exercer. **Je l'ai supprimé** : `veyvro-preview` est revenu à ses 3 comptes
d'origine. Aucun état résiduel.

## La preuve qui manque, et comment l'obtenir

Le cœur du test n° 5 est vérifiable en **une seule requête SQL non destructive**,
à exécuter juste après qu'un utilisateur a changé de voix. Elle lit l'objet de
métadonnées **en entier** :

```sql
SELECT
  raw_user_meta_data->>'avatar_url'  AS avatar_url,
  raw_user_meta_data->>'avatar_path' AS avatar_path,
  raw_user_meta_data->>'veyvro_voice' AS voice,
  (SELECT count(*) FROM jsonb_object_keys(raw_user_meta_data)) AS nombre_de_cles
FROM auth.users
WHERE id = '<uuid du compte testé>';
```

**Verdict attendu si la correction fonctionne :** `voice` renseigné (`calandria`,
`sillage`…), `avatar_url` et `avatar_path` **toujours présents**, et
`nombre_de_cles` augmenté de 1 seulement.

**Verdict si le bug d'origine était revenu :** `avatar_url` à `null` et
`nombre_de_cles` revenu à 1 — l'endpoint admin aurait remplacé tout l'objet.

C'est cette requête que je ne peux pas exécuter à votre place, faute de pouvoir
faire tourner l'application qui écrit la préférence.

---

## Résultat des 7 tests demandés

| # | Test | Résultat | Motif |
| --- | --- | --- | --- |
| 1 | Clé OpenAI Live côté serveur | **NON EXÉCUTÉ** | Aucune clé disponible ; Vercel inaccessible pour en poser une. |
| 2 | WebRTC, microphone, salutation, audio | **NON EXÉCUTÉ** | Aucun chromium/WebRTC dans le bac à sable et aucune session Live joignable. |
| 3 | Voix espagnoles, changement de voix | **NON EXÉCUTÉ** | Dépend du test 2. |
| 4 | Contexte conservé après changement de voix | **NON EXÉCUTÉ** | Dépend du test 2. |
| 5 | Voix enregistrée, avatar intact | **NON EXÉCUTÉ** — requête de vérification fournie ci-dessus | Réseau Supabase bloqué depuis l'exécution ; seul le connecteur (côté plateforme) répond. |
| 6 | Quotas réels, fermeture de session | **NON EXÉCUTÉ** — couvert par 94 tests simulés dans `scripts/voice.test.mjs` | La consommation réelle exige une vraie session facturée. |
| 7 | Aucun secret révélé | **RESPECTÉ** | Aucune clé lue, affichée ni journalisée. Un secret Supabase a été tronqué par le connecteur lui-même et n'a jamais été recopié dans un fichier ou un rapport. |

## Deux défauts de configuration repérés au passage

Ils ne viennent pas de la PR, mais ils bloqueront votre test manuel :

1. **`site_url` et `uri_allow_list` du projet preview pointent vers un
   déploiement périmé** : `https://drivia-ncdrsj7oq-…vercel.app`. Les liens de
   confirmation d'e-mail y mènent, pas vers la Preview courante.
2. **`mailer_autoconfirm: false`** et **`rate_limit_email_sent: 2`** : créer un
   compte de test demande une confirmation par e-mail, limitée à 2 envois. Pour
   un test manuel, le plus simple est d'utiliser un compte existant du projet
   preview et de lui poser un plan `pro`, ou d'activer temporairement
   l'auto-confirmation.

---

## Ce qu'il me faudrait pour exécuter réellement ces tests

Par ordre de simplicité :

**Option A — vous faites tourner le scénario, je vérifie les preuves.** Vous
ouvrez la Preview `drivia`, activez le micro, parlez, changez de voix. Je lis
ensuite l'état Supabase via le connecteur (qui fonctionne) et je vous rends le
verdict objectif pour les tests 5 et 6. Les tests 2, 3 et 4 restent des
observations sensorielles que seul un humain devant l'écran peut valider.

**Option B — autoriser le réseau.** Si l'exécution pouvait joindre
`api.openai.com` et `<projet>.supabase.co`, et si une clé OpenAI m'était fournie
par un canal sûr (jamais dans le chat), je pourrais exercer les routes réelles et
les tests 6 et une partie des 2-4 en script.

**Option C — réparer le connecteur Vercel** (scope d'équipe / permission), ce qui
me rendrait au moins les logs de build et l'état du projet `drivia`.

Je n'ai pas besoin des trois : l'option A seule me permettrait de rendre un
verdict vérifiable sur les tests 5 et 6, qui sont les deux plus risqués.

## État de la PR

Inchangée par cette session : `e000fb7`, 23 fichiers, aucun nouveau commit. Rien
fusionné, rien déployé en Production, PR 2 non commencée.
