import assert from "node:assert/strict";
import test from "node:test";

import { createWelcomeLightsHandler, CommandOutcomeUnknown } from "../functions/_lib/welcome-lights.js";

const NOW = 1_800_000_000_000;
const VIN = "5YJ30123456789ABC";
const VEHICLE_ID = "12345678901234567";
const TOKEN = "signed.tesla.token";

function request(body, token = TOKEN) {
  return new Request("https://hataepilot.com/api/welcome-lights", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
}

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function onlineVehicle() {
  return { id: Number(VEHICLE_ID), id_s: VEHICLE_ID, vin: VIN, state: "online" };
}

function safeVehicleData(overrides = {}) {
  return {
    response: {
      drive_state: { shift_state: "P", speed: null, timestamp: NOW - 2_000 },
      vehicle_state: { is_user_present: false, timestamp: NOW - 2_000 },
      ...overrides,
    },
  };
}

function makeHandler({ vehicle = onlineVehicle(), data = safeVehicleData(), signer, fetchOverride, env = {}, handlerOptions = {} } = {}) {
  const calls = [];
  const fetchImpl = fetchOverride ?? (async (url, options = {}) => {
    calls.push({ url: String(url), method: options.method ?? "GET" });
    if (String(url).endsWith("/api/1/vehicles")) return jsonResponse({ response: [vehicle] });
    if (String(url).includes("/vehicle_data")) return jsonResponse(data);
    throw new Error(`unexpected fetch ${url}`);
  });
  const executeSignedFlash = signer ?? (async () => ({ ok: true }));
  const handler = createWelcomeLightsHandler({
    fetchImpl,
    verifyToken: async () => ({ sub: "owner-1" }),
    executeSignedFlash,
    nowMs: () => NOW,
    sleep: async () => {},
    ...handlerOptions,
  });
  return { handler, calls, env: { TESLA_COMMAND_PRIVATE_KEY: "configured-in-test", ...env } };
}

async function bodyOf(response) {
  return response.json();
}

test("rejects malformed input and missing bearer token without contacting Tesla", async () => {
  const { handler, calls, env } = makeHandler();
  const badVin = await handler(request({ vehicle_id: VEHICLE_ID, vin: "bad", wake: false }), env);
  assert.equal(badVin.status, 400);
  assert.deepEqual(await bodyOf(badVin), { ok: false, code: "invalid_vin" });

  const missingToken = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }, ""), env);
  assert.equal(missingToken.status, 401);
  assert.equal(calls.length, 0);
});

test("enforces optional subject and VIN allowlists", async () => {
  const { handler, env } = makeHandler({
    env: { TESLA_COMMAND_ALLOWED_SUB: "different-owner", TESLA_COMMAND_ALLOWED_VIN: VIN },
  });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "allowlist_denied" });
});

test("requires requested vehicle id and VIN to belong to the token owner", async () => {
  const { handler, env } = makeHandler({ vehicle: { ...onlineVehicle(), vin: "7SA00000000000000" } });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 403);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "vehicle_not_owned" });
});

test("fails closed for stale, moving, unknown-presence, and occupied states", async (t) => {
  const unsafeCases = [
    ["stale", safeVehicleData({ drive_state: { shift_state: "P", speed: null, timestamp: NOW - 60_000 } }), "vehicle_state_stale"],
    ["moving", safeVehicleData({ drive_state: { shift_state: "D", speed: 12, timestamp: NOW - 1_000 } }), "vehicle_not_parked"],
    ["presence missing", safeVehicleData({ vehicle_state: { timestamp: NOW - 1_000 } }), "presence_unknown"],
    ["occupied", safeVehicleData({ vehicle_state: { is_user_present: true, timestamp: NOW - 1_000 } }), "vehicle_occupied"],
  ];
  for (const [name, data, expected] of unsafeCases) {
    await t.test(name, async () => {
      let signed = 0;
      const { handler, env } = makeHandler({ data, signer: async () => { signed += 1; return { ok: true }; } });
      const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
      assert.equal(response.status, 409);
      assert.deepEqual(await bodyOf(response), { ok: false, code: expected });
      assert.equal(signed, 0);
    });
  }
});

test("permits explicit P or null shift with explicit zero speed only", async () => {
  for (const driveState of [
    { shift_state: "P", speed: null, timestamp: NOW - 1_000 },
    { shift_state: null, speed: 0, timestamp: NOW - 1_000 },
  ]) {
    const { handler, env } = makeHandler({ data: safeVehicleData({ drive_state: driveState }) });
    const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
    assert.equal(response.status, 200);
    assert.deepEqual(await bodyOf(response), { ok: true, code: "lights_flashed" });
  }

  const { handler, env } = makeHandler({
    data: safeVehicleData({ drive_state: { shift_state: null, speed: null, timestamp: NOW - 1_000 } }),
  });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "vehicle_not_parked" });
});

