import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleRequest } from "../updates/src/worker.js";

const token = Buffer.alloc(32, 1).toString("base64url");
const admin = Buffer.alloc(32, 2).toString("base64url");
const hash = value => createHash("sha256").update(value).digest("hex");
const request = (method, credential, body, extra = {}) => new Request("https://hataepilot.com/updates/diagnostics", {
  method, headers: { ...(credential ? { Authorization: `Bearer ${credential}` } : {}),
    ...(body ? { "Content-Type": "application/json" } : {}), ...extra },
  ...(body ? { body: JSON.stringify(body) } : {}),
});
function env() {
  let calls = 0;
  return { UPDATE_TOKEN_SHA256: hash(token), DIAGNOSTICS_READ_TOKEN_SHA256: hash(admin),
    DIAGNOSTICS_INBOX: { idFromName: () => "diagnostics", get: () => ({ fetch: async r => {
      calls++; return Response.json({ ok: true, method: r.method });
    } }) }, calls: () => calls };
}
test("diagnostic device password cannot read or erase reports; admin cannot upload", async () => {
  const e = env();
  for (const method of ["GET", "DELETE"]) {
    assert.equal((await handleRequest(request(method, token), e)).status, 401);
    assert.equal((await handleRequest(request(method, admin), e)).status, 200);
  }
  assert.equal((await handleRequest(request("POST", admin, {}), e)).status, 401);
  assert.equal(e.calls(), 2);
});
test("no auth, origin, query, excessive body and unknown routes cannot reach diagnostic storage", async () => {
  const e = env();
  assert.equal((await handleRequest(request("GET"), e)).status, 401);
  assert.equal((await handleRequest(request("GET", admin, null, { Origin: "https://evil.invalid" }), e)).status, 403);
  assert.equal((await handleRequest(new Request("https://hataepilot.com/updates/diagnostics?token=x"), e)).status, 400);
  assert.equal((await handleRequest(request("POST", token, {}, { "Content-Length": "131073" }), e)).status, 413);
  assert.equal(e.calls(), 0);
});
test("missing diagnostic configuration fails closed with no-store", async () => {
  const response = await handleRequest(request("GET", admin), {});
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
