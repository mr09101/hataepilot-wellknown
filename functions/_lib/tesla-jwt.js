import { withDeadline } from "./deadline.js";

const TESLA_ISSUER = "https://auth.tesla.com/oauth2/v3/nts";
const TESLA_AUDIENCE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TESLA_CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";
const TESLA_JWKS_URL = "https://auth.tesla.com/oauth2/v3/discovery/thirdparty/keys";

let cachedJwks;
let cachedJwksUntil = 0;

export class TeslaTokenError extends Error {
  constructor(code) {
    super(code);
    this.name = "TeslaTokenError";
    this.code = code;
  }
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TeslaTokenError("invalid_token");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new TeslaTokenError("invalid_token");
  }
}

function decodeJson(segment) {
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(decodeBase64Url(segment));
    const value = JSON.parse(decoded);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not object");
    return value;
  } catch (error) {
    if (error instanceof TeslaTokenError) throw error;
    throw new TeslaTokenError("invalid_token");
  }
}

async function loadJwks(fetchImpl, nowSeconds, timeoutMs) {
  const canCache = fetchImpl === globalThis.fetch;
  if (canCache && cachedJwks && nowSeconds < cachedJwksUntil) return cachedJwks;
  const controller = new AbortController();
  let body;
  try {
    body = await withDeadline(async () => {
      const response = await fetchImpl(TESLA_JWKS_URL, { method: "GET", redirect: "error", signal: controller.signal });
      if (!response.ok) throw new Error("jwks_status");
      const text = await response.text();
      if (text.length > 131072) throw new Error("oversized");
      return JSON.parse(text);
    }, timeoutMs, () => controller.abort());
  } catch {
    throw new TeslaTokenError("token_verification_unavailable");
  }
  if (!Array.isArray(body?.keys) || body.keys.length === 0 || body.keys.length > 32) {
    throw new TeslaTokenError("token_verification_unavailable");
  }
  if (canCache) {
    cachedJwks = body.keys;
    cachedJwksUntil = nowSeconds + 300;
  }
  return body.keys;
}

function tokenScopes(payload) {
  if (typeof payload.scope === "string") return new Set(payload.scope.split(/\s+/).filter(Boolean));
  if (Array.isArray(payload.scp) && payload.scp.every((item) => typeof item === "string")) return new Set(payload.scp);
  if (typeof payload.scp === "string") return new Set(payload.scp.split(/\s+/).filter(Boolean));
  return new Set();
}

function audienceMatches(audience) {
  return audience === TESLA_AUDIENCE || (Array.isArray(audience) && audience.includes(TESLA_AUDIENCE));
}

async function importVerificationKey(jwk, algorithm) {
  try {
    if (algorithm === "RS256" && jwk.kty === "RSA") {
      return crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
    }
    if (algorithm === "ES256" && jwk.kty === "EC" && jwk.crv === "P-256") {
      return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    }
  } catch {
    throw new TeslaTokenError("token_verification_unavailable");
  }
  throw new TeslaTokenError("invalid_token");
}

export async function verifyTeslaAccessToken(token, {
  fetchImpl = globalThis.fetch,
  nowSeconds = Math.floor(Date.now() / 1000),
  jwksTimeoutMs = 5_000,
} = {}) {
  if (typeof token !== "string" || token.length > 16384) throw new TeslaTokenError("invalid_token");
  const segments = token.split(".");
  if (segments.length !== 3) throw new TeslaTokenError("invalid_token");
  const [encodedHeader, encodedPayload, encodedSignature] = segments;
  const header = decodeJson(encodedHeader);
  const payload = decodeJson(encodedPayload);
  if (!['RS256', 'ES256'].includes(header.alg) || typeof header.kid !== "string" || header.kid.length > 256) {
    throw new TeslaTokenError("invalid_token");
  }
  const keys = await loadJwks(fetchImpl, nowSeconds, jwksTimeoutMs);
  const jwk = keys.find((candidate) => candidate?.kid === header.kid && (!candidate.alg || candidate.alg === header.alg));
  if (!jwk || (jwk.use && jwk.use !== "sig")) throw new TeslaTokenError("invalid_token");
  const key = await importVerificationKey(jwk, header.alg);
  const verificationAlgorithm = header.alg === "RS256"
    ? { name: "RSASSA-PKCS1-v1_5" }
    : { name: "ECDSA", hash: "SHA-256" };
  const signatureValid = await crypto.subtle.verify(
    verificationAlgorithm,
    key,
    decodeBase64Url(encodedSignature),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`),
  );
  if (!signatureValid) throw new TeslaTokenError("invalid_token");

  const skew = 60;
  if (
    payload.iss !== TESLA_ISSUER ||
    !audienceMatches(payload.aud) ||
    !Number.isFinite(payload.exp) || payload.exp < nowSeconds - skew ||
    (Number.isFinite(payload.nbf) && payload.nbf > nowSeconds + skew) ||
    (payload.azp !== undefined && payload.azp !== TESLA_CLIENT_ID) ||
    (payload.client_id !== undefined && payload.client_id !== TESLA_CLIENT_ID)
  ) {
    throw new TeslaTokenError("invalid_token");
  }
  if (!tokenScopes(payload).has("vehicle_cmds")) throw new TeslaTokenError("missing_scope");
  return { sub: typeof payload.sub === "string" ? payload.sub : null };
}
