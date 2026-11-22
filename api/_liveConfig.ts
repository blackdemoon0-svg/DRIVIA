/**
 * GPT-Live session configuration — built on the server, never on the client.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY IT LIVES HERE
 * ─────────────────────────────────────────────────────────────────────────────
 * The session configuration is the security boundary of the voice feature: it
 * names the model, the voice, the instructions, and the backend the voice is
 * allowed to delegate to. If the browser could send it, a user could point our
 * API key at any model, or replace VEYVRO's instructions with their own.
 *
 * So the browser sends exactly two things: an SDP offer and the voice id it
 * wants. The voice id is validated against `voiceCatalog`; everything else is
 * decided here.
 *
 * The instructions are the real VEYVRO persona, imported from
 * `server/veyvroSystemPrompt.ts` — the same file the text chat uses. It is not
 * copied, ever: two copies would drift, and the voice would stop sounding like
 * VEYVRO the day someone edits one of them.
 */

import VEYVRO_SYSTEM_PROMPT from "../server/veyvroSystemPrompt.js";
import {
  LIVE_DELEGATION_EFFORT,
  LIVE_DELEGATION_MODEL,
  LIVE_MODEL,
  type LiveVoice,
} from "../server/ai/voiceCatalog.js";
import type { ProviderMessage } from "../server/ai/provider.js";

/** Maximum instructions size documented for GPT-Live: 16 384 tokens. */
const MAX_INSTRUCTION_TOKENS = 16_384;
/** Rough guard: ~4 characters per token, with margin. */
const MAX_INSTRUCTION_CHARACTERS = MAX_INSTRUCTION_TOKENS * 3;

/**
 * Behavioural instructions for the *spoken* channel.
 *
 * The persona is inherited from the text prompt; this block only adds what only
 * makes sense out loud: brevity, no markdown, and the language rule. The
 * language rule never mentions changing voice — the chosen voice is kept across
 * languages, which is the point of a multilingual voice model.
 */
const VOICE_INSTRUCTIONS = `
VOICE CHANNEL
- This is a spoken conversation. Answer in short, natural sentences that are easy to listen to. Aim for a few sentences and let the user ask for more.
- Never read out markdown, bullet symbols, URLs, code blocks, part numbers as a wall of characters, or emoji. Say things the way a person would say them.
- If a figure needs a unit, say the unit. If a figure is uncertain, say it is approximate.
- If the user interrupts, stop and listen. Do not repeat what was already said.
- Match the language the user is speaking right now, including when they switch mid-conversation. Keep the same voice: it is a multilingual voice, and switching language must never change how you sound.
- Never claim to be a human. If asked, say you are VEYVRO, an AI automotive assistant.
`.trim();

export type LiveSessionConfig = {
  model: string;
  instructions: string;
  audio: { output: { voice: string } };
  delegation: {
    type: "responses";
    responses: {
      model: string;
      instructions: string;
      reasoning: { effort: string };
    };
  };
  store: boolean;
};

/**
 * Build the `session` object sent to `POST /v1/live/sessions`.
 *
 * Notes on the choices, all taken from the official documentation:
 *   • `audio.output.voice` — the voice is fixed for the session's lifetime;
 *     changing it means a new session (which is what the client does when the
 *     user picks another voice).
 *   • `delegation.type: "responses"` — OpenAI runs the backend model and passes
 *     the conversation context to it, which keeps our integration small.
 *   • `store: false` — the documented default, kept explicit: a voice session is
 *     not kept for forking.
 *   • no `audio.format` — WebRTC negotiates the format during connection; the
 *     documentation says to leave it out of WebRTC requests.
 */
export function buildLiveSessionConfig(voice: LiveVoice): LiveSessionConfig {
  const instructions = `${VEYVRO_SYSTEM_PROMPT}\n\n${VOICE_INSTRUCTIONS}`;
  if (instructions.length > MAX_INSTRUCTION_CHARACTERS) {
    throw new Error("Live instructions exceed the documented size limit.");
  }

  return {
    model: LIVE_MODEL,
    instructions,
    audio: { output: { voice: voice.id } },
    delegation: {
      type: "responses",
      responses: {
        model: LIVE_DELEGATION_MODEL,
        // The backend reasons; the voice model speaks. Keeping the same persona
        // here means a delegated answer still sounds like VEYVRO.
        instructions: VEYVRO_SYSTEM_PROMPT,
        reasoning: { effort: LIVE_DELEGATION_EFFORT },
      },
    },
    store: false,
  };
}

/**
 * Previous conversation, seeded into the session.
 *
 * The documented shape is a list of messages with typed content. We only pass
 * text: the voice channel does not need the images or attachments of the text
 * thread, and sending them would cost tokens for no audible benefit.
 */
export function buildSessionInput(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxMessages = 12,
): Array<{ type: "message"; role: "user" | "assistant"; content: Array<Record<string, unknown>> }> {
  const recent = history.slice(-maxMessages);
  return recent
    .filter((message) => message.content.trim().length > 0)
    .map((message) => ({
      type: "message" as const,
      role: message.role,
      content: [
        {
          type: message.role === "user" ? "input_text" : "output_text",
          text: message.content.slice(0, 2_000),
        },
      ],
    }));
}

/**
 * The provider messages used when delegating through VEYVRO's own chat path.
 *
 * Reserved for the "client delegation" mode: it lets the voice borrow the text
 * router (multi-model, verification, quotas) instead of OpenAI's managed
 * backend. Not used by the current Responses delegation, but kept next to the
 * config so both modes stay visibly aligned on the same system prompt.
 */
export function buildDelegationMessages(
  history: Array<{ role: "user" | "assistant"; content: string }>,
): ProviderMessage[] {
  return [
    { role: "system", content: VEYVRO_SYSTEM_PROMPT },
    ...history.map((message) => ({ role: message.role, content: message.content })),
  ];
}
