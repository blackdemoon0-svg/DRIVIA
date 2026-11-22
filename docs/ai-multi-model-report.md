# VEYVRO — Intelligence multi-modèles : audit, architecture et rapport

**Branche** : `arena/36930572-drivia` (depuis `main` @ `7721447`)
**Date** : 2026-11-22
**Périmètre** : `api/chat.ts`, nouveau dossier `server/ai/`, tests, documentation.
**Non modifié** : paiements, abonnements, quotas, authentification, frontend, `vercel.json`.

---

## 1. Audit de l'existant

### Ce qui fonctionnait déjà bien

| Point | État initial | Verdict |
| --- | --- | --- |
| Clé API | uniquement côté serveur, jamais renvoyée | **conservé tel quel** |
| Authentification | Supabase `/auth/v1/user`, fail-closed | **non touché** |
| Plan / quotas | lus en base, appliqués avant l'appel IA | **non touché** |
| Streaming | SSE `event: delta` → `event: done`, drain géré | **contrat conservé** |
| Erreurs | classification stable (`invalid_api_key`, `insufficient_quota`, `model_unavailable`, `rate_limited`…) | **conservée, déplacée et étendue** |
| Attachements | validation stricte taille/type, contenu traité comme donnée | **conservé** |
| Prompt système | `server/veyvroSystemPrompt.ts`, persona soignée | **inchangé** |
| Limitation de débit | par IP + par compte + concurrence | **conservée** |

### Faiblesses identifiées

1. **Un seul modèle pour tout.** `VEYVRO_AI_MODEL` ou `gpt-4.1-mini` répondait aussi bien à « c'est quoi un turbo ? » qu'à un diagnostic de chaîne de distribution à 2 800 €. Coût et qualité n'étaient pas pilotés.
2. **Modèle par défaut obsolète.** `gpt-4.1-mini` est **déprécié par OpenAI** (arrêt annoncé au 2027-01-14), tout comme `gpt-4.1`, `gpt-4o`, `gpt-4o-mini`. Le défaut allait donc cesser de fonctionner prochainement.
3. **Aucun secours.** Un `model_not_found` ou une indisponibilité ponctuelle du modèle unique faisait échouer le tour, alors qu'un autre modèle aurait répondu.
4. **Aucune vérification.** Une réponse affirmant un couple de serrage ou une génération moteur fausse partait telle quelle, sans second regard — sur des sujets où l'erreur coûte cher (sécurité, argent).
5. **Budget de sortie forfaitaire** (1400/2400 tokens), identique pour une salutation et pour une analyse de devis.
6. **Délai fixe de 45 s** décidé localement, sans lien avec la limite réelle de la fonction (60 s) ni avec la durée restante des étapes internes.
7. **Aucune traçabilité du coût.** Impossible de répondre à « combien a coûté ce tour ? ».
8. **Pas de tests du chemin IA.** `scripts/ai-smoke-test.mjs` fait de vrais appels payants ; rien ne testait la construction des requêtes, la classification d'erreurs, ni le streaming de façon déterministe.

---

## 2. Architecture livrée

```
api/chat.ts                 orchestration HTTP : auth → permissions → quotas → routage → SSE
server/ai/modelCatalog.ts   catalogue vérifié (ids, prix, profils) + mémoire de disponibilité
server/ai/router.ts         décision pure : mode, modèle, effort, tokens, budget, vérification
server/ai/provider.ts       transport : corps de requête par profil, SSE, erreurs, retries, repli
server/ai/orchestrator.ts   exécution : mono-modèle, collaboration, synthèse, vérification
server/ai/prompts.ts        consignes internes (rédaction, synthèse, contrôle)
server/ai/budget.ts         plafond de dépense journalier par instance (frein, pas facturation)
```

### Modèles réellement utilisés (vérifiés le 2026-11-22)

Identifiants lus dans la documentation officielle — `developers.openai.com/api/docs/models`, pages `gpt-6-luna`, `gpt-6.1-terra`, `gpt-6.2-sol`, `gpt-6.2-astra`, plus la page `deprecations` et la page `pricing`. **Aucun identifiant inventé.** Les quatre acceptent `v1/chat/completions`, le streaming, et l'entrée texte + image.

| Rôle | Modèle | $/M entrée | $/M sortie | Effort par défaut |
| --- | --- | --- | --- | --- |
| rapide | `gpt-6-luna` | 0,10 | 0,50 | low |
| équilibré | `gpt-6.1-terra` | 1 | 5 | low/medium |
| code / document | `gpt-6.2-sol` | 2 | 10 | medium |
| raisonnement | `gpt-6.2-astra` | 8 | 40 | high |
| coordinateur | `gpt-6.2-sol` | 2 | 10 | medium |

Points de vigilance encodés dans le catalogue, tirés de la doc : `gpt-6.2-astra` et `gpt-6.2-sol` **rejettent `reasoning_effort: "none"`** (HTTP 400) ; les modèles de raisonnement n'acceptent pas `temperature`. Ces deux règles ont leur test dédié.

