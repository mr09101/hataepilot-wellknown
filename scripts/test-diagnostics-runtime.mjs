import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { SNAPSHOT_BOOLS } from "../updates/src/diagnostics-schema.js";
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(process.env.MINIFLARE_MODULE || "miniflare");
const device = Buffer.alloc(32, 1).toString("base64url"), admin = Buffer.alloc(32, 2).toString("base64url");
const hash = s => createHash("sha256").update(s).digest("hex");
const options = { modules: true, scriptPath: "updates/build/diagnostics-worker/worker.js", compatibilityDate: "2026-09-09",
  durableObjects: { DIAGNOSTICS_INBOX: { className: "DiagnosticsInbox", useSQLite: true }, UPDATE_BUDGET: { className: "UpdateBudget", useSQLite: true } },
  bindings: { UPDATE_TOKEN_SHA256: hash(device), DIAGNOSTICS_READ_TOKEN_SHA256: hash(admin) },
  outboundService: async () => { throw Error("No external network allowed in runtime tests"); } };
const mf = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
const request = async (method, token, data) => mf.dispatchFetch("https://hataepilot.com/updates/diagnostics", {
  method, headers: { Authorization: `Bearer ${token}`, ...(data ? { "Content-Type": "application/json" } : {}) },
  ...(data ? { body: JSON.stringify(data) } : {}) });
try {
  const report = { schema: 1, id: "00000000-0000-4000-8000-000000000001", createdAtMs: Date.now(), versionCode: 30, androidSdk: 36,
    snapshot: { ...Object.fromEntries(SNAPSHOT_BOOLS.map(k => [k, false])), carConnected: null, kakaoPhase: "OFF" }, events: [] };
  assert.equal((await request("GET", device)).status, 401);
  const posted = await request("POST", device, report);
  assert.equal(posted.status, 201); assert.equal(posted.headers.get("cache-control"), "no-store");
  const receipt = await posted.json(); assert.equal(receipt.id, report.id);
  const readResponse = await request("GET", admin); assert.equal(readResponse.status, 200);
  const read = await readResponse.json();
  assert.deepEqual(read.reports[0].report, report);
  assert.equal(read.reports[0].expiresAtMs - receipt.receivedAtMs, 3 * 86400000);
  assert.equal((await request("POST", device, { ...report, text: "not allowed" })).status, 400);
  assert.equal((await request("DELETE", device)).status, 401);
  assert.equal((await request("DELETE", admin)).status, 200);
  assert.equal((await (await request("GET", admin)).json()).reports.length, 0);
  console.log(JSON.stringify({ runtime: "workerd/SQLite", passed: true, realNetworkRequests: 0, checks: 10 }));
} finally { await mf.dispose(); }
