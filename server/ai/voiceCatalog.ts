/**
 * OpenAI GPT-Live voices — the single source of truth.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHERE THESE IDENTIFIERS COME FROM
 * ─────────────────────────────────────────────────────────────────────────────
 * Read from the official documentation on 2026-11-22:
 *   https://developers.openai.com/api/docs/guides/live-conversations  → "Voice options"
 *   https://developers.openai.com/api/docs/models/gpt-live-1.1
 *
 * The documented table lists 28 voices for GPT-Live, plus the documented
 * default (`marin`). No identifier here is invented: `scripts/voice.test.mjs`
 * asserts the exact set, so adding or removing a voice is a deliberate edit,
 * never a typo.
 *
 * Correction of 2026-11-22: the first version of this file shipped 21 voices and
 * was missing the seven additions of the current table — including all five
 * Spanish voices. Spanish is one of the four languages VEYVRO must speak, so a
 * user asking for a Spanish voice was being shown French and German ones. The
 * table now mirrors the documentation line for line.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT THE "LANGUAGE" FIELD MEANS — AND DOES NOT MEAN
 * ─────────────────────────────────────────────────────────────────────────────
 * The documentation describes each voice by its *regional influence* and
 * presentation ("English · North American · Feminine"), not by a hard language
 * restriction. GPT-Live-1.1 is explicitly a multilingual, full-duplex model:
 * "it transcribes speech more accurately and maintains a more consistent accent
 * and voice across languages", and the documentation invites testing a voice
 * with the languages the application needs.
 *
 * Consequences encoded below:
 *   • no voice is presented as "the Spanish voice" or "the Arabic voice": there
 *     is no documented per-language voice list, and inventing one would be a
 *     lie to the user;
 *   • `speaksAllLanguages` is therefore true for every voice, and the user's
 *     language is never used to silently swap their chosen voice;
 *   • `accent` is displayed as information ("influence régionale"), so the user
 *     can pick what suits them.
 */

import type { ReasoningEffort } from "./modelCatalog.js";

/** A voice the Live session may use. */
export type VoiceId = string;

export type LiveVoice = {
  /** Exact API identifier, sent in `session.audio.output.voice`. */
  id: VoiceId;
  /** Display name, as documented. */
  label: string;
  /** Documented language of the voice's regional influence. */
  language: string;
  /** Documented regional influence, shown to the user. */
  accent: string;
  /** Documented presentation. */
  presentation: "feminine" | "masculine";
  /** Documented origin: natural recording or generated. */
  source: "natural" | "generated";
  /**
   * Whether a preview file ships with the repository. False means "no preview
   * yet": the interface must say so instead of playing another voice's sample.
   */
  previewAvailable: boolean;
  /**
   * Whether this voice is offered in the short list. Every documented voice
   * stays selectable; `featured` only drives the suggested order of the picker,
   * and the short list covers each supported language (FR, EN, ES, PT).
   */
  featured: boolean;
};

/**
 * The 28 documented GPT-Live voices, in the order of the documentation table.
 *
 * `previewAvailable` is false everywhere by default: previews are real audio
 * captured from a real GPT-Live session (see `scripts/voice-samples.mjs`), and
 * they can only be generated with a live API key. Shipping a sample that is not
 * the voice it claims to be would be worse than having none.
 */
