import { DeadlineExceeded, withDeadline } from "./deadline.js";
import { TeslaTokenError, verifyTeslaAccessToken } from "./tesla-jwt.js";
import { executeTeslaSignedFlash, TeslaProtocolError } from "./tesla-protocol.js";

const TESLA_API_BASE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const MAX_BODY_BYTES = 512;
const MAX_PROVIDER_BODY_BYTES = 1_048_576;
const MAX_STATE_AGE_MS = 30_000;
const MAX_FUTURE_SKEW_MS = 5_000;

export class CommandOutcomeUnknown extends Error {
  constructor() {
    super("command_outcome_unknown");
    this.name = "CommandOutcomeUnknown";
  }
}

class UpstreamError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "UpstreamError";
    this.code = code;
    this.status = status;
  }
}

function json(code, status, ok = false) {
  return new Response(JSON.stringify({ ok, code }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

function bearerToken(request) {
  const authorization = request.headers.get("Authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/.exec(authorization);
  if (!match || match[1].length > 16384) throw new TeslaTokenError("invalid_token");
  return match[1];
}

async function readBoundedBody(request, timeoutMs) {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    return await withDeadline(async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        total += chunk.length;
        if (total > MAX_BODY_BYTES) {
          void reader.cancel().catch(() => {});
          throw new UpstreamError("bad_request", 400);
        }
        chunks.push(chunk);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    }, timeoutMs, () => { void reader.cancel().catch(() => {}); });
  } catch (error) {
    if (error instanceof UpstreamError) throw error;
    throw new UpstreamError("bad_request", 400);
  }
}

async function readInput(request, timeoutMs) {
  const length = Number(request.headers.get("Content-Length"));
  if (Number.isFinite(length) && length > MAX_BODY_BYTES) throw new UpstreamError("bad_request", 400);
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw new UpstreamError("bad_request", 400);
  const text = await readBoundedBody(request, timeoutMs);
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new UpstreamError("bad_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new UpstreamError("bad_request", 400);
  const keys = Object.keys(body).sort();
  if (keys.join(",") !== "vehicle_id,vin,wake") throw new UpstreamError("bad_request", 400);
  if (typeof body.vehicle_id !== "string" || !/^[1-9][0-9]{5,24}$/.test(body.vehicle_id)) {
    throw new UpstreamError("invalid_vehicle_id", 400);
  }
  if (typeof body.vin !== "string" || !/^[A-HJ-NPR-Z0-9]{17}$/.test(body.vin)) {
    throw new UpstreamError("invalid_vin", 400);
  }
  if (typeof body.wake !== "boolean") throw new UpstreamError("invalid_wake", 400);
  return body;
}

function mapTeslaStatus(status) {
  if (status === 401) return new UpstreamError("invalid_token", 401);
  if (status === 403) return new UpstreamError("missing_scope", 403);
  if (status === 408) return new UpstreamError("vehicle_unavailable", 409);
  if (status === 429) return new UpstreamError("provider_rate_limited", 429);
  return new UpstreamError("provider_unavailable", 502);
}

async function parseProviderJson(response) {
  if (!response.ok) throw mapTeslaStatus(response.status);
  let text;
  try {
    text = await response.text();
    if (text.length > MAX_PROVIDER_BODY_BYTES) throw new Error("oversized");
    return JSON.parse(text);
  } catch {
    throw new UpstreamError("provider_invalid_response", 502);
  }
}

function makeTeslaRequester(fetchImpl, token, timeoutMs) {
  return async (path, init = {}) => {
    const controller = new AbortController();
    try {
      return await withDeadline(async () => {
        const response = await fetchImpl(`${TESLA_API_BASE}${path}`, {
          method: init.method ?? "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            ...(init.body ? { "Content-Type": "application/json" } : {}),
          },
          ...(init.body ? { body: init.body } : {}),
          redirect: "error",
          signal: controller.signal,
        });
        return parseProviderJson(response);
      }, timeoutMs, () => controller.abort());
    } catch (error) {
      if (error instanceof UpstreamError) throw error;
      if (error instanceof DeadlineExceeded) throw new UpstreamError("provider_unavailable", 502);
      throw new UpstreamError("provider_unavailable", 502);
    }
  };
}

function vehicleIdMatches(vehicle, requestedId) {
  if (typeof vehicle?.id_s === "string" && vehicle.id_s === requestedId) return true;
  return Number.isSafeInteger(vehicle?.id) && String(vehicle.id) === requestedId;
}

function sameOwnedVehicle(vehicle, requested) {
  return vehicle && vehicle.vin === requested.vin && vehicleIdMatches(vehicle, requested.vehicle_id);
}

function validateFreshTimestamp(value, nowMs) {
  return Number.isFinite(value) && Number.isInteger(value) && value <= nowMs + MAX_FUTURE_SKEW_MS && nowMs - value <= MAX_STATE_AGE_MS;
}

function requireSafeVehicleState(body, nowMs) {
  const response = body?.response;
  const drive = response?.drive_state;
  const vehicle = response?.vehicle_state;
  if (!drive || !vehicle || !validateFreshTimestamp(drive.timestamp, nowMs) || !validateFreshTimestamp(vehicle.timestamp, nowMs)) {
    throw new UpstreamError("vehicle_state_stale", 409);
  }
  const parked = (drive.shift_state === "P" && (drive.speed === null || drive.speed === 0)) ||
    (drive.shift_state === null && drive.speed === 0);
  if (!parked) throw new UpstreamError("vehicle_not_parked", 409);
  if (vehicle.is_user_present === true) throw new UpstreamError("vehicle_occupied", 409);
  if (vehicle.is_user_present !== false) throw new UpstreamError("presence_unknown", 409);
}

async function waitUntilOnline({ teslaRequest, requested, sleep }) {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    if (attempt > 0) await sleep(2_000);
    const result = await teslaRequest(`/api/1/vehicles/${encodeURIComponent(requested.vin)}`);
    const vehicle = result?.response;
    if (!sameOwnedVehicle(vehicle, requested)) throw new UpstreamError("vehicle_not_owned", 403);
    if (vehicle.state === "online") return;
  }
  throw new UpstreamError("vehicle_unavailable", 409);
}

function protocolErrorResponse(error) {
  if (error instanceof CommandOutcomeUnknown || (error instanceof TeslaProtocolError && error.outcomeUnknown)) {
    return json("command_outcome_unknown", 504);
  }
  if (error instanceof TeslaProtocolError) {
    if (error.code === "key_not_paired") return json("vehicle_key_not_paired", 409);
    if (error.code === "invalid_private_key") return json("server_not_configured", 503);
    if (error.code === "tesla_http_401") return json("invalid_token", 401);
    if (error.code === "tesla_http_403") return json("missing_scope", 403);
    if (error.code === "tesla_http_408") return json("vehicle_unavailable", 409);
    return json("command_rejected", 502);
  }
  return null;
}

export function createWelcomeLightsHandler({
  fetchImpl = globalThis.fetch,
  verifyToken = verifyTeslaAccessToken,
  executeSignedFlash = executeTeslaSignedFlash,
  nowMs = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  requestBodyTimeoutMs = 2_000,
  providerTimeoutMs = 6_000,
} = {}) {
  return async function handle(request, env) {
    try {
      if (!env?.TESLA_COMMAND_PRIVATE_KEY || typeof env.TESLA_COMMAND_PRIVATE_KEY !== "string") {
        return json("server_not_configured", 503);
      }
      const token = bearerToken(request);
      const input = await readInput(request, requestBodyTimeoutMs);
      const claims = await verifyToken(token, { fetchImpl, nowSeconds: Math.floor(nowMs() / 1000) });
      if (
        (env.TESLA_COMMAND_ALLOWED_SUB && claims.sub !== env.TESLA_COMMAND_ALLOWED_SUB) ||
        (env.TESLA_COMMAND_ALLOWED_VIN && input.vin !== env.TESLA_COMMAND_ALLOWED_VIN)
      ) {
        return json("allowlist_denied", 403);
      }

      const teslaRequest = makeTeslaRequester(fetchImpl, token, providerTimeoutMs);
      const vehiclesResult = await teslaRequest("/api/1/vehicles");
      if (!Array.isArray(vehiclesResult?.response) || vehiclesResult.response.length > 100) {
        throw new UpstreamError("provider_invalid_response", 502);
      }
      const ownedVehicle = vehiclesResult.response.find((vehicle) => sameOwnedVehicle(vehicle, input));
      if (!ownedVehicle) return json("vehicle_not_owned", 403);

      if (ownedVehicle.state !== "online") {
        if (!input.wake) return json("vehicle_asleep", 409);
        await teslaRequest(`/api/1/vehicles/${encodeURIComponent(input.vin)}/wake_up`, {
          method: "POST",
          body: "{}",
        });
        await waitUntilOnline({ teslaRequest, requested: input, sleep });
      }

      const endpoints = encodeURIComponent("drive_state;vehicle_state");
      const state = await teslaRequest(`/api/1/vehicles/${encodeURIComponent(input.vin)}/vehicle_data?endpoints=${endpoints}`);
      requireSafeVehicleState(state, nowMs());

      const result = await executeSignedFlash({
        fetchImpl,
        apiBase: TESLA_API_BASE,
        token,
        vin: input.vin,
        privateKeyPem: env.TESLA_COMMAND_PRIVATE_KEY,
      });
      if (result?.ok !== true) return json("command_rejected", 502);
      return json("lights_flashed", 200, true);
    } catch (error) {
      if (error instanceof TeslaTokenError) {
        return json(error.code === "missing_scope" ? "missing_scope" : error.code === "token_verification_unavailable" ? "token_verification_unavailable" : "invalid_token", error.code === "missing_scope" ? 403 : error.code === "token_verification_unavailable" ? 503 : 401);
      }
      if (error instanceof UpstreamError) return json(error.code, error.status);
      const protocolResponse = protocolErrorResponse(error);
      if (protocolResponse) return protocolResponse;
      return json("internal_error", 500);
    }
  };
}
