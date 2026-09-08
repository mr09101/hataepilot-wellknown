import assert from "node:assert/strict";
import test from "node:test";

import { createRefreshHandler } from "../functions/api/refresh.js";
import { createTokenHandler } from "../functions/api/token.js";

const ENV = { TESLA_CLIENT_SECRET: "fake-client-secret" };
const ENDPOINT = "https://auth.tesla.com/oauth2/v3/token";
const REDIRECT_URI = "https://hataepilot.com/auth/callback";

function request(path, body, contentType = "application/json") {
  return new Request(`https://hataepilot.com/api/${path}`, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function assertSecureJson(response) {
  assert.match(response.headers.get("Content-Type") ?? "", /^application\/json\b/i);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("Pragma"), "no-cache");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.notEqual(response.headers.get("Access-Control-Allow-Origin"), "*");
}

test("OAuth requests require JSON objects with only bounded string fields", async () => {
  let fetches = 0;
  const options = {
    fetchImpl: async () => {
      fetches += 1;
      return jsonResponse({ access_token: "should-not-be-returned" });
    },
    maxRequestBytes: 64,
  };
  const token = createTokenHandler(options);
  const refresh = createRefreshHandler(options);

  const cases = [
    [token, request("token", { code: "abc" }, "text/plain"), 415, "unsupported_media_type"],
    [token, request("token", []), 400, "invalid_request"],
    [token, request("token", { code: "abc", extra: "field" }), 400, "invalid_request"],
    [token, request("token", { code: 123 }), 400, "invalid_code"],
    [refresh, request("refresh", { refresh_token: 123 }), 400, "invalid_refresh_token"],
    [token, request("token", { code: "x".repeat(100) }), 413, "request_too_large"],
  ];

  for (const [handler, candidate, status, error] of cases) {
    const response = await handler({ request: candidate, env: ENV });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { error });
    assertSecureJson(response);
  }

  const defaultToken = createTokenHandler({ fetchImpl: options.fetchImpl });
  const defaultRefresh = createRefreshHandler({ fetchImpl: options.fetchImpl });
  for (const [handler, candidate, error] of [
    [defaultToken, request("token", { code: "x".repeat(16_385) }), "invalid_code"],
    [defaultRefresh, request("refresh", { refresh_token: "x".repeat(16_385) }), "invalid_refresh_token"],
    [defaultRefresh, request("refresh", { refresh_token: "abc", extra: "field" }), "invalid_request"],
  ]) {
    const response = await handler({ request: candidate, env: ENV });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error });
    assertSecureJson(response);
  }

  const twoMib = request("token", { code: "x".repeat(2 * 1024 * 1024) });
  const oversizedResponse = await defaultToken({ request: twoMib, env: ENV });
  assert.equal(oversizedResponse.status, 413);
  assert.deepEqual(await oversizedResponse.json(), { error: "request_too_large" });
  assertSecureJson(oversizedResponse);
  assert.equal(fetches, 0);
});

test("OAuth request body reading stops at its deadline", async () => {
  const pending = new ReadableStream({ start() {} });
  const pendingRequest = new Request("https://hataepilot.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: pending,
    duplex: "half",
  });
  const handler = createTokenHandler({
    fetchImpl: async () => assert.fail("provider must not be contacted"),
    requestBodyTimeoutMs: 20,
  });

  const started = Date.now();
  const response = await handler({ request: pendingRequest, env: ENV });
  assert.equal(response.status, 408);
  assert.deepEqual(await response.json(), { error: "request_timeout" });
  assert.ok(Date.now() - started < 500);
  assertSecureJson(response);
});

