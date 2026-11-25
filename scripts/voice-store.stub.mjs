/**
 * A faithful fake of the `voice_*` SQL functions, for the route tests.
 *
 * Why a fake and not the database: the tests must run without network and
 * without a Supabase project. Why *faithful*: the whole point of migration
 * `0004_voice_usage.sql` is that the guarantees live in the database, so a fake
 * that is more permissive than the SQL would let a regression pass.
 *
 * Each function below mirrors the corresponding SQL branch by branch —
 * including the ones that are easy to get wrong:
 *   • `voice_session_open` is checked BEFORE the allowance, like the SQL;
 *   • a refused reservation leaves no trace (the SQL's exception block);
 *   • `voice_settle` on an already-settled session returns the first charge;
 *   • `voice_refund` on anything not `open` is a no-op.
 *
 * The real SQL is proven separately, in a real PostgreSQL 16
 * (`scripts/sql/voice-usage.sql.test.mjs`), because a fake cannot validate a
 * migration.
 */

/** UTC day key, as the SQL computes it: `(now() at time zone 'utc')::date`. */
function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

export function createVoiceStoreStub({ now = () => Date.now() } = {}) {
  /** `${userId}|` → Map(day → { consumed, reserved }) */
  const usage = new Map();
  /** sessionId → session row */
  const sessions = new Map();
  let sequence = 0;

  function usageRow(userId, day) {
    const key = `${userId}|${day}`;
    if (!usage.has(key)) usage.set(key, { consumed: 0, reserved: 0 });
    return usage.get(key);
  }

  function nextId() {
    sequence += 1;
    // A deterministic UUID v4 shape: the route validates the format.
    const hex = sequence.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  }

  function expireStale(userId, nowMs) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.userId !== userId) continue;
      if (session.state !== "open") continue;
      if (session.reservationExpiresAt >= nowMs) continue;
      session.state = "expired";
      session.closedAt = nowMs;
      session.chargedSeconds = 0;
      const row = usageRow(userId, session.usageDay);
      row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
      count += 1;
    }
    return count;
  }

  const rpc = {
    voice_reserve(args) {
      const nowMs = now();
      const userId = args.p_user_id;
      const allowance = Number(args.p_allowance_seconds ?? 0);
      const reserve = Number(args.p_reserve_seconds ?? 0);
      const day = utcDay(nowMs);

      if (allowance <= 0) {
        return { ok: false, kind: "voice_not_in_plan", used_seconds: 0, limit_seconds: 0 };
      }

      expireStale(userId, nowMs);

      const open = [...sessions.values()].find((s) => s.userId === userId && s.state === "open");
      if (open) {
        return {
          ok: false,
          kind: "voice_session_open",
          open_session_id: open.id,
          retry_after_seconds: Math.max(
            1,
            Math.ceil((open.reservationExpiresAt - nowMs) / 1_000),
          ),
        };
      }

      const row = usageRow(userId, day);
      if (row.consumed + row.reserved + reserve > allowance) {
        return {
          ok: false,
          kind: "voice_minutes_exhausted",
          used_seconds: row.consumed + row.reserved,
          limit_seconds: allowance,
        };
      }

      // The increment happens only if the session can be created: the SQL does
      // both in one protected block.
      row.reserved += reserve;
      const id = nextId();
      sessions.set(id, {
        id,
        userId,
        voiceId: args.p_voice_id ?? "brise",
        usageDay: day,
        reservedSeconds: reserve,
        state: "open",
        startedAt: nowMs,
        reservationExpiresAt: nowMs + Math.max(60, Number(args.p_ttl_seconds ?? 3_600)) * 1_000,
        closedAt: null,
        chargedSeconds: null,
      });

      return {
        ok: true,
        session_id: id,
        reserved_seconds: reserve,
        used_seconds: row.consumed + row.reserved,
        remaining_seconds: Math.max(0, allowance - (row.consumed + row.reserved)),
      };
    },

    voice_settle(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      if (session.state === "settled") {
        const row = usageRow(session.userId, session.usageDay);
        return {
          ok: true,
          kind: "already_settled",
          charged_seconds: session.chargedSeconds ?? 0,
          used_seconds: row.consumed,
        };
      }
      if (session.state === "refunded" || session.state === "expired") {
        return { ok: true, kind: "already_released", charged_seconds: 0 };
      }

      const charge = Math.max(0, Math.round(Number(args.p_actual_seconds ?? 0)));
      const row = usageRow(session.userId, session.usageDay);
      row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
      row.consumed += charge;
      session.state = "settled";
      session.closedAt = nowMs;
      session.chargedSeconds = charge;
      return {
        ok: true,
        kind: "settled",
        charged_seconds: charge,
        used_seconds: row.consumed,
      };
    },

    voice_refund(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      if (session.state !== "open") {
        return { ok: true, kind: "already_released", charged_seconds: 0 };
      }
      const row = usageRow(session.userId, session.usageDay);
      row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
      session.state = "refunded";
      session.closedAt = nowMs;
      session.chargedSeconds = 0;
      return { ok: true, kind: "refunded", charged_seconds: 0 };
    },

    voice_usage_read(args) {
      const nowMs = now();
      const day = utcDay(nowMs);
      const row = usageRow(args.p_user_id, day);
      return { day, consumed_seconds: row.consumed, reserved_seconds: row.reserved };
    },

    voice_expire_stale(args) {
      return expireStale(args.p_user_id, now());
    },
  };

  /** The `fetch` implementation to install for Supabase RPC calls. */
  const fetch = async (input, init = {}) => {
    const url = String(input);
    const match = url.match(/\/rest\/v1\/rpc\/([a-z_]+)$/);
    if (!match) throw new Error(`unexpected supabase call: ${url}`);
    const name = match[1];
    const handler = rpc[name];
    if (!handler) throw new Error(`unknown rpc: ${name}`);
    const args = init.body ? JSON.parse(String(init.body)) : {};
    const payload = handler(args);
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  return {
    rpc,
    fetch,
    sessions,
    usage,
    /** Seconds consumed today for an account. */
    consumed(userId, nowMs = now()) {
      return usageRow(userId, utcDay(nowMs)).consumed;
    },
    /** Seconds reserved today for an account. */
    reserved(userId, nowMs = now()) {
      return usageRow(userId, utcDay(nowMs)).reserved;
    },
    openSessions(userId) {
      return [...sessions.values()].filter((s) => s.userId === userId && s.state === "open");
    },
  };
}