### Routage

| Demande | Mode | Modèles appelés |
| --- | --- | --- |
| « C'est quoi un turbo ? » | `fast` | `gpt-6-luna` |
| Comparaison / conseil d'achat | `balanced` | `gpt-6.1-terra` |
| Code, CAN/OBD, calcul | `coding` | `gpt-6.2-sol` |
| Devis de garage (document) | `coding` + vérification | `gpt-6.2-sol` puis `gpt-6.1-terra` |
| Symptôme de sécurité, diagnostic multi-questions | `reasoning` + vérification | `gpt-6.2-astra` puis `gpt-6.1-terra` |
| Demande réellement difficile, plan Plus/Pro | `collaborative` | `gpt-6.2-astra` + `gpt-6.2-sol` en parallèle → `gpt-6.2-sol` synthétise → `gpt-6.1-terra` vérifie |

Principes de décision :

- **le coût se mérite.** Les signaux (longueur, comparaison, sécurité, code, multi-questions, document) doivent s'accumuler ; une salutation reste une salutation, même en Pro ;
- **la collaboration est réservée** aux plans payants et aux demandes difficiles. La Découverte ne peut jamais la déclencher ;
- **le client ne choisit pas le modèle** : un indice `depth: "fast" | "balanced" | "deep"` est facultatif, borné par la politique serveur et le plafond de la formule ;
- **`VEYVRO_AI_MODEL` reste prioritaire** s'il est défini : aucune régression de configuration pour un déploiement existant.

### Collaboration : comment l'utilisateur ne voit qu'une réponse

1. Deux modèles rédigent un brouillon **en parallèle** (jamais streamé) ;
2. le coordinateur fusionne les brouillons et **streame** la réponse unique ;
3. le vérificateur relit la réponse et, s'il trouve une erreur matérielle, une courte section « Points de vigilance » est ajoutée ;
4. si les deux brouillons échouent, le tour dégrade vers un modèle unique fort au lieu d'échouer.

La progression interne circule sur `event: stage` — un canal séparé que les clients actuels ignorent. Le contrat `delta`/`done` est inchangé.

### Coûts

- plafond par requête : **0,03 $ (Découverte) / 0,12 $ (Plus) / 0,30 $ (Pro)**, vérifié *avant* l'appel ; au-delà, le plan est dégradé par étapes (collaboration → vérification → modèle → sortie) et la dégradation est tracée (`downgraded: true`, raison lisible) ;
- plafond journalier par instance : `VEYVRO_AI_DAILY_BUDGET_USD` (défaut 20 $) ; l'atteindre **désactive les modes coûteux**, ne bloque jamais un message ;
- coût réel mesuré à partir de l'`usage` renvoyé par le fournisseur (`stream_options.include_usage`), puis journalisé en JSON dans les logs Vercel — sans clé, sans prompt, sans contenu utilisateur.

### Robustesse

