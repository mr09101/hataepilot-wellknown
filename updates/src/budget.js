import { MAX_APK_BYTES } from "./manifest.js";

export const BUDGET_LIMITS = Object.freeze({
  lookupDaily: 100,
  lookupMonthly: 1000,
  downloadDaily: 4,
  downloadMonthly: 20,
  downloadBytesMonthly: 4 * 1024 * 1024 * 1024,
});

const CREATE_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS update_budget (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    day_key TEXT NOT NULL,
    month_key TEXT NOT NULL,
    lookup_daily INTEGER NOT NULL CHECK (lookup_daily >= 0),
    lookup_monthly INTEGER NOT NULL CHECK (lookup_monthly >= 0),
    download_daily INTEGER NOT NULL CHECK (download_daily >= 0),
    download_monthly INTEGER NOT NULL CHECK (download_monthly >= 0),
    download_bytes_monthly INTEGER NOT NULL CHECK (download_bytes_monthly >= 0)
  )
`;

const SELECT_SQL = `
  SELECT day_key, month_key, lookup_daily, lookup_monthly,
         download_daily, download_monthly, download_bytes_monthly
    FROM update_budget
   WHERE singleton = 1
`;

const INSERT_SQL = `
  INSERT INTO update_budget (
    singleton, day_key, month_key, lookup_daily, lookup_monthly,
    download_daily, download_monthly, download_bytes_monthly
  ) VALUES (1, ?, ?, ?, ?, ?, ?, ?)
`;

const UPDATE_SQL = `
  UPDATE update_budget
     SET day_key = ?, month_key = ?, lookup_daily = ?, lookup_monthly = ?,
         download_daily = ?, download_monthly = ?, download_bytes_monthly = ?
   WHERE singleton = 1
`;

function jsonResponse(status, value, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "X-Content-Type-Options": "nosniff",
      ...extraHeaders,
    },
  });
}

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function periodKeys(nowMs) {
  const iso = new Date(nowMs).toISOString();
  return { dayKey: iso.slice(0, 10), monthKey: iso.slice(0, 7) };
}

function emptyState(dayKey, monthKey) {
  return {
    day_key: dayKey,
    month_key: monthKey,
    lookup_daily: 0,
    lookup_monthly: 0,
    download_daily: 0,
    download_monthly: 0,
    download_bytes_monthly: 0,
  };
}

function resetForPeriod(row, dayKey, monthKey) {
  if (!row) return emptyState(dayKey, monthKey);
  return {
    day_key: dayKey,
    month_key: monthKey,
    lookup_daily: row.day_key === dayKey ? Number(row.lookup_daily) : 0,
    lookup_monthly: row.month_key === monthKey ? Number(row.lookup_monthly) : 0,
    download_daily: row.day_key === dayKey ? Number(row.download_daily) : 0,
    download_monthly: row.month_key === monthKey ? Number(row.download_monthly) : 0,
    download_bytes_monthly: row.month_key === monthKey ? Number(row.download_bytes_monthly) : 0,
  };
}

function nextDayStart(nowMs) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
}

function nextMonthStart(nowMs) {
  const now = new Date(nowMs);
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
}

function secondsUntil(timestamp, nowMs) {
  return Math.max(1, Math.ceil((timestamp - nowMs) / 1000));
}

function applyReservation(state, kind, bytes) {
  const next = { ...state };
  if (kind === "lookup") {
    next.lookup_daily += 1;
    next.lookup_monthly += 1;
  } else {
    next.download_daily += 1;
    next.download_monthly += 1;
    next.download_bytes_monthly += bytes;
  }
  return next;
}

function blockingReset(next, nowMs) {
  const resetTimes = [];
  if (next.lookup_daily > BUDGET_LIMITS.lookupDaily || next.download_daily > BUDGET_LIMITS.downloadDaily) {
    resetTimes.push(nextDayStart(nowMs));
  }
  if (next.lookup_monthly > BUDGET_LIMITS.lookupMonthly
      || next.download_monthly > BUDGET_LIMITS.downloadMonthly
      || next.download_bytes_monthly > BUDGET_LIMITS.downloadBytesMonthly) {
    resetTimes.push(nextMonthStart(nowMs));
  }
  return resetTimes.length === 0 ? null : Math.max(...resetTimes);
}

function valuesForWrite(state) {
  return [
    state.day_key,
    state.month_key,
    state.lookup_daily,
    state.lookup_monthly,
    state.download_daily,
    state.download_monthly,
    state.download_bytes_monthly,
  ];
}

export class UpdateBudget {
  constructor(ctx) {
    this.ctx = ctx;
    this.sql = ctx.storage.sql;
    this.now = () => Date.now();
    this.sql.exec(CREATE_TABLE_SQL);
  }

  reserve(kind, bytes) {
    const nowMs = this.now();
    if (!Number.isFinite(nowMs)) throw new Error("invalid_clock");
    const { dayKey, monthKey } = periodKeys(nowMs);

    return this.ctx.storage.transactionSync(() => {
      const cursor = this.sql.exec(SELECT_SQL);
      const row = [...cursor][0] ?? null;
      const state = resetForPeriod(row, dayKey, monthKey);
      const next = applyReservation(state, kind, bytes);
      const resetAt = blockingReset(next, nowMs);
      if (resetAt !== null) {
        return { ok: false, retryAfter: secondsUntil(resetAt, nowMs) };
      }

      if (row) this.sql.exec(UPDATE_SQL, ...valuesForWrite(next));
      else this.sql.exec(INSERT_SQL, ...valuesForWrite(next));
      return { ok: true };
    });
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/reserve") return jsonResponse(404, { ok: false, code: "not_found" });
    if (request.method !== "POST") return jsonResponse(405, { ok: false, code: "method_not_allowed" }, { Allow: "POST" });

    const declaredLength = request.headers.get("content-length");
    if (declaredLength && (!/^\d+$/.test(declaredLength) || Number(declaredLength) > 256)) {
      return jsonResponse(413, { ok: false, code: "body_too_large" });
    }

    let body;
    try {
      const text = await request.text();
      if (new TextEncoder().encode(text).byteLength > 256) {
        return jsonResponse(413, { ok: false, code: "body_too_large" });
      }
      body = JSON.parse(text);
    } catch {
      return jsonResponse(400, { ok: false, code: "invalid_request" });
    }

    if (!hasExactKeys(body, ["bytes", "kind"])) {
      return jsonResponse(400, { ok: false, code: "invalid_request" });
    }
    if (body.kind === "lookup") {
      if (body.bytes !== 0) return jsonResponse(400, { ok: false, code: "invalid_request" });
    } else if (body.kind === "download") {
      if (!Number.isSafeInteger(body.bytes) || body.bytes <= 0 || body.bytes > MAX_APK_BYTES) {
        return jsonResponse(400, { ok: false, code: "invalid_request" });
      }
    } else {
      return jsonResponse(400, { ok: false, code: "invalid_request" });
    }

    try {
      const result = this.reserve(body.kind, body.bytes);
      if (!result.ok) {
        return jsonResponse(429, { ok: false, code: "quota_exceeded" }, {
          "Retry-After": String(result.retryAfter),
        });
      }
      return jsonResponse(200, { ok: true });
    } catch {
      return jsonResponse(503, { ok: false, code: "budget_unavailable" });
    }
  }
}
