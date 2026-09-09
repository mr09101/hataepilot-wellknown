import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import worker, { handleRequest } from "../updates/src/worker.js";
import { MAX_MANIFEST_BYTES, expectedApkMetadata } from "../updates/src/manifest.js";

const TOKEN = "A".repeat(43);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const APK_BYTES = new Uint8Array([1, 2, 3, 4]);
const APK_SHA = createHash("sha256").update(APK_BYTES).digest("hex");
const CERT_SHA = "b".repeat(64);

function manifest(overrides = {}) {
  const value = {
    schema: 1,
    packageName: "com.khs.hataepilot",
    publishedAt: "2026-09-10T00:00:00.000Z",
    releases: {
      current: {
        versionCode: 2,
        versionName: "0.2",
        sha256: APK_SHA,
        sizeBytes: APK_BYTES.byteLength,
        downloadPath: "/updates/apk/current",
        notes: "정상 업데이트",
        minSdk: 31,
        certificateSha256: CERT_SHA,
      },
      recovery: {
        versionCode: 3,
        versionName: "0.2-recovery",
        sha256: "c".repeat(64),
        sizeBytes: 5,
        downloadPath: "/updates/apk/recovery",
        notes: "복구 업데이트",
        minSdk: 31,
        certificateSha256: CERT_SHA,
      },
    },
  };
  return Object.assign(value, overrides);
}

function objectFor(key, body, options = {}) {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  return {
    key,
    size: options.size ?? bytes.byteLength,
    storageClass: options.storageClass ?? "Standard",
    httpMetadata: { contentType: options.contentType ?? (key.endsWith(".apk") ? "application/vnd.android.package-archive" : "application/json") },
    customMetadata: options.customMetadata ?? {},
    body: options.body ?? new Response(bytes).body,
    async text() { return new TextDecoder().decode(bytes); },
  };
}

function environment(options = {}) {
  const budgetCalls = [];
  const r2Calls = [];
  const manifestValue = options.manifest ?? manifest();
  const manifestText = options.manifestText ?? JSON.stringify(manifestValue);
  const budgetResponses = [...(options.budgetResponses ?? [])];
  const env = {
    UPDATE_TOKEN_SHA256: options.tokenHash ?? TOKEN_HASH,
    UPDATE_BUDGET: {
      idFromName(name) { assert.equal(name, "hataepilot-update-budget-v1"); return "fixed-id"; },
      get() {
        return {
          async fetch(request) {
            budgetCalls.push(await request.json());
            if (options.budgetError) throw new Error("budget_down");
            return budgetResponses.shift() ?? Response.json({ ok: true });
          },
        };
      },
    },
    UPDATES_BUCKET: {
      async get(key) {
        r2Calls.push(key);
        if (options.r2Error) throw new Error("r2_down");
        if (key === "manifest.json") {
          return objectFor(key, manifestText, { size: options.manifestSize, contentType: options.manifestContentType });
        }
        const releaseName = key === "current.apk" ? "current" : "recovery";
        const release = manifestValue.releases[releaseName];
        if (options.apkObject) return options.apkObject;
        return objectFor(key, releaseName === "current" ? APK_BYTES : new Uint8Array(5), {
          size: release.sizeBytes,
          customMetadata: expectedApkMetadata(releaseName, release),
        });
      },
    },
  };
  return { env, budgetCalls, r2Calls };
}

function authHeaders(token = TOKEN) {
  return { Authorization: `Bearer ${token}` };
}

test("worker exports the configured fetch handler", () => {
  assert.equal(worker.fetch, handleRequest);
});

test("public Worker root only redirects to the fixed same-origin recovery path", async () => {
  const response = await handleRequest(new Request("https://hataepilot.com/updates/"), {});
  assert.equal(response.status, 302);
  assert.equal(response.headers.get("location"), "/app-recovery/");
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("missing or wrong bearer authentication never reaches DO or R2", async () => {
  for (const headers of [{}, authHeaders("B".repeat(43))]) {
    const state = environment();
    const response = await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers }), state.env);
    assert.equal(response.status, 401);
    assert.deepEqual(state.budgetCalls, []);
    assert.deepEqual(state.r2Calls, []);
  }
});

test("missing secret or binding fails closed before storage", async () => {
  const state = environment();
  delete state.env.UPDATE_TOKEN_SHA256;
  const response = await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), state.env);
  assert.equal(response.status, 503);
  assert.deepEqual(state.budgetCalls, []);
  assert.deepEqual(state.r2Calls, []);
});

test("manifest is strict, no-store, and charged before one R2 get", async () => {
  const state = environment({ manifest: manifest({ publishedAt: "2026-09-10T00:00:00.123456Z" }) });
  const response = await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), state.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.equal((await response.json()).packageName, "com.khs.hataepilot");
  assert.deepEqual(state.budgetCalls, [{ kind: "lookup", bytes: 0 }]);
  assert.deepEqual(state.r2Calls, ["manifest.json"]);
});

test("oversized or malformed manifests are rejected", async () => {
  const oversized = environment({ manifestSize: MAX_MANIFEST_BYTES + 1 });
  assert.equal((await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), oversized.env)).status, 503);
  assert.deepEqual(oversized.r2Calls, ["manifest.json"]);

  const malformed = environment({ manifest: { ...manifest(), schema: 2 } });
  assert.equal((await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), malformed.env)).status, 503);
});

