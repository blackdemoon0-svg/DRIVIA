# Vocal Live VEYVRO — GPT-Live 1.1 en WebRTC

## Ce qui est livré

La conversation vocale temps réel, avec un choix de voix **propre à chaque
compte** et **enregistré sur le compte**.

| Élément | Valeur |
| --- | --- |
| Modèle vocal | `gpt-live-1.1` (délégué à `gpt-6-luna`) |
| Transport | WebRTC, échange SDP côté serveur |
| Voix par défaut | `brise` |
| Voix proposées | 28 voix documentées + `marin` (défaut OpenAI) |
| Quota vocal | `voiceMinutesPerDay` : Découverte 0, Plus 10, Pro 30, **persistant en base** |
| Préférence | `raw_user_meta_data.veyvro_voice` (aucune table, aucune migration) |

## Fichiers

**Nouveaux**

| Fichier | Rôle |
| --- | --- |
| `server/ai/voiceCatalog.ts` | Le catalogue des voix, source unique ; résolution et validation d'un identifiant ; modèle et cible de délégation |
| `server/voiceUsage.ts` | Appels aux fonctions SQL `voice_*` : réservation, règlement, remboursement. Aucun état local |
| ~~`server/voiceSessions.ts`~~ | **Supprimé** : le registre en mémoire est remplacé par la table `voice_sessions` |
| `supabase/migrations/0004_voice_usage.sql` | Tables `voice_usage_daily` et `voice_sessions`, cinq fonctions, RLS. **Non exécutée** |
| `scripts/sql/voice-usage.sql.test.mjs` | 20 contrôles : exécute la migration dans un PostgreSQL 16 réel (PGlite) et prouve les garanties, y compris la concurrence |
| `api/_liveConfig.ts` | Construction de la configuration de session (modèle, voix, consignes, délégation). Préfixe `_` : ce n'est pas une route |
| `api/voice-session.ts` | `POST` une offre SDP → authentification → validation de la voix → quota → session Live → réponse SDP |
| `api/voice-end.ts` | Ferme une session et règle la durée réelle côté serveur |
| `api/voice-profiles.ts` | `GET` catalogue + voix du compte ; `PUT` valide et enregistre le choix |
| `src/lib/useVoicePreference.js` | Préférence : compte d'abord, cache local ensuite |
| `src/lib/useVoiceLive.js` | Session WebRTC : micro, data channel `oai-events`, fin, changement de voix |
| `src/components/VoicePicker.jsx` | Sélecteur de voix (aperçus uniquement s'ils sont réels) |
| `src/components/VoiceLiveButton.jsx` | Bouton micro, état de session, quota restant |
| `scripts/voice.test.mjs` | 106 contrôles : catalogue, validation, quota, durée non falsifiable, sessions simultanées, fermetures anormales, contexte, erreurs, formules, périmètre |
| `scripts/voice-store.stub.mjs` | Double fidèle des fonctions SQL pour les tests de route (sans réseau) |

**Modifiés — de façon strictement additive**

| Fichier | Modification |
| --- | --- |
| `src/lib/planLimits.ts` | Champ `voiceMinutesPerDay` + valeurs 0 / 10 / 30 |
| `server/quotas.ts` | Champ `voiceSeconds` dans l'entrée existante, remis à zéro à minuit UTC ; `reserveVoiceQuota`, `settleVoiceQuota`, `readVoiceUsage` |
| `src/lib/chatApi.js` | Ajout de `VoiceApiError`, `fetchVoiceProfiles`, `saveVoicePreference`, `startVoiceSession`, `endVoiceSession`, `voiceErrorMessage`. `streamChat`, `parseSseBlock`, `trimHistory` inchangés |
| `src/App.jsx` | Montage du bouton vocal pour un compte authentifié, avec l'historique de la conversation |
| `src/components/ChatComposer.jsx` | Nouvelle prop optionnelle `voiceSlot` (par défaut `null` : rendu identique sans elle) |
| `src/components/ChatView.jsx`, `HomeView.jsx` | Transmission de `voiceSlot` |
| `src/components/Icons.jsx` | `MicIcon`, `MicOffIcon` |
| `src/index.css` | Styles du bouton et du sélecteur |
| `scripts/access.test.mjs` | Les trois `deepEqual` de `PLAN_LIMITS` incluent le nouveau champ ; la fixture « abonnement Pro » est ancrée sur l'horloge réelle (voir plus bas) |
| `package.json` | `test:voice` et `test:voice-sql` ajoutés à la suite `test` ; `@electric-sql/pglite` en dépendance de développement |

## Contrats d'API

### `POST /api/voice-session`

```jsonc
// requête
{ "sdp": "v=0…", "voice": "brise", "history": [{ "role": "user", "content": "…" }] }

// 201
{
  "sessionId": "…",                 // identifiant serveur, pas celui d'OpenAI
  "sdp": "v=0…",                    // réponse SDP à appliquer
  "voice": { "id": "brise", "label": "Brise", "replacedInvalidRequest": false },
  "quota": { "limitMinutes": 10, "remainingSeconds": 540, "usedSeconds": 60 }
}
```

Erreurs : `invalid_offer` 400 · `voice_not_in_plan` 403 · **`voice_session_open` 409** · `voice_minutes_exhausted` / `rate_limited` 429 (+`Retry-After`) · `invalid_api_key` / `voice_unavailable` / `provider_error` 502 · `timeout` 504 · `identity_unavailable` / `missing_api_key` / `not_configured` / **`voice_store_unavailable`** 503.

Un identifiant de voix inconnu **n'est jamais transmis** : il est remplacé par
`brise` et `replacedInvalidRequest: true` permet au client de corriger la
préférence enregistrée.

### `POST /api/voice-end`

```jsonc
{ "sessionId": "…" }
// 200
{ "settledWith": "duration" | "never-started" | "already-closed" | "already-released" | "unknown-session",
  "chargedSeconds": 42, "measuredSeconds": 42, "usedSeconds": 42,
  "clientReportedSeconds": 0 }
```

La durée vient de la base (`now() - started_at`), **jamais du client**.
`clientReportedSeconds` n'est qu'un renseignement de support.
Fermer deux fois ne facture pas deux fois. Une session inconnue ne facture rien
et renvoie `clientReportedSeconds` pour le diagnostic seulement.

### `GET | PUT /api/voice-profiles`

`GET` renvoie le catalogue même à un visiteur non connecté (`selected: null`) ;
pour un compte, `selected` est la voix enregistrée si elle existe encore dans le
catalogue, sinon `brise`. `PUT { voice }` valide puis écrit
`data.veyvro_voice` via `PUT /auth/v1/user` avec le jeton de l'utilisateur, qui
**fusionne** les métadonnées — c'est ce qui préserve `avatar_url` et
`avatar_path`.

## Quota vocal — persistant, partagé, facturé au temps réel

Le compteur vivait dans un `Map` par instance : perdu au redémarrage, et non
partagé — 30 minutes **par instance** au lieu de 30 minutes par jour. Il vit
désormais dans Postgres (`0004_voice_usage.sql`).

Formules : Découverte **0**, Plus **10**, Pro **30** minutes par jour UTC.

### Deux phases, et c'est ce qui protège la facturation

Une session n'est pas une seule ligne droite. Elle a deux états :

| État | `started_at` | Facturable | Ce qui s'y passe |
| --- | --- | --- | --- |
| `pending` | `NULL` | **non** | la réservation est posée, l'offre SDP voyage |
| `active` | posé par `voice_activate` | oui | la conversation a commencé |

`started_at` est écrit **après** la réponse réussie du fournisseur. Les 20
secondes de préparation de la connexion ne sont donc pas facturées.

### La durée est calculée par PostgreSQL, pas reçue

`voice_settle` **n'accepte aucun paramètre de durée**. Elle calcule
`now() - started_at`, puis borne au plafond de session (3600 s).

C'est une correction, pas un détail : la version précédente recevait
`p_actual_seconds`, c'est-à-dire le `durationSeconds` du navigateur. Un client
envoyant `0` ne payait rien. Le paramètre a été **supprimé** — on ne peut pas
transmettre par accident ce qui n'existe pas. La valeur du client est renvoyée
sous `clientReportedSeconds`, pour le diagnostic uniquement.

### Les six opérations

1. **Réserver** (`voice_reserve`) — 60 s, condition d'autorisation dans le
   `UPDATE ... WHERE`. Atomique sous concurrence.
2. **Refuser une deuxième session** — un index unique partiel interdit deux
   lignes `pending` **ou** `active` par compte. Deux appareils sont refusés en
   `409 voice_session_open`, sans aucune facturation.
3. **Activer** (`voice_activate`) — pose `started_at`, allonge le bail.
4. **Régulariser** (`voice_settle`) — durée mesurée, idempotent.
5. **Rembourser** (`voice_refund`) — rend la réservation, idempotent.
6. **Balayer** (`voice_expire_stale`, `voice_close_overdue`) — voir ci-dessous.

### Le bail ne libère jamais une conversation active

C'est la réponse au scénario « deux appareils » :

- `voice_expire_stale` ne regarde **que** les réservations `pending`. Une
  session `active` n'est jamais libérée par expiration, même si son bail est
  ancien. Un bail de réservation dure 5 minutes ; le bail d'une session active
  en dure 65.
- Une session `active` ne peut se terminer que par un règlement, un
  remboursement, ou **le plafond dur** : `voice_close_overdue` clôt et facture
  toute session active depuis plus de 3600 s — la limite documentée d'une
  session GPT-Live. Elle le fait **avant** d'autoriser une nouvelle session.

Conséquence : une conversation de plus d'une heure ne peut jamais être suivie
d'une seconde conversation simultanée. Elle est close et facturée, puis la
place se libère — ou le quota bloque, si la facture l'épuise.

### Ce que le client ne peut pas faire

Il ne peut pas fournir la durée, ni la réduire, ni la gonfler au-delà du
plafond. Il ne peut pas ouvrir deux sessions. Il ne peut pas écrire les
compteurs (RLS : lecture seule de ses propres lignes).

Si Supabase est injoignable, la route répond `503 voice_store_unavailable` :
elle **échoue fermé**, sans jamais retomber sur un compteur en mémoire.

## Contexte vocal — conservé lors d'un changement de voix

Une voix est figée dans une session GPT-Live : changer de voix ferme la session
et en ouvre une nouvelle. Sans mémoire, VEYVRO repartait de zéro.

- La session demande maintenant la **transcription de l'entrée audio**
  (`audio.input.transcription`, modèle `whisper-1`). Sans elle, le seul texte
  disponible serait celui de l'assistant : l'historique ne contiendrait que ses
  propres réponses.
- `useVoiceLive` tient une **mémoire vocale** (`voiceHistoryRef`), alimentée par
  les transcriptions finalisées — jamais par les fragments de streaming, qui
  produiraient un historique haché.
- À chaque ouverture, `mergeVoiceHistory` fusionne le fil **écrit** (fourni par
  `App`) et le fil **vocal**, sans doublon consécutif. Bornes : 12 messages et
  4 000 caractères.
- La mémoire survit aux **changements de voix**, et est effacée par `stop()` :
  une conversation terminée ne pollue pas la suivante.
- `restartWithVoice` appelle la version **la plus récente** de `start` via une
  ref. Sans cela, le second changement de voix serait reparti avec la voix
  capturée au premier clic — un bug silencieux.

## Corrections apportées après la revue du 2026-11-22

Sept défauts réels ont été trouvés en confrontant le code à la documentation
officielle, puis corrigés dans la même PR. Chacun a un test qui échoue si on le
réintroduit.

| # | Défaut | Conséquence | Correction |
| --- | --- | --- | --- |
| 1 | Catalogue de 21 voix | **Sept voix réelles manquaient, dont les cinq espagnoles.** L'espagnol fait partie des langues exigées : un utilisateur hispanophone ne voyait que des voix françaises et allemandes. | Les 28 voix de la documentation, à l'identique. |
| 2 | Garde-fou de longueur des consignes mal calibré | Un prompt dépassant la limite réelle de 16 384 tokens aurait été accepté par le garde-fou puis refusé par OpenAI : **toutes les sessions vocales auraient échoué**, avec un message d'erreur opaque. | Garde-fou ramené à `16 384 × 3` caractères (~49 000), volontairement **sous** la limite réelle estimée (~65 000 caractères à 4 car/token) : il échoue avant OpenAI. Prompt actuel : 5 636 caractères, soit ~1 400 tokens. |
| 3 | La délégation recevait le prompt de *conversation* | Le backend aurait répondu en phrases courtes au lieu de raisonner. Ce sont deux canaux distincts dans la documentation. | `delegation.responses.instructions` = prompt VEYVRO + bloc « backend » ; `instructions` = prompt VEYVRO + bloc « conversation ». |
| 4 | Aucune salutation | L'utilisateur ouvrait le micro et **entendait le silence** : une session Live écoute d'abord. | Message `developer` de salutation dans `session.input`, selon la recette documentée « Greet before the caller speaks ». |
| 5 | Session inconnue à la fermeture : rien n'était réglé | Sur plusieurs instances serverless, **la réservation de 60 s restait consommée** à chaque session : fuite de quota, utilisateur bloqué sans avoir parlé. | Réservation rendue si aucune durée n'est fournie ; sinon durée du navigateur utilisée, **plafonnée à la réservation**. Le registre serveur reste prioritaire. |
| 6 | Préférence écrite via l'endpoint **admin** Supabase | `PUT /auth/v1/admin/users/{id}` remplace tout `raw_user_meta_data` : **la photo de profil aurait été effacée** au premier changement de voix. | Écriture via `PUT /auth/v1/user` avec le jeton de l'utilisateur — la même mécanique que `client.auth.updateUser` de l'avatar. Aucune clé de service nécessaire. |
| 7 | Interface | Les minutes restantes d'une session **terminée** étaient affichées (chiffre périmé) ; une voix remplacée par le serveur n'était pas signalée ; le composeur transmettait l'événement de clic comme identifiant de voix au redémarrage. | Quota affiché seulement pendant la session ; substitution signalée et préférence réparée ; identifiant de voix validé avant redémarrage. |

### Un test qui masquait un vrai problème

`scripts/access.test.mjs` échouait sur `main` (`'decouverte' == 'pro'`). Ce n'était
pas un bug de `server/access.ts` — vérifié en l'exécutant isolément. La fixture
« abonnement Pro en cours » construisait son échéance à partir d'une constante
`NOW` fixée au **1er novembre 2026 à midi** ; une fois cette date passée, un
abonnement « valable 20 jours » était expiré, et le test comparait un refus
légitime. La fixture utilise maintenant l'horloge réelle pour les cas qui
passent par `authorizeRequest`. Le test passe, et `/api/voice-session` conserve
donc sa couverture des trois formules.

## Ce qui n'a pas pu être vérifié ici

Ces points ne sont **pas** des tests passés. Ils sont bloqués dans cet
environnement, pas dans le code :

- **Aucun appel réseau réel à OpenAI.** `VEYVRO_AI_API_KEY` n'est pas disponible
  ici et `api.openai.com` est injoignable (échec TLS depuis le bac à sable).
  Toutes les routes ont été testées contre un `fetch` simulé, jamais contre le
  vrai service.
- **Aucune poignée de main WebRTC réelle**, donc aucun son, aucune mesure de
  latence.
- **Aucun aperçu audio livré.** Les 28 voix sont marquées
  `previewAvailable: false` : un aperçu doit être enregistré depuis une vraie
  session GPT-Live, et l'API TTS d'OpenAI ne partage qu'une seule voix avec
  Live (`marin`). Jouer un échantillon qui n'est pas la voix annoncée serait
  pire que de n'en avoir aucun. Le sélecteur l'annonce explicitement à
  l'utilisateur. La génération est prévue par `scripts/voice-samples.mjs`, qui
  nécessite une clé réelle.
- **Comportement multi-instance réel.** Il est désormais **prouvé par le SQL**,
  pas par un déploiement : `scripts/sql/voice-usage.sql.test.mjs` exécute la
  migration dans un PostgreSQL 16 réel (PGlite) et lance deux réservations et
  quatre fermetures **simultanées**. Ce n'est pas deux instances Vercel : c'est
  deux sessions Postgres concurrentes sur les mêmes lignes. C'est le niveau de
  preuve disponible ici, et il est honnête de le dire ainsi.
- **La migration n'est pas appliquée.** `0004_voice_usage.sql` est proposée,
  testée sur PostgreSQL 16, **jamais exécutée sur Supabase**. Tant qu'elle ne
  l'est pas, les routes renvoient `503 voice_store_unavailable` (le message
  nomme la migration).
