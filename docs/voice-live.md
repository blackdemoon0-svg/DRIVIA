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
| Quota vocal | `voiceMinutesPerDay` : Découverte 0, Plus 10, Pro 30 |
| Préférence | `raw_user_meta_data.veyvro_voice` (aucune table, aucune migration) |

## Fichiers

**Nouveaux**

| Fichier | Rôle |
| --- | --- |
| `server/ai/voiceCatalog.ts` | Le catalogue des voix, source unique ; résolution et validation d'un identifiant ; modèle et cible de délégation |
| `server/voiceSessions.ts` | Registre serveur des sessions ouvertes : propriétaire, début, durée réelle, fermeture idempotente |
| `api/_liveConfig.ts` | Construction de la configuration de session (modèle, voix, consignes, délégation). Préfixe `_` : ce n'est pas une route |
| `api/voice-session.ts` | `POST` une offre SDP → authentification → validation de la voix → quota → session Live → réponse SDP |
| `api/voice-end.ts` | Ferme une session et règle la durée réelle côté serveur |
| `api/voice-profiles.ts` | `GET` catalogue + voix du compte ; `PUT` valide et enregistre le choix |
| `src/lib/useVoicePreference.js` | Préférence : compte d'abord, cache local ensuite |
| `src/lib/useVoiceLive.js` | Session WebRTC : micro, data channel `oai-events`, fin, changement de voix |
| `src/components/VoicePicker.jsx` | Sélecteur de voix (aperçus uniquement s'ils sont réels) |
| `src/components/VoiceLiveButton.jsx` | Bouton micro, état de session, quota restant |
| `scripts/voice.test.mjs` | 94 contrôles : catalogue, validation, quota, sessions simultanées, fermetures anormales, erreurs, formules, périmètre, additivité |

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
| `package.json` | `test:voice` ajouté à la suite `test` |

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
  "quota": { "limitMinutes": 10, "remainingSeconds": 540 }
}
```

Erreurs : `invalid_offer` 400 · `voice_not_in_plan` 403 · `voice_minutes_exhausted` / `rate_limited` 429 (+`Retry-After`) · `invalid_api_key` / `voice_unavailable` / `provider_error` 502 · `timeout` 504 · `identity_unavailable` / `missing_api_key` / `not_configured` 503.

Un identifiant de voix inconnu **n'est jamais transmis** : il est remplacé par
`brise` et `replacedInvalidRequest: true` permet au client de corriger la
préférence enregistrée.

### `POST /api/voice-end`

```jsonc
{ "sessionId": "…" }
// 200
{ "settledWith": "duration" | "already-closed" | "unavailable",
  "chargedSeconds": 42, "usedSeconds": 42 }
```

La durée vient du registre serveur, jamais du client. Fermer deux fois ne
facture pas deux fois.

### `GET | PUT /api/voice-profiles`

`GET` renvoie le catalogue même à un visiteur non connecté (`selected: null`) ;
pour un compte, `selected` est la voix enregistrée si elle existe encore dans le
catalogue, sinon `brise`. `PUT { voice }` valide puis écrit
`data.veyvro_voice` via l'API admin Supabase — le même mécanisme que
`avatar_url`.

## Quota vocal

Pas de second système : `voiceSeconds` est un champ de l'entrée de compteur
existante (`messages`, `quotes`), remise à zéro avec elles à minuit UTC.

1. La session **réserve** 60 s avant l'appel fournisseur (deux sessions
   parallèles ne peuvent pas passer la même vérification).
2. Un échec fournisseur **rend** immédiatement la réservation : une session qui
   n'a pas démarré ne coûte rien.
3. La fermeture **règle** la durée réelle (`réservé − réel`, négatif autorisé :
   une session de 90 s consomme 90 s).

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
- **Comportement multi-instance.** Le registre des sessions et les compteurs
  sont en mémoire, comme les quotas existants. Une session ouverte sur une
  instance et fermée sur une autre renvoie `settledWith: "unavailable"` au lieu
  de facturer un chiffre inventé.

## Notes d'exploitation

- Aucune variable d'environnement nouvelle : `VEYVRO_AI_API_KEY`,
  `VEYVRO_AI_BASE_URL`, et les trois clés Supabase existantes.
- Aucune migration SQL.
- La voix est figée pour la durée d'une session GPT-Live : changer de voix
  ferme la session et en ouvre une nouvelle avec le même contexte. C'est la
  seule façon honnête de le faire, et c'est ce que fait l'interface.
- Un utilisateur Découverte peut **choisir** une voix (elle reste enregistrée)
  mais ne peut pas ouvrir de session : le refus intervient avant tout appel
  fournisseur.
