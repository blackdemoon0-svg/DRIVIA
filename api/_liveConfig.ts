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
  LIVE_TRANSCRIPTION_MODEL,
  type LiveVoice,
} from "../server/ai/voiceCatalog.js";
import type { ProviderMessage } from "../server/ai/provider.js";

/** Maximum instructions size documented for GPT-Live: 16 384 tokens. */
const MAX_INSTRUCTION_TOKENS = 16_384;
/**
 * Conservative character guard.
 *
 * The estimate is ~4 characters per token for English prose, but VEYVRO's prompt
 * is French: accented characters and the tokenizer's handling of them push the
 * ratio lower. 3 characters per token is therefore an *upper* bound on the
 * character count, not a target: if the guard passes, the real token count is
 * below the documented limit.
 *
 * Measured on the current prompt: 5 636 characters (~1 400 tokens), well under
 * the 16 384-token ceiling. The guard exists so a future prompt edit fails at
 * build time rather than in a live session.
 */
const MAX_INSTRUCTION_CHARACTERS = MAX_INSTRUCTION_TOKENS * 3;

/**
 * The conversation prompt is deliberately the FULL VEYVRO prompt, not a
 * condensed variant: the voice must behave like the written assistant.
 *
 * It is also the prompt the delegated model receives, so the two never diverge.
 */

/**
 * Behavioural instructions for the *spoken* channel.
 *
 * The persona is inherited from the text prompt; this block only adds what only
 * makes sense out loud: brevity, no markdown, and the language rule. The
 * language rule never mentions changing voice — the chosen voice is kept across
 * languages, which is the point of a multilingual voice model.
 */
const CONVERSATION_INSTRUCTIONS = `
VOICE CHANNEL
- This is a spoken conversation. Answer in short, natural sentences that are easy to listen to. Aim for a few sentences and let the user ask for more.
- Never read out markdown, bullet symbols, URLs, code blocks, part numbers as a wall of characters, or emoji. Say things the way a person would say them.
- If a figure needs a unit, say the unit. If a figure is uncertain, say it is approximate.
- If the user interrupts, stop and listen. Do not repeat what was already said.
- Match the language the user is speaking right now, including when they switch mid-conversation. Keep the same voice: it is a multilingual voice, and switching language must never change how you sound.
- Never claim to be a human. If asked, say you are VEYVRO, an AI automotive assistant.
`.trim();

/**
 * Behavioural instructions for the *delegated backend*.
 *
 * The two prompts are not the same channel, and the documentation is explicit:
 * `instructions` at the top of the session styles the CONVERSATION (short
 * spoken turns), while `delegation.responses.instructions` is the BACKEND prompt
 * — the one that reasons, uses tools and returns substance. Sending the
 * conversation prompt to the backend (which the first version of this file did)
 * would have produced a backend trying to speak in short sentences instead of
 * computing the answer.
 *
 * The backend prompt is the real VEYVRO prompt — imported, never copied — plus
 * this block, which says what only makes sense on the backend side.
 */
const BACKEND_INSTRUCTIONS = `
DELEGATED BACKEND CHANNEL
- A spoken conversation is in progress. The user hears your answer read aloud by the voice model, so return the substance of the answer, not stage directions or formatting.
- Answer in the language the user is speaking. For a French-speaking user, answer in French; the same for English, Spanish and Portuguese.
- Be precise with figures: if a price, a mileage, a date or a reference is uncertain, say so explicitly instead of inventing it.
- If a question needs a document, a photo or a garage quote that the voice channel cannot capture, say what is missing and how to provide it in the app.
`.trim();

export type LiveSessionConfig = {
  model: string;
  instructions: string;
  audio: {
    output: { voice: string };
    /**
     * Transcription de la parole de l'utilisateur.
     *
     * Sans elle, le serveur n'a AUCUN moyen de connaître ce que l'utilisateur a
     * dit : le data channel ne transporte alors que la parole de l'assistant.
     * L'historique transmis à la session suivante (après un changement de voix)
     * ne contiendrait donc que les réponses de VEYVRO, et le fil serait perdu —
     * exactement le défaut à corriger.
     *
     * `whisper-1` est le modèle de transcription documenté pour l'entrée audio.
     */
    input: { transcription: { model: string } };
  };
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
 *   • `audio.input.transcription` — requested explicitly. The server cannot
 *     know what the user said otherwise, and the conversation memory that
 *     survives a voice change is built from those transcriptions.
 */
export function buildLiveSessionConfig(voice: LiveVoice): LiveSessionConfig {
  const instructions = `${VEYVRO_SYSTEM_PROMPT}\n\n${CONVERSATION_INSTRUCTIONS}`;
  if (instructions.length > MAX_INSTRUCTION_CHARACTERS) {
    throw new Error("Live instructions exceed the documented size limit.");
  }

  return {
    model: LIVE_MODEL,
    instructions,
    audio: {
      output: { voice: voice.id },
      input: { transcription: { model: LIVE_TRANSCRIPTION_MODEL } },
    },
    delegation: {
      type: "responses",
      responses: {
        model: LIVE_DELEGATION_MODEL,
        // The backend reasons; the voice model speaks. Same persona, different
        // channel: the personality is the imported VEYVRO prompt, the extra block
        // only states what belongs to the backend.
        instructions: `${VEYVRO_SYSTEM_PROMPT}\n\n${BACKEND_INSTRUCTIONS}`,
        reasoning: { effort: LIVE_DELEGATION_EFFORT },
      },
    },
    store: false,
  };
}

/**
 * The opening turn.
 *
 * A Live session starts listening, not talking: without this, the user opens the
 * microphone and hears silence while the model waits for them to speak first.
 * The documentation's "Greet before the caller speaks" recipe is a `developer`
 * message in `session.input`, which is exactly what this builds.
 *
 * The greeting is not hard-coded in one language: the app is French-first but
 * the voice must work in English, Spanish and Portuguese, so the message tells
 * the model to open in the user's language and gives the French wording it
 * should use when the language is not yet known.
 */
export function buildGreetingMessage(): {
  type: "message";
  role: "developer";
  content: Array<{ type: "input_text"; text: string }>;
} {
  return {
    type: "message",
    role: "developer",
    content: [
      {
        type: "input_text",
        text: [
          "Open the conversation now, without waiting for the user to speak.",
          "If the interface already told you which language to use, use it. Otherwise open in the language of the conversation above, and in French when there is no conversation yet.",
          "Say you are VEYVRO, the automotive assistant, in one short sentence, then ask what the user needs — a garage quote, a warning light, or a car to check.",
          "Then pause and listen. Keep it under about fifteen words, and do not read out any formatting.",
        ].join(" "),
      },
    ],
  };
}

/**
 * Previous conversation, seeded into the session.
 *
 * The documented shape is a list of messages with typed content. We only pass
 * text: the voice channel does not need the images or attachments of the text
 * thread, and sending them would cost tokens for no audible benefit.
 */
export type SessionInputMessage = {
  type: "message";
  role: "user" | "assistant" | "developer";
  content: Array<{ type: string; text: string }>;
};

export function buildSessionInput(
  history: Array<{ role: "user" | "assistant"; content: string }>,
  maxMessages = 12,
): SessionInputMessage[] {
  // The greeting goes first: it is what makes the assistant speak first. It is a
  // developer message, so it is trusted application instruction, never user text.
  const input: SessionInputMessage[] = [buildGreetingMessage()];

  const recent = history.slice(-maxMessages);
  const conversation = recent
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

  return [...input, ...conversation];
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