export const LIVE_VOICES: readonly LiveVoice[] = [
  { id: "pearl", label: "Pearl", language: "Anglais", accent: "Australien", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "quartz", label: "Quartz", language: "Anglais", accent: "Australien", presentation: "feminine", source: "generated", previewAvailable: false, featured: true },
  { id: "ripple", label: "Ripple", language: "Anglais", accent: "Australien", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "halo", label: "Halo", language: "Anglais", accent: "Britannique", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "vesper", label: "Vesper", language: "Anglais", accent: "Britannique", presentation: "masculine", source: "natural", previewAvailable: false, featured: true },
  { id: "willow", label: "Willow", language: "Anglais", accent: "Irlandais", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "stone", label: "Stone", language: "Anglais", accent: "Irlandais", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "gleam", label: "Gleam", language: "Anglais", accent: "Amérique du Nord", presentation: "feminine", source: "natural", previewAvailable: false, featured: true },
  { id: "meridian", label: "Meridian", language: "Anglais", accent: "Amérique du Nord", presentation: "masculine", source: "natural", previewAvailable: false, featured: true },
  { id: "bossa", label: "Bossa", language: "Portugais", accent: "Brésilien", presentation: "feminine", source: "natural", previewAvailable: false, featured: true },
  { id: "tempo", label: "Tempo", language: "Portugais", accent: "Brésilien", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "beacon", label: "Beacon", language: "Anglais", accent: "Philippin", presentation: "masculine", source: "generated", previewAvailable: false, featured: false },
  { id: "delta", label: "Delta", language: "Anglais", accent: "Sud des États-Unis", presentation: "feminine", source: "generated", previewAvailable: false, featured: false },
  { id: "cinder", label: "Cinder", language: "Anglais", accent: "Sud des États-Unis", presentation: "masculine", source: "generated", previewAvailable: false, featured: false },
  { id: "calandria", label: "Calandria", language: "Espagnol", accent: "Argentin", presentation: "feminine", source: "natural", previewAvailable: false, featured: true },
  { id: "compas", label: "Compás", language: "Espagnol", accent: "Argentin", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "hornero", label: "Hornero", language: "Espagnol", accent: "Argentin", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "luciernaga", label: "Luciérnaga", language: "Espagnol", accent: "Mexicain", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "destello", label: "Destello", language: "Espagnol", accent: "Mexicain", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "nuri", label: "Nuri", language: "Allemand", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: true },
  { id: "juni", label: "Juni", language: "Allemand", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "flitz", label: "Flitz", language: "Allemand", accent: "—", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "brise", label: "Brise", language: "Français", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: true },
  { id: "sillage", label: "Sillage", language: "Français", accent: "—", presentation: "masculine", source: "natural", previewAvailable: false, featured: true },
  { id: "nira", label: "Nira", language: "Hindi", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "harema", label: "Harema", language: "Japonais", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
  { id: "shida", label: "Shida", language: "Japonais", accent: "—", presentation: "masculine", source: "natural", previewAvailable: false, featured: false },
  { id: "noeul", label: "Noeul", language: "Coréen", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
];

/**
 * Voices accepted by GPT-Live that the documented table does not list.
 *
 * `marin` is the documented default voice of a Live session. It is accepted by
 * the API, so it is accepted here — refusing it would be stricter than OpenAI.
 * It is not in the table above, so it is kept apart: the catalogue test asserts
 * both sets separately.
 */
/** Documented default voice of a Live session. */
export const EXTRA_VOICES: readonly LiveVoice[] = [
  { id: "marin", label: "Marin (défaut OpenAI)", language: "—", accent: "—", presentation: "feminine", source: "natural", previewAvailable: false, featured: false },
];

/** Voice used when the user has not chosen one. Validated with the owner. */
export const DEFAULT_VOICE_ID: VoiceId = "brise";

const ALL_VOICES: readonly LiveVoice[] = [...LIVE_VOICES, ...EXTRA_VOICES];

const BY_ID = new Map<VoiceId, LiveVoice>(ALL_VOICES.map((voice) => [voice.id, voice]));

/** Every selectable voice: the 28 documented ones, then the extra accepted ids. */
export function listVoices(): readonly LiveVoice[] {
  return ALL_VOICES;
}

/** Voices suggested first in the picker, without hiding the others. */
export function featuredVoices(): readonly LiveVoice[] {
  return ALL_VOICES.filter((voice) => voice.featured);
}

/**
 * Resolve a requested voice id.
 *
 * Returns the matching voice, or `null` when the id is unknown. Callers must
 * treat `null` as "fall back to the default and say so", never as "send it
 * anyway": the id ends up in a request to OpenAI with our key.
 */
export function resolveVoice(raw: unknown): LiveVoice | null {
  if (typeof raw !== "string") return null;
  const id = raw.trim().toLowerCase();
  if (!id) return null;
  return BY_ID.get(id) ?? null;
}

/** The voice to use for a request, plus whether the requested one was refused. */
export function selectVoice(raw: unknown): { voice: LiveVoice; rejectedRequest: boolean } {
  const requested = resolveVoice(raw);
  if (requested) return { voice: requested, rejectedRequest: false };
  const fallback = BY_ID.get(DEFAULT_VOICE_ID);
  if (!fallback) throw new Error("DEFAULT_VOICE_ID is not part of the voice catalogue.");
  return { voice: fallback, rejectedRequest: typeof raw === "string" && raw.trim().length > 0 };
}

/** Public shape sent to the browser. Contains no secret and no prompt. */
export function publicVoice(voice: LiveVoice) {
  return {
    id: voice.id,
    label: voice.label,
    language: voice.language,
    accent: voice.accent,
    presentation: voice.presentation,
    featured: voice.featured,
    previewAvailable: voice.previewAvailable,
    previewUrl: voice.previewAvailable ? `/voices/${voice.id}.mp3` : null,
  };
}

// ---------------------------------------------------------------------------
// Live session model and delegation
// ---------------------------------------------------------------------------

/** The voice model. Verified: "Full-duplex voice model for multilingual conversations". */
export const LIVE_MODEL = "gpt-live-1.1";

/**
 * Backend model for delegation.
 *
 * `gpt-6-luna` is the model the official delegation guide puts forward as the
 * starting point ("Start with gpt-6-luna"). It is also already part of the
 * VEYVRO routing catalogue, so the voice layer stays consistent with the text
 * architecture instead of introducing a second model policy.
 */
export const LIVE_DELEGATION_MODEL = "gpt-6-luna";

/** Reasoning effort handed to the delegating model, kept aligned with the router. */
export const LIVE_DELEGATION_EFFORT: ReasoningEffort = "low";

/**
 * Model used to transcribe the user's speech into the session.
 *
 * This is not decoration: `conversation.item.input_audio_transcription.completed`
 * is what lets the server know what the user said. Without it, the conversation
 * memory that survives a voice change could only contain the assistant's turns.
 *
 * `whisper-1` is the transcription model documented for Live audio input.
 */
export const LIVE_TRANSCRIPTION_MODEL = "whisper-1";

/** Hard platform limit documented for a Live session. */
export const LIVE_MAX_SESSION_MINUTES = 60;