- **repli** : chaîne classée par coût décroissant, filtrée par capacité vision quand une image est jointe → un repli ne coûte jamais plus cher et ne casse jamais la lecture d'un document ;
- **mémoire de refus** : un modèle refusé (`model_not_found`, pas d'accès) est mis de côté 15 min dans l'instance, donc l'échec n'est payé qu'une fois ;
- **pas de repli inutile** : clé invalide, quota épuisé → arrêt immédiat (aucun autre modèle ne ferait mieux) ;
- **retry** borné (2 tentatives) sur 429 et 5xx uniquement ;
- **jamais de doublon** : dès le premier fragment publié, plus aucune reprise — une interruption est signalée, pas rejouée ;
- **échéance unique** : `VEYVRO_AI_REQUEST_DEADLINE_MS` (54 s par défaut, borné 5–54 s) ; chaque étape dérive son budget du temps restant.

### Sécurité

- clé API utilisée uniquement dans l'en-tête serveur, **jamais recopiée dans un message d'erreur** (test dédié) ;
- messages bruts du fournisseur non relayés ;
- ids de modèles renvoyés au navigateur remplacés par un simple **décompte** (`routing.models`) ;
- prompt système, historique, quotas, plans et authentification inchangés.

---

## 3. Tests

### Nouvelles suites (déterministes, sans réseau, sans coût)

| Suite | Vérifications | Couverture |
| --- | --- | --- |
| `npm run test:ai-routing` | 24 | catalogue réel, profils de paramètres, signaux, choix de modèle par type de question, collaboration réservée, plafonds par formule, chaîne de secours, mémoire de refus, garde-fou de dépense, déterminisme |
| `npm run test:ai-provider` | 12 | corps de requête par profil, classification des erreurs, parsing SSE, retry 429 vs échec immédiat, repli et mémorisation, contrainte vision, timeout, pas de reprise après publication, non-fuite de la clé |
| `npm run test:ai-pipeline` | 16 | handler réel + Supabase/OpenAI simulés : question simple, contrat SSE, contexte conversationnel, collaboration complète (brouillons → synthèse → vérification → correction), échec de modèle et repli, clé invalide, quota épuisé, réponse vide, réponse tronquée, timeout, pièce jointe multimodale, budget, modèle épinglé, fournisseur non-OpenAI, non-fuite de secrets, garde-fous existants |

Couverture explicite des exigences : questions simples, raisonnement complexe, programmation, collaboration, échec de modèle, modèle de secours, streaming, gestion des coûts, contexte conversationnel.

### Résultats

```
typecheck ................ OK
build (vite) ............. OK
check:seo ................ 24/24
test:ai-routing .......... 24 vérifications
test:ai-provider ......... 12 vérifications
test:ai-pipeline ......... 16 vérifications
test:chat-access ......... 20 vérifications (inchangé, vert)
test:quotas .............. 16 vérifications (inchangé, vert)
```

### Échecs préexistants sur `main` (hors périmètre, non causés par cette branche)

Vérifiés en stashant les modifications : ces tests échouent déjà sur `main`, parce qu'ils importent des fichiers qui n'existent pas dans le dépôt (`src/components/PricingView.tsx`, `src/lib/auth.ts`, `src/lib/paddleCheckout.ts`, etc.), plus une assertion `'decouverte' == 'pro'` dans `access.test.mjs`.

`test:paddle`, `test:activation`, `test:entitlement`, `test:auth`, `test:access`, `test:plan-change`, `test:purchase-guard`, `test:schema` — **8 suites**. Ils concernent le frontend Paddle / l'authentification, pas l'IA. Ils n'ont pas été touchés.

### Vérification réelle des modèles

```sh
VEYVRO_AI_API_KEY=... npm run ai:models
```

Interroge `GET /v1/models` (gratuit) et compare au catalogue : c'est la seule réponse qui vaille pour un compte donné. Sortie en code 1 si un modèle du catalogue n'est pas accessible, pour servir de pré-vol.

---

## 4. Configuration

Nouvelles variables (facultatives, toutes documentées dans `.env.example` et le README) :

| Variable | Défaut | Effet |
| --- | --- | --- |
| `VEYVRO_AI_MODEL` | *vide* | **épingle** un modèle et désactive le choix automatique |
| `VEYVRO_AI_ROUTING` | `auto` | `auto` \| `single` \| `collaborative` |
| `VEYVRO_AI_DAILY_BUDGET_USD` | `20` | frein journalier par instance sur les modes coûteux |
| `VEYVRO_AI_REQUEST_DEADLINE_MS` | `54000` | budget de temps d'une requête (borné 5–54 s) |

Pour adopter le multi-modèles : **retirer** `VEYVRO_AI_MODEL` de l'environnement, garder `VEYVRO_AI_API_KEY`. Pour revenir au comportement précédent : `VEYVRO_AI_MODEL=gpt-4.1-mini` (déprécié) ou `VEYVRO_AI_ROUTING=single` avec un modèle du nouveau catalogue.

---

## 5. Limites, dites franchement

- **Aucun appel réel n'a été fait** : la clé OpenAI n'est pas disponible dans cet environnement. Le transport, le streaming, les erreurs et le repli sont testés avec un `fetch` simulé ; la première validation en conditions réelles reste `npm run ai:models` (quels modèles la clé peut appeler) puis `node scripts/ai-smoke-test.mjs` (vraies réponses) avec une clé de préversion.
- **Les plafonds sont par instance**, comme les quotas existants : ils se réinitialisent à froid. C'est un frein contre les boucles et les dérives, pas un compteur de facturation. Le vrai plafond reste la limite du compte OpenAI.
- **La classification des signaux est heuristique** (expressions françaises et anglaises). Elle est volontairement conservatrice : en cas de doute, elle choisit le modèle le plus modeste, jamais le plus cher.
- **La vérification ajoute de la latence** (un appel court supplémentaire). Elle est bornée dans le temps et abandonnée si l'échéance approche ; son échec n'invalide jamais la réponse.
- **La collaboration n'est pas un gain garanti** : elle aide sur les demandes réellement ambiguës, elle n'améliore pas une question factuelle. D'où le seuil élevé avant de la déclencher.

---

## 6. Différentiel

```
.env.example |  25 ++-
README.md    |  34 +++-
api/chat.ts  | 568 ++++++++++++++++++-------------------   (déplacement + câblage, pas de réécriture du contrat)
package.json |   7 +-
server/ai/   | nouveau : 2 337 lignes (catalogue, routeur, transport, orchestration, prompts, budget)
scripts/     | nouveau : 3 suites de tests + 1 outil de vérification
```

Aucune modification de : `src/`, `supabase/`, `vercel.json`, `server/access.ts`, `server/quotas.ts`, `server/planChange*.ts`, `server/paddleApi.ts`, routes Paddle.
