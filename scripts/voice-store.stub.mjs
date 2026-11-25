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
      if (session.state !== "pending") continue;
      if (session.leaseExpiresAt >= nowMs) continue;
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

      const open = [...sessions.values()].find(
        (s) => s.userId === userId && (s.state === "pending" || s.state === "active"),
      );
      if (open) {
        return {
          ok: false,
          kind: "voice_session_open",
          open_session_id: open.id,
          open_state: open.state,
          retry_after_seconds: Math.max(1, Math.ceil((open.leaseExpiresAt - nowMs) / 1_000)),
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
        state: "pending",
        // Aucun horodatage de facturation tant que voice_activate n'a pas été
        // appelé : c'est là que le chrono démarre.
        startedAt: null,
        leaseExpiresAt: nowMs + Math.max(30, Number(args.p_ttl_seconds ?? 300)) * 1_000,
        closedAt: null,
        chargedSeconds: null,
        providerSessionId: null,
      });

      return {
        ok: true,
        session_id: id,
        reserved_seconds: reserve,
        used_seconds: row.consumed + row.reserved,
        remaining_seconds: Math.max(0, allowance - (row.consumed + row.reserved)),
      };
    },

    voice_activate(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      if (session.state === "active") {
        // Idempotent : `started_at` ne recule pas.
        return { ok: true, kind: "already_active" };
      }
      if (session.state !== "pending") {
        return { ok: false, kind: "not_pending", state: session.state };
      }
      session.state = "active";
      // C'est ICI que le chrono démarre, pas à la réservation.
      session.startedAt = nowMs;
      session.leaseExpiresAt =
        nowMs + Math.max(120, Number(args.p_lease_seconds ?? 3_900)) * 1_000;
      session.providerSessionId = args.p_provider_session_id ?? null;
      return { ok: true, kind: "activated" };
    },

    voice_touch(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      if (session.state !== "active") {
        return { ok: false, kind: "not_active", state: session.state };
      }
      session.leaseExpiresAt =
        nowMs + Math.max(120, Number(args.p_lease_seconds ?? 3_900)) * 1_000;
      return { ok: true, kind: "touched" };
    },

    voice_close_overdue(args) {
      const nowMs = now();
      const max = Math.max(60, Number(args.p_max_session_seconds ?? 3_600));
      let count = 0;
      for (const session of sessions.values()) {
        if (session.state !== "active" || session.startedAt === null) continue;
        if (typeof args.p_user_id === "string" && session.userId !== args.p_user_id) continue;
        if (session.startedAt + max * 1_000 > nowMs) continue;
        const row = usageRow(session.userId, session.usageDay);
        row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
        row.consumed += max;
        session.state = "settled";
        session.closedAt = nowMs;
        session.chargedSeconds = max;
        count += 1;
      }
      return count;
    },

    voice_settle(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      const row = usageRow(session.userId, session.usageDay);

      if (session.state === "settled") {
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

      // Réservation jamais activée : rien ne s'est passé.
      if (session.state === "pending") {
        row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
        session.state = "refunded";
        session.closedAt = nowMs;
        session.chargedSeconds = 0;
        return { ok: true, kind: "never_started", charged_seconds: 0, used_seconds: row.consumed };
      }

      // LA DURÉE VIENT DE L'HORODATAGE, pas de l'appelant.
      const max = Math.max(60, Number(args.p_max_session_seconds ?? 3_600));
      const measured = Math.max(0, Math.floor((nowMs - session.startedAt) / 1_000));
      const charge = Math.min(measured, max);

      row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
      row.consumed += charge;
      session.state = "settled";
      session.closedAt = nowMs;
      session.chargedSeconds = charge;
      return {
        ok: true,
        kind: "settled",
        charged_seconds: charge,
        measured_seconds: measured,
        used_seconds: row.consumed,
      };
    },

    voice_refund(args) {
      const nowMs = now();
      const session = sessions.get(args.p_session_id);
      if (!session || session.userId !== args.p_user_id) {
        return { ok: false, kind: "unknown_session" };
      }
      if (session.state !== "pending" && session.state !== "active") {
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
      return [...sessions.values()].filter(
        (s) => s.userId === userId && (s.state === "pending" || s.state === "active"),
      );
    },
  };
}
