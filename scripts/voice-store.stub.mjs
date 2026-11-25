/**
 * A faithful fake of the `voice_*` SQL functions, for the route tests.
 *
 * Why a fake and not the database: the tests must run without network and
 * without a Supabase project. Why *faithful*: the whole point of migration
 * `0004_voice_usage.sql` is that the guarantees live in the database, so a fake
 * that is more permissive than the SQL would let a regression pass.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  WHAT CHANGED IN v3, AND WHY THE FAKE HAD TO FOLLOW
 * ─────────────────────────────────────────────────────────────────────────────
 * The previous fake reserved a flat amount and capped billing at 3600 while the
 * route passed 3900. It therefore reproduced the very bug it was meant to
 * catch: an account with a minute left could open long sessions and overrun.
 * It now mirrors v3 branch by branch:
 *
 *   • the reservation is the WHOLE remaining allowance, bounded by the session
 *     ceiling and by the time left before UTC midnight — and it IS the ceiling;
 *   • settlement is bounded by the reservation, never by a separate number;
 *   • a reservation abandoned for `ttl` seconds is released, never a started one.
 *
 * The real SQL is proven separately, in a real PostgreSQL 16
 * (`scripts/sql/voice-usage.sql.test.mjs`), because a fake cannot validate a
 * migration.
 */

/** UTC day key, as the SQL computes it: `(now() at time zone 'utc')::date`. */
function utcDay(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 10);
}

/** Seconds from `nowMs` to the next UTC midnight, as the SQL computes it. */
function secondsUntilUtcMidnight(nowMs) {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
    0,
    0,
    0,
    0,
  );
  return Math.max(1, Math.floor((nextMidnight - nowMs) / 1_000));
}

/** Margin granted around an active session's reservation, as the SQL does. */
const LEASE_MARGIN_SECONDS = 300;

