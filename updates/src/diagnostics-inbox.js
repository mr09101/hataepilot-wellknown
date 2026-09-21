import { DIAGNOSTIC_BYTES, RETENTION_MS, parseDiagnostic } from "./diagnostics-schema.js";

export const DIAGNOSTIC_LIMITS = Object.freeze({ uploadDay: 20, uploadMonth: 200, readDay: 100, readMonth: 1000 });
const json = (status, body, headers = {}) => Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
export class DiagnosticsInbox {
  constructor(ctx) {
    this.ctx = ctx; this.sql = ctx.storage.sql; this.now = () => Date.now();
    this.sql.exec("CREATE TABLE IF NOT EXISTS diagnostic_reports (id TEXT PRIMARY KEY, received INTEGER NOT NULL, expires INTEGER NOT NULL, payload TEXT NOT NULL)");
    this.sql.exec("CREATE TABLE IF NOT EXISTS diagnostic_budget (kind TEXT PRIMARY KEY, day TEXT NOT NULL, month TEXT NOT NULL, daily INTEGER NOT NULL, monthly INTEGER NOT NULL)");
  }
  prune(now) { this.sql.exec("DELETE FROM diagnostic_reports WHERE expires <= ?", now); }
  reserve(kind, now) {
    const day = new Date(now).toISOString().slice(0, 10), month = day.slice(0, 7);
    const old = [...this.sql.exec("SELECT * FROM diagnostic_budget WHERE kind = ?", kind)][0];
    if (old && old.day > day) return false;
    const daily = (old?.day === day ? old.daily : 0) + 1;
    const monthly = (old?.month === month ? old.monthly : 0) + 1;
    if (daily > DIAGNOSTIC_LIMITS[`${kind}Day`] || monthly > DIAGNOSTIC_LIMITS[`${kind}Month`]) return false;
    this.sql.exec("INSERT OR REPLACE INTO diagnostic_budget (kind, day, month, daily, monthly) VALUES (?, ?, ?, ?, ?)", kind, day, month, daily, monthly);
    return true;
  }
  async schedule() {
    const next = [...this.sql.exec("SELECT MIN(expires) AS expires FROM diagnostic_reports")][0]?.expires;
    if (next != null) {
      if (await this.ctx.storage.getAlarm() !== next) await this.ctx.storage.setAlarm(next);
    }
    else if (await this.ctx.storage.getAlarm() != null) await this.ctx.storage.deleteAlarm();
  }
  async alarm() { this.prune(this.now()); await this.schedule(); }
  async fetch(request) {
    if (new URL(request.url).pathname !== "/reports") return json(404, { ok: false, code: "not_found" });
    let report;
    if (request.method === "POST") {
      try {
        if (Number(request.headers.get("content-length") || 0) > DIAGNOSTIC_BYTES) throw Error("too_large");
        report = parseDiagnostic(await request.text(), this.now());
      } catch { return json(400, { ok: false, code: "invalid_report" }); }
    } else if (!["GET", "DELETE"].includes(request.method)) return json(405, { ok: false, code: "method_not_allowed" });
    try {
      // Establish deletion scheduling BEFORE any new payload is committed. If scheduling
      // fails, no report is retained. Existing earlier alarms must never be postponed.
      if (report) {
        // Count every valid attempt, even when later storage/alarm work fails. Reject
        // over-budget requests before they can create/delete alarms on an empty inbox.
        if (!this.ctx.storage.transactionSync(() => this.reserve("upload", this.now())))
          return json(429, { ok: false, code: "quota_exceeded" });
        const earliest = [...this.sql.exec("SELECT MIN(expires) AS expires FROM diagnostic_reports")][0]?.expires;
        const next = Math.min(earliest ?? Infinity, this.now() + RETENTION_MS);
        const current = await this.ctx.storage.getAlarm();
        if (current == null || current > next) await this.ctx.storage.setAlarm(next);
      }
      const response = this.ctx.storage.transactionSync(() => {
        const now = this.now(); this.prune(now);
        if (report) {
          const payload = JSON.stringify(report);
          const existing = [...this.sql.exec("SELECT * FROM diagnostic_reports WHERE id = ?", report.id)][0];
          if (existing) {
            if (existing.payload !== payload) return json(409, { ok: false, code: "report_id_conflict" });
            return json(200, { ok: true, id: existing.id, receivedAtMs: existing.received, expiresAtMs: existing.expires });
          }
          this.sql.exec("INSERT INTO diagnostic_reports (id, received, expires, payload) VALUES (?, ?, ?, ?)", report.id, now, now + RETENTION_MS, payload);
          this.sql.exec("DELETE FROM diagnostic_reports WHERE id NOT IN (SELECT id FROM diagnostic_reports ORDER BY received DESC, rowid DESC LIMIT 5)");
          return json(201, { ok: true, id: report.id, receivedAtMs: now, expiresAtMs: now + RETENTION_MS });
        }
        if (!this.reserve("read", now)) return json(429, { ok: false, code: "quota_exceeded" });
        if (request.method === "DELETE") {
          this.sql.exec("DELETE FROM diagnostic_reports");
          return json(200, { ok: true });
        }
        const reports = [...this.sql.exec("SELECT * FROM diagnostic_reports ORDER BY received DESC, rowid DESC LIMIT 5")]
          .map(row => ({ id: row.id, receivedAtMs: row.received, expiresAtMs: row.expires, report: JSON.parse(row.payload) }));
        return json(200, { ok: true, reports });
      });
      await this.schedule();
      return response;
    } catch { return json(503, { ok: false, code: "diagnostics_unavailable" }); }
  }
}