test("fixed download path streams after exact lookup and byte reservations", async () => {
  const state = environment();
  const response = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, { headers: authHeaders() }), state.env);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-disposition"), 'attachment; filename="hataepilot-current-v2.apk"');
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  assert.equal(response.headers.get("accept-ranges"), "none");
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), APK_BYTES);
  assert.deepEqual(state.budgetCalls, [{ kind: "lookup", bytes: 0 }, { kind: "download", bytes: 4 }]);
  assert.deepEqual(state.r2Calls, ["manifest.json", "current.apk"]);
});

test("random sha is charged one lookup but never reads an APK", async () => {
  const state = environment();
  const response = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${"d".repeat(64)}`, { headers: authHeaders() }), state.env);
  assert.equal(response.status, 409);
  assert.deepEqual(state.budgetCalls, [{ kind: "lookup", bytes: 0 }]);
  assert.deepEqual(state.r2Calls, ["manifest.json"]);
});

test("ranges and arbitrary paths are rejected without budget or R2", async () => {
  const rangeState = environment();
  const rangeResponse = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, {
    headers: { ...authHeaders(), Range: "bytes=0-1" },
  }), rangeState.env);
  assert.equal(rangeResponse.status, 416);
  assert.deepEqual(rangeState.r2Calls, []);
  const pathState = environment();
  assert.equal((await handleRequest(new Request("https://hataepilot.com/updates/apk/other", { headers: authHeaders() }), pathState.env)).status, 404);
  assert.deepEqual(pathState.r2Calls, []);
});

test("quota rejection and lost budget response fail closed", async () => {
  const limited = environment({ budgetResponses: [new Response("", { status: 429, headers: { "Retry-After": "3600" } })] });
  const limitedResponse = await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), limited.env);
  assert.equal(limitedResponse.status, 429);
  assert.equal(limitedResponse.headers.get("retry-after"), "3600");
  assert.deepEqual(limited.r2Calls, []);

  const failed = environment({ budgetError: true });
  assert.equal((await handleRequest(new Request("https://hataepilot.com/updates/manifest", { headers: authHeaders() }), failed.env)).status, 503);
  assert.deepEqual(failed.r2Calls, []);
});

test("second reservation failure never fetches the APK", async () => {
  const state = environment({ budgetResponses: [Response.json({ ok: true }), new Response("", { status: 429, headers: { "Retry-After": "86400" } })] });
  const response = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, { headers: authHeaders() }), state.env);
  assert.equal(response.status, 429);
  assert.deepEqual(state.r2Calls, ["manifest.json"]);
});

test("APK metadata mismatch is fail closed after two bounded gets", async () => {
  const badObject = objectFor("current.apk", APK_BYTES, { customMetadata: { sha256: APK_SHA } });
  const state = environment({ apkObject: badObject });
  const response = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, { headers: authHeaders() }), state.env);
  assert.equal(response.status, 503);
  assert.deepEqual(state.r2Calls, ["manifest.json", "current.apk"]);

  const release = manifest().releases.current;
  const extraMetadata = environment({
    apkObject: objectFor("current.apk", APK_BYTES, {
      customMetadata: { ...expectedApkMetadata("current", release), unexpected: "value" },
    }),
  });
  const extraResponse = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, { headers: authHeaders() }), extraMetadata.env);
  assert.equal(extraResponse.status, 503);
  assert.deepEqual(extraMetadata.r2Calls, ["manifest.json", "current.apk"]);
});

test("browser POST requires same origin, strict form, and parking confirmation", async () => {
  const invalid = environment();
  const invalidResponse = await handleRequest(new Request("https://hataepilot.com/updates/apk/current", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://evil.example", "Sec-Fetch-Site": "cross-site" },
    body: new URLSearchParams({ token: TOKEN, sha: APK_SHA, parked: "true" }),
  }), invalid.env);
  assert.equal(invalidResponse.status, 403);
  assert.deepEqual(invalid.r2Calls, []);

  const valid = environment();
  const validResponse = await handleRequest(new Request("https://hataepilot.com/updates/apk/current", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "https://hataepilot.com", "Sec-Fetch-Site": "same-origin" },
    body: new URLSearchParams({ token: TOKEN, sha: APK_SHA, parked: "true" }),
  }), valid.env);
  assert.equal(validResponse.status, 200);
});

test("a partial body stream failure is not retried or refunded", async () => {
  const brokenBody = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array([1])); controller.error(new Error("stream_failed")); },
  });
  const release = manifest().releases.current;
  const state = environment({
    apkObject: objectFor("current.apk", APK_BYTES, { body: brokenBody, customMetadata: expectedApkMetadata("current", release) }),
  });
  const response = await handleRequest(new Request(`https://hataepilot.com/updates/apk/current?sha=${APK_SHA}`, { headers: authHeaders() }), state.env);
  assert.equal(response.status, 200);
  await assert.rejects(response.arrayBuffer(), /stream_failed/);
  assert.equal(state.r2Calls.length, 2);
  assert.equal(state.budgetCalls.length, 2);
});