- **Le plafond dur est une supposition raisonnée.** 3600 s correspond à la
  limite documentée d'une session GPT-Live, mais aucune session réelle n'a été
  observée au-delà de quelques minutes : la valeur n'est pas confirmée par
  l'expérience.
- **`voice_touch` n'est pas appelé par l'interface.** Le bail d'une session
  active est posé à l'activation et n'a pas besoin d'être prolongé (65 min de
  bail pour 60 min de plafond). La fonction existe pour le diagnostic, pas pour
  la facturation.

## Notes d'exploitation

- Aucune variable d'environnement nouvelle : `VEYVRO_AI_API_KEY`,
  `VEYVRO_AI_BASE_URL`, et les trois clés Supabase existantes.
- **Une migration SQL devient nécessaire** : `0004_voice_usage.sql`. Non
  exécutée. Sans elle, la voix répond `503 voice_store_unavailable`, elle ne
  retombe pas silencieusement sur l'ancien comportement.
- La voix est figée pour la durée d'une session GPT-Live : changer de voix
  ferme la session et en ouvre une nouvelle avec le même contexte. C'est la
  seule façon honnête de le faire, et c'est ce que fait l'interface.
- Un utilisateur Découverte peut **choisir** une voix (elle reste enregistrée)
  mais ne peut pas ouvrir de session : le refus intervient avant tout appel
  fournisseur.