test("authorization-code exchange uses the fixed provider and default redirect safely", async () => {
  let checked = false;
  const handler = createTokenHandler({
    fetchImpl: async (url, options) => {
      assert.equal(String(url), ENDPOINT);
      assert.equal(options.method, "POST");
      assert.equal(options.redirect, "error");
      assert.ok(options.signal instanceof AbortSignal);
      const form = new URLSearchParams(options.body);
      assert.equal(form.get("grant_type"), "authorization_code");
      assert.equal(form.get("client_id"), "8dcd603f-22b3-461d-87b8-07acd47f8bb9");
      assert.equal(form.get("client_secret"), ENV.TESLA_CLIENT_SECRET);
      assert.equal(form.get("code"), "fake-code");
      assert.equal(form.get("redirect_uri"), REDIRECT_URI);
      assert.equal(form.get("audience"), "https://fleet-api.prd.na.vn.cloud.tesla.com");
      checked = true;
      return jsonResponse({ access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 300 });
    },
  });

  const response = await handler({ request: request("token", { code: "fake-code" }), env: ENV });
  assert.equal(response.status, 200);
  assert.equal(checked, true);
  assert.deepEqual(await response.json(), {
    access_token: "fake-access",
    refresh_token: "fake-refresh",
    expires_in: 300,
  });
  assertSecureJson(response);
});

test("authorization-code exchange accepts only the configured redirect URI", async () => {
  const handler = createTokenHandler({ fetchImpl: async () => assert.fail("provider must not be contacted") });
  const response = await handler({
    request: request("token", { code: "fake-code", redirect_uri: "https://attacker.invalid/callback" }),
    env: ENV,
  });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "invalid_redirect_uri" });
  assertSecureJson(response);
});

test("refresh exchange forwards only the bounded refresh grant", async () => {
  const handler = createRefreshHandler({
    fetchImpl: async (url, options) => {
      assert.equal(String(url), ENDPOINT);
      assert.equal(options.redirect, "error");
      const form = new URLSearchParams(options.body);
      assert.deepEqual([...form.keys()].sort(), ["client_id", "client_secret", "grant_type", "refresh_token"]);
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "fake-refresh");
      return jsonResponse({ access_token: "new-fake-access" });
    },
  });
  const response = await handler({ request: request("refresh", { refresh_token: "fake-refresh" }), env: ENV });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { access_token: "new-fake-access" });
  assertSecureJson(response);
});

test("provider deadline covers both fetch and response body consumption", async () => {
  let observedSignal;
  const neverEndingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"access_token":"partial'));
    },
  });
  const handler = createTokenHandler({
    fetchImpl: async (_url, options) => {
      observedSignal = options.signal;
      return new Response(neverEndingBody, { status: 200, headers: { "Content-Type": "application/json" } });
    },
    providerTimeoutMs: 20,
  });

  const started = Date.now();
  const response = await handler({ request: request("token", { code: "fake-code" }), env: ENV });
  assert.equal(response.status, 504);
  assert.deepEqual(await response.json(), { error: "provider_timeout" });
  assert.equal(observedSignal.aborted, true);
  assert.ok(Date.now() - started < 500);
  assertSecureJson(response);

  const stalledFetch = createTokenHandler({
    fetchImpl: async () => new Promise(() => {}),
    providerTimeoutMs: 20,
  });
  const fetchResponse = await stalledFetch({ request: request("token", { code: "fake-code" }), env: ENV });
  assert.equal(fetchResponse.status, 504);
  assert.deepEqual(await fetchResponse.json(), { error: "provider_timeout" });
  assertSecureJson(fetchResponse);
});

test("oversized, malformed, redirected, and rejected provider responses expose only safe JSON", async (t) => {
  const providerCases = [
    ["oversized", async () => jsonResponse({ access_token: "x".repeat(200) }), 64, 502, "provider_response_invalid"],
    ["malformed", async () => new Response("not-json", { status: 200, headers: { "Content-Type": "application/json" } }), 64, 502, "provider_response_invalid"],
    ["redirect refused", async () => { throw new TypeError("redirect mode is set to error"); }, 64, 502, "provider_unavailable"],
    ["provider rejection", async () => jsonResponse({ error: "invalid_grant", error_description: "sensitive provider detail" }, 400), 1024, 400, "oauth_provider_rejected"],
  ];

  for (const [name, fetchImpl, maxResponseBytes, status, error] of providerCases) {
    await t.test(name, async () => {
      const handler = createTokenHandler({ fetchImpl, maxResponseBytes });
      const response = await handler({ request: request("token", { code: "fake-code" }), env: ENV });
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { error });
      assertSecureJson(response);
    });
  }
});

test("configuration failures also carry anti-caching and anti-sniffing headers", async () => {
  const response = await createTokenHandler()({ request: request("token", { code: "fake-code" }), env: {} });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "server_not_configured" });
  assertSecureJson(response);
});