export function createVoiceStoreStub({ now = () => Date.now() } = {}) {
  /** `${userId}|${day}` → { consumed, reserved } */
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
    const hex = sequence.toString(16).padStart(12, "0");
    return `00000000-0000-4000-8000-${hex}`;
  }

  /**
   * Ceiling handed to the SQL. The SQL raises when it is missing; so does this
   * fake, because a fake that quietly substitutes a number would hide the
   * caller's mistake — the exact bug being fixed.
   */
  function ceiling(args, caller) {
    const value = Number(args.p_max_session_seconds);
    if (!Number.isFinite(value) || value <= 0) {
      throw new Error(`${caller}: p_max_session_seconds is required`);
    }
    return Math.trunc(value);
  }

  const rpc = {
    // ---------------------------------------------------------------------
    // Réservation : tout le crédit restant, borné par trois limites
    // ---------------------------------------------------------------------
    voice_reserve(args) {
      const nowMs = now();
      const userId = args.p_user_id;
      const allowance = Number(args.p_allowance_seconds ?? 0);
      const maxSession = ceiling(args, "voice_reserve");
      const minReservation = Math.max(1, Number(args.p_min_reservation_seconds ?? 60));
      const day = utcDay(nowMs);

      if (!Number.isFinite(Number(args.p_ttl_seconds)) || Number(args.p_ttl_seconds) <= 0) {
        throw new Error("voice_reserve: p_ttl_seconds is required");
      }

      if (allowance <= 0) {
        return {
          ok: false,
          kind: "voice_not_in_plan",
          used_seconds: 0,
          limit_seconds: 0,
          remaining_seconds: 0,
        };
      }

      // Libère les réservations abandonnées, jamais une session active.
      expireStale(userId, nowMs);

      // Une session active hors de sa réservation est close et facturée AVANT
      // que le crédit restant ne soit calculé.
      closeOverdue(userId, maxSession, nowMs);

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
      const room = allowance - row.consumed - row.reserved;

      // LES TROIS BORNES : le crédit restant, le plafond de session, et le
      // temps avant minuit UTC. La plus petite gagne — et c'est elle qui est
      // réservée, donc la session ne peut pas facturer davantage.
      const toMidnight = secondsUntilUtcMidnight(nowMs);
      const cap = Math.min(maxSession, room, toMidnight);

      if (room < minReservation) {
        return {
          ok: false,
          kind: "voice_minutes_exhausted",
          used_seconds: row.consumed + row.reserved,
          limit_seconds: allowance,
          remaining_seconds: Math.max(0, room),
        };
      }

      if (cap < minReservation) {
        // Moins d'une minute utile : refus explicite plutôt qu'une session de
        // quelques secondes.
        return {
          ok: false,
          kind: "voice_curfew",
          used_seconds: row.consumed + row.reserved,
          limit_seconds: allowance,
          remaining_seconds: Math.max(0, room),
          seconds_to_midnight: toMidnight,
        };
      }

      // Le contrôle et l'incrément sont inséparables : dans le SQL, la
      // condition est dans le `WHERE` de l'`UPDATE`.
      if (row.consumed + row.reserved + cap > allowance) {
        return {
          ok: false,
          kind: "voice_minutes_exhausted",
          used_seconds: row.consumed + row.reserved,
          limit_seconds: allowance,
          remaining_seconds: Math.max(0, allowance - row.consumed - row.reserved),
        };
      }

      row.reserved += cap;
      const id = nextId();
      sessions.set(id, {
        id,
        userId,
        voiceId: args.p_voice_id ?? "brise",
        usageDay: day,
        reservedSeconds: cap,
        state: "pending",
        // Aucun horodatage de facturation tant que `voice_activate` n'a pas été
        // appelé : c'est là que le chrono démarre.
        startedAt: null,
        leaseExpiresAt: nowMs + Number(args.p_ttl_seconds) * 1_000,
        closedAt: null,
        chargedSeconds: null,
        providerSessionId: null,
      });

      return {
        ok: true,
        session_id: id,
        state: "pending",
        reserved_seconds: cap,
        // La réservation EST la durée maximale facturable.
        max_session_seconds: cap,
        used_seconds: row.consumed + row.reserved,
        remaining_seconds: Math.max(0, allowance - (row.consumed + row.reserved)),
      };
    },

    // ---------------------------------------------------------------------
    // Activation : le chrono démarre ici
    // ---------------------------------------------------------------------
    voice_activate(args) {
      const nowMs = now();
      const maxSession = ceiling(args, "voice_activate");
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
      session.startedAt = nowMs;
      // Le bail couvre la réservation entière : une session active ne doit
      // jamais expirer avant d'avoir été facturée.
      session.leaseExpiresAt =
        nowMs + (Math.max(120, Math.min(session.reservedSeconds, maxSession)) + LEASE_MARGIN_SECONDS) * 1_000;
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
        nowMs + Math.max(120, Number(args.p_lease_seconds ?? 0)) * 1_000;
      return { ok: true, kind: "touched" };
    },

    voice_close_overdue(args) {
      return closeOverdue(args.p_user_id, ceiling(args, "voice_close_overdue"), now());
    },

    // ---------------------------------------------------------------------
    // Règlement : durée mesurée, bornée par la réservation
    // ---------------------------------------------------------------------
    voice_settle(args) {
      const nowMs = now();
      const maxSession = ceiling(args, "voice_settle");
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

      if (session.state === "pending") {
        row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
        session.state = "refunded";
        session.closedAt = nowMs;
        session.chargedSeconds = 0;
        return {
          ok: true,
          kind: "never_started",
          charged_seconds: 0,
          used_seconds: row.consumed,
        };
      }

      // LA DURÉE VIENT DE L'HORODATAGE, pas de l'appelant. Et la borne réelle
      // est la RÉSERVATION : `least(réservation, plafond)`, exactement comme
      // `voice_close_overdue`. C'est ce qui garantit le même montant par les
      // deux chemins.
      const bound = Math.min(session.reservedSeconds, maxSession);
      const measured = Math.max(0, Math.floor((nowMs - session.startedAt) / 1_000));
      const charge = Math.min(measured, bound);

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

  // -----------------------------------------------------------------------
  // Fonctions internes, miroirs de celles du SQL
  // -----------------------------------------------------------------------
  function expireStale(userId, nowMs) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.userId !== userId) continue;
      // Une session ACTIVE n'est jamais balayée par un bail.
      if (session.state !== "pending") continue;
      if (session.leaseExpiresAt >= nowMs) continue;
      session.state = "expired";
      session.closedAt = nowMs;
      session.chargedSeconds = 0;
      usageRow(userId, session.usageDay).reserved = Math.max(
        0,
        usageRow(userId, session.usageDay).reserved - session.reservedSeconds,
      );
      count += 1;
    }
    return count;
  }

  function closeOverdue(userId, maxSession, nowMs) {
    let count = 0;
    for (const session of sessions.values()) {
      if (session.userId !== userId) continue;
      if (session.state !== "active" || session.startedAt === null) continue;
      const bound = Math.min(session.reservedSeconds, maxSession);
      if (session.startedAt + bound * 1_000 > nowMs) continue;
      const row = usageRow(session.userId, session.usageDay);
      const measured = Math.max(0, Math.floor((nowMs - session.startedAt) / 1_000));
      const charge = Math.min(measured, bound);
      row.reserved = Math.max(0, row.reserved - session.reservedSeconds);
      row.consumed += charge;
      session.state = "settled";
      session.closedAt = nowMs;
      session.chargedSeconds = charge;
      count += 1;
    }
    return count;
  }

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
    /** Inspect one session row the way a support engineer would. */
    session(sessionId) {
      return sessions.get(sessionId);
    },
    /** Move the clock-backed `started_at` back, to simulate a long session. */
    rewindActive(sessionId, seconds) {
      const session = sessions.get(sessionId);
      if (session && session.startedAt !== null) {
        session.startedAt -= seconds * 1_000;
      }
      return session;
    },
  };
}
