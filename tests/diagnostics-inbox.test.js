import assert from "node:assert/strict";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { DiagnosticsInbox } from "../updates/src/diagnostics-inbox.js";
import { SNAPSHOT_BOOLS, RETENTION_MS, parseDiagnostic } from "../updates/src/diagnostics-schema.js";

const start = 1800000000000;
const report = (n = 1, now = start) => ({ schema: 1, id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`,
  createdAtMs: now, versionCode: 30, androidSdk: 36,
  snapshot: { ...Object.fromEntries(SNAPSHOT_BOOLS.map(k => [k, false])), carConnected: null, kakaoPhase: "OFF" },
  events: [{ at: now, stage: "LIFECYCLE", kind: "SYSTEM", reason: "VEHICLE_EXIT_CHECK", component: "DRIVE",
    backend: "NONE", version: 30, run: "", id: "", mode: 0, volume: 100,
    context: { vehicleParked: true, vehiclePresent: false, driverDoorOpen: true, vehicleLocked: null, vehicleAgeMs: 20 } }] });
function harness() {
  const db = new DatabaseSync(":memory:"); let alarm = null;
  const storage = { sql: { exec(query, ...params) { return db.prepare(query).all(...params); } },
    transactionSync(fn) { db.exec("BEGIN"); try { const r = fn(); db.exec("COMMIT"); return r; } catch (e) { db.exec("ROLLBACK"); throw e; } },
    async getAlarm() { return alarm; }, async setAlarm(at) { alarm = at; }, async deleteAlarm() { alarm = null; } };
  const inbox = new DiagnosticsInbox({ storage }); let now = start; inbox.now = () => now;
  return { inbox, storage, setTime(at) { now = at; }, alarm: () => alarm, close: () => db.close(),
    async call(method = "GET", r = null) { return inbox.fetch(new Request("https://diagnostics.invalid/reports", {
      method, ...(r ? { body: JSON.stringify(r) } : {}) })); } };
}
test("inbox keeps only latest five, expires by server receipt and does not extend retry TTL", async () => {
  const h = harness();
  try {
    for (let n = 1; n <= 6; n++) { h.setTime(start + n * 1000); assert.equal((await h.call("POST", report(n))).status, 201); }
    const first = (await (await h.call()).json()).reports;
    assert.equal(first.length, 5); assert.equal(first[0].id, report(6).id);
    assert.equal(h.alarm(), start + 2000 + RETENTION_MS);
    h.setTime(start + 10000); assert.equal((await h.call("POST", report(6))).status, 200);
    assert.equal((await (await h.call()).json()).reports[0].receivedAtMs, start + 6000);
    assert.equal((await h.call("POST", { ...report(6), versionCode: 31 })).status, 409);
    h.setTime(start + 4000 + RETENTION_MS); await h.inbox.alarm();
    assert.equal((await (await h.call()).json()).reports.length, 2);
    assert.equal(h.alarm(), start + 5000 + RETENTION_MS);
    h.setTime(start + 6000 + RETENTION_MS); await h.inbox.alarm();
    assert.equal((await (await h.call()).json()).reports.length, 0); assert.equal(h.alarm(), null);
  } finally { h.close(); }
});
test("identical retries spend request budget without extending retention", async () => {
  const h = harness();
  try {
    for (let n = 0; n < 20; n++) assert.equal((await h.call("POST", report())).status, n ? 200 : 201);
    assert.equal((await h.call("POST", report())).status, 429);
    assert.equal((await (await h.call()).json()).reports.length, 1);
    assert.equal(h.alarm(), start + RETENTION_MS);
  } finally { h.close(); }
});
test("alarm failure cannot leave a new payload without scheduled deletion", async () => {
  const h = harness();
  try {
    h.storage.setAlarm = async () => { throw Error("injected alarm failure"); };
    assert.equal((await h.call("POST", report())).status, 503);
    assert.equal((await (await h.call()).json()).reports.length, 0);
  } finally { h.close(); }
});
test("over-budget submissions to an empty inbox perform no alarm writes", async () => {
  const h = harness();
  try {
    for (let n = 0; n < 20; n++) await h.call("POST", report());
    await h.call("DELETE");
    let writes = 0;
    h.storage.setAlarm = h.storage.deleteAlarm = async () => { writes++; };
    for (let n = 0; n < 5; n++) assert.equal((await h.call("POST", report())).status, 429);
    assert.equal(writes, 0);
  } finally { h.close(); }
});
test("20 per day and 200 per month apply even after data deletion; reads are bounded separately", async () => {
  const h = harness();
  try {
    let n = 0;
    for (let d = 0; d < 10; d++) {
      const at = start + d * 86400000; h.setTime(at);
      for (let k = 0; k < 20; k++) assert.equal((await h.call("POST", report(++n, at))).status, 201);
      assert.equal((await h.call("POST", report(++n, at))).status, 429);
      assert.equal((await h.call("DELETE")).status, 200);
    }
    h.setTime(start + 10 * 86400000);
    assert.equal((await h.call("POST", report(++n, start + 10 * 86400000))).status, 429);
    for (let k = 0; k < 100; k++) assert.equal((await h.call()).status, 200);
    assert.equal((await h.call()).status, 429);
  } finally { h.close(); }
});
test("wire schema rejects private or arbitrary fields, invalid enums, stale and oversized records", () => {
  assert.doesNotThrow(() => parseDiagnostic(JSON.stringify(report()), start));
  for (const mutate of [r => { r.vin = "secret"; }, r => { r.events[0].text = "address"; },
    r => { r.events[0].context.cameraId = 12; }, r => { r.snapshot.latitude = 37.1; },
    r => { r.events[0].reason = "raw exception"; }, r => { r.createdAtMs = start - RETENTION_MS - 1; },
    r => { r.events = Array(201).fill(r.events[0]); }, r => { r.events[0].context.vehiclePresent = "false"; }]) {
    const r = report(); mutate(r); assert.throws(() => parseDiagnostic(JSON.stringify(r), start));
  }
  assert.throws(() => parseDiagnostic(" ".repeat(128 * 1024 + 1), start));
});