test("does not wake an asleep vehicle unless the caller opted in", async () => {
  const { handler, env } = makeHandler({ vehicle: { ...onlineVehicle(), state: "asleep" } });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 409);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "vehicle_asleep" });
});

test("wake opt-in is bounded, then safety is rechecked before one command", async () => {
  let stateReads = 0;
  let signed = 0;
  const fetchImpl = async (url, options = {}) => {
    const value = String(url);
    if (value.endsWith("/api/1/vehicles")) return jsonResponse({ response: [{ ...onlineVehicle(), state: "asleep" }] });
    if (value.endsWith(`/${VIN}/wake_up`) && options.method === "POST") return jsonResponse({ response: { state: "online" } });
    if (value.endsWith(`/${VIN}`)) {
      stateReads += 1;
      return jsonResponse({ response: { ...onlineVehicle(), state: stateReads >= 2 ? "online" : "asleep" } });
    }
    if (value.includes("/vehicle_data")) return jsonResponse(safeVehicleData());
    throw new Error(`unexpected fetch ${value}`);
  };
  const { handler, env } = makeHandler({
    fetchOverride: fetchImpl,
    signer: async () => { signed += 1; return { ok: true }; },
  });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: true }), env);
  assert.equal(response.status, 200);
  assert.equal(stateReads, 2);
  assert.equal(signed, 1);
});

test("an unknown command outcome is never retried or reported as success", async () => {
  let attempts = 0;
  const { handler, env } = makeHandler({
    signer: async () => {
      attempts += 1;
      throw new CommandOutcomeUnknown();
    },
  });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 504);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "command_outcome_unknown" });
  assert.equal(attempts, 1);
});

test("responses suppress caching, sniffing, and raw provider details", async () => {
  const { handler, env } = makeHandler();
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.deepEqual(Object.keys(await bodyOf(response)).sort(), ["code", "ok"]);
});

test("every Tesla Fleet API read is bounded by an abort signal", async () => {
  const signals = [];
  const fetchImpl = async (url, options = {}) => {
    signals.push(options.signal);
    if (String(url).endsWith("/api/1/vehicles")) return jsonResponse({ response: [onlineVehicle()] });
    if (String(url).includes("/vehicle_data")) return jsonResponse(safeVehicleData());
    throw new Error(`unexpected fetch ${url}`);
  };
  const { handler, env } = makeHandler({ fetchOverride: fetchImpl });
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 200);
  assert.equal(signals.length, 2);
  assert.equal(signals.every((signal) => signal instanceof AbortSignal), true);
});

test("missing authentication is rejected before reading an unbounded request body", async () => {
  const stream = new ReadableStream({ start() {} });
  const requestWithPendingBody = new Request("https://hataepilot.com/api/welcome-lights", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: stream,
    duplex: "half",
  });
  const { handler, env } = makeHandler();
  const response = await Promise.race([
    handler(requestWithPendingBody, env),
    new Promise((_, reject) => setTimeout(() => reject(new Error("handler_hung")), 100)),
  ]);
  assert.equal(response.status, 401);
});

test("request body is cancelled at 513 bytes or its short deadline", async () => {
  const oversized = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(600));
      controller.close();
    },
  });
  const oversizedRequest = new Request("https://hataepilot.com/api/welcome-lights", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: oversized,
    duplex: "half",
  });
  const first = makeHandler({ handlerOptions: { requestBodyTimeoutMs: 20 } });
  assert.equal((await first.handler(oversizedRequest, first.env)).status, 400);

  const pending = new ReadableStream({ start() {} });
  const pendingRequest = new Request("https://hataepilot.com/api/welcome-lights", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: pending,
    duplex: "half",
  });
  const second = makeHandler({ handlerOptions: { requestBodyTimeoutMs: 20 } });
  const started = Date.now();
  const response = await second.handler(pendingRequest, second.env);
  assert.equal(response.status, 400);
  assert.ok(Date.now() - started < 500);
});

test("Tesla response body must finish before the provider deadline", async () => {
  const responseBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"response":['));
    },
  });
  const { handler, env } = makeHandler({
    fetchOverride: async () => new Response(responseBody, { status: 200 }),
    handlerOptions: { providerTimeoutMs: 20 },
  });
  const started = Date.now();
  const response = await handler(request({ vehicle_id: VEHICLE_ID, vin: VIN, wake: false }), env);
  assert.equal(response.status, 502);
  assert.deepEqual(await bodyOf(response), { ok: false, code: "provider_unavailable" });
  assert.ok(Date.now() - started < 500);
});
