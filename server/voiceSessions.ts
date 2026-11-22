/**
 * In-memory registry of open voice sessions.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHY A REGISTRY RATHER THAN TRUSTING THE CLIENT
 * ─────────────────────────────────────────────────────────────────────────────
 * A Live session is billed by duration. If the browser sent its own duration
 * when closing, a user could simply report "3 seconds" for a ten-minute
 * conversation. The registry is the cheap authoritative record: the session is
 * created here when `/api/voice-session` succeeds, and the duration is computed
 * here when `/api/voice-end` runs.
 *
 * Known limitation, stated plainly (same as the existing quotas): the registry
 * lives in one serverless instance. A session opened on instance A and closed on
 * instance B cannot be found, in which case the route falls back to the
 * reservation and says so — it never silently charges nothing. The real ceiling
 * remains the plan's daily allowance and OpenAI's own account limit.
 */

import crypto from "node:crypto";

/** A session is forgotten this long after its last activity, whatever happens. */
const ENTRY_TTL_MS = 2 * 60 * 60_000;

/** A Live session cannot exceed 60 minutes: past that, the record is stale. */
const MAX_SESSION_MS = 65 * 60_000;

const MAX_TRACKED_SESSIONS = 2_000;

export type VoiceSessionRecord = {
  /** OpenAI session id, when the response provided one. */
  providerSessionId: string | null;
  userId: string;
  voiceId: string;
  reservedSeconds: number;
  /** Epoch ms at creation — the authoritative start of billing. */
  startedAt: number;
  lastSeenAt: number;
  closed: boolean;
  /** Epoch ms of the first close, so a second close cannot lengthen the session. */
  closedAt: number | null;
};

const sessions = new Map<string, VoiceSessionRecord>();

function prune(nowMs: number) {
  for (const [id, record] of sessions) {
    const tooOld = nowMs - record.lastSeenAt > ENTRY_TTL_MS;
    const tooLong = nowMs - record.startedAt > MAX_SESSION_MS;
    if (tooOld || tooLong) sessions.delete(id);
  }
  if (sessions.size <= MAX_TRACKED_SESSIONS) return;
  const ordered = [...sessions.entries()].sort((a, b) => a[1].lastSeenAt - b[1].lastSeenAt);
  for (const [id] of ordered.slice(0, sessions.size - MAX_TRACKED_SESSIONS)) {
    sessions.delete(id);
  }
}

/** Register a session that was just created upstream. */
export function openVoiceSession(options: {
  userId: string;
  voiceId: string;
  reservedSeconds: number;
  providerSessionId?: string | null;
  nowMs?: number;
}): { id: string; record: VoiceSessionRecord } {
  const nowMs = options.nowMs ?? Date.now();
  prune(nowMs);
  const id = crypto.randomUUID();
  const record: VoiceSessionRecord = {
    providerSessionId: options.providerSessionId ?? null,
    userId: options.userId,
    voiceId: options.voiceId,
    reservedSeconds: options.reservedSeconds,
    startedAt: nowMs,
    lastSeenAt: nowMs,
    closed: false,
    closedAt: null,
  };
  sessions.set(id, record);
  return { id, record };
}

/** Look a session up. Returns `null` when unknown, or when it belongs to someone else. */
export function findVoiceSession(
  id: string,
  userId: string,
  nowMs = Date.now(),
): VoiceSessionRecord | null {
  const record = sessions.get(id);
  if (!record) return null;
  // Ownership is checked here, not by the caller: a session id must never let
  // one account close — or learn about — another account's session.
  if (record.userId !== userId) return null;
  if (nowMs - record.startedAt > MAX_SESSION_MS) return null;
  record.lastSeenAt = nowMs;
  return record;
}

/**
 * Mark a session closed and return its real duration.
 *
 * Idempotent: a second call returns the duration recorded at the first close, so
 * a double beacon (tab hidden, then closed) cannot charge twice.
 */
export function closeVoiceSession(
  id: string,
  userId: string,
  nowMs = Date.now(),
): { durationSeconds: number; actualSeconds: number; record: VoiceSessionRecord } | null {
  const record = findVoiceSession(id, userId, nowMs);
  if (!record) return null;
  if (record.closed) {
    // The session is over: report the duration recorded at the first close,
    // whatever time this second call arrives. A late beacon must not bill more.
    const recorded = Math.floor(((record.closedAt ?? record.startedAt) - record.startedAt) / 1_000);
    record.lastSeenAt = nowMs;
    return { durationSeconds: recorded, actualSeconds: -1, record };
  }
  const durationSeconds = Math.max(0, Math.floor((nowMs - record.startedAt) / 1_000));
  record.closed = true;
  record.closedAt = nowMs;
  record.lastSeenAt = nowMs;
  return { durationSeconds, actualSeconds: durationSeconds, record };
}

/** Test hook. */
export function resetVoiceSessions(): void {
  sessions.clear();
}
