import { UpdateBudget } from "./budget.js";
import {
  APK_KEYS,
  MANIFEST_KEY,
  MAX_MANIFEST_BYTES,
  RELEASE_NAMES,
  expectedApkMetadata,
  isLowerHexSha256,
  parseManifestText,
} from "./manifest.js";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BUDGET_OBJECT_NAME = "hataepilot-update-budget-v1";
const FORM_LIMIT_BYTES = 2 * 1024;

const NO_STORE_HEADERS = Object.freeze({
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
});

function jsonError(status, code, extraHeaders = {}) {
  return new Response(JSON.stringify({ ok: false, code }), {
    status,
    headers: {
      ...NO_STORE_HEADERS,
      "Content-Type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

function hasWorkerConfiguration(env) {
  return /^[0-9a-f]{64}$/.test(env?.UPDATE_TOKEN_SHA256 ?? "")
    && typeof env?.UPDATES_BUCKET?.get === "function"
    && typeof env?.UPDATE_BUDGET?.idFromName === "function"
    && typeof env?.UPDATE_BUDGET?.get === "function";
}

function isCanonicalToken(token) {
  if (typeof token !== "string" || !TOKEN_PATTERN.test(token)) return false;
  try {
    const base64 = token.replaceAll("-", "+").replaceAll("_", "/") + "=";
    const decoded = atob(base64);
    if (decoded.length !== 32) return false;
    const canonical = btoa(decoded).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
    return canonical === token;
  } catch {
    return false;
  }
}

export function constantTimeHexEqual(left, right) {
  if (typeof left !== "string" || typeof right !== "string" || left.length !== 64 || right.length !== 64) {
    return false;
  }
  let difference = 0;
  for (let index = 0; index < 64; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

async function authenticateToken(token, expectedHash) {
  if (!isCanonicalToken(token)) return false;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token));
  const actualHash = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeHexEqual(actualHash, expectedHash);
}

function bearerToken(request) {
  const authorization = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
  return match?.[1] ?? null;
}

function hasOnlyQuery(url, expectedName) {
  const entries = [...url.searchParams.entries()];
  return entries.length === 1 && entries[0][0] === expectedName;
}

async function readLimitedText(request, maximumBytes) {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error("body_too_large");
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("body_too_large");
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Nothing to retry. */ }
    throw error;
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function parsePostDownload(request, url) {
  if (url.search !== "") throw new Error("invalid_form");
  if (request.headers.get("origin") !== url.origin || request.headers.get("sec-fetch-site") !== "same-origin") {
    throw new Error("invalid_origin");
  }
  const contentType = request.headers.get("content-type") ?? "";
  if (!/^application\/x-www-form-urlencoded(?:\s*;\s*charset=UTF-8)?$/iu.test(contentType)) {
    throw new Error("invalid_form");
  }
  const text = await readLimitedText(request, FORM_LIMIT_BYTES);
  const fields = new URLSearchParams(text);
  const keys = [...fields.keys()].sort();
  if (keys.length !== 3 || keys[0] !== "parked" || keys[1] !== "sha" || keys[2] !== "token") {
    throw new Error("invalid_form");
  }
  for (const key of ["parked", "sha", "token"]) {
    if (fields.getAll(key).length !== 1) throw new Error("invalid_form");
  }
  if (fields.get("parked") !== "true") throw new Error("parking_required");
  return { token: fields.get("token"), sha: fields.get("sha") };
}

async function reserve(env, kind, bytes) {
  let response;
  try {
    const id = env.UPDATE_BUDGET.idFromName(BUDGET_OBJECT_NAME);
    const stub = env.UPDATE_BUDGET.get(id);
    response = await stub.fetch(new Request("https://update-budget.invalid/reserve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind, bytes }),
    }));
  } catch {
    return { error: jsonError(503, "budget_unavailable") };
  }

  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after");
    if (!retryAfter || !/^\d+$/.test(retryAfter)) return { error: jsonError(503, "budget_unavailable") };
    return { error: jsonError(429, "quota_exceeded", { "Retry-After": retryAfter }) };
  }
  if (!response.ok) return { error: jsonError(503, "budget_unavailable") };
  try {
    const body = await response.json();
    if (Object.keys(body).length !== 1 || body.ok !== true) throw new Error("invalid_budget_response");
  } catch {
    return { error: jsonError(503, "budget_unavailable") };
  }
  return { error: null };
}

async function cancelBody(object) {
  try { await object?.body?.cancel?.(); } catch { /* A rejected object is never retried. */ }
}

async function loadManifest(env) {
  let object;
  try {
    object = await env.UPDATES_BUCKET.get(MANIFEST_KEY);
  } catch {
    return { error: jsonError(503, "storage_unavailable") };
  }
  if (!object
      || object.key !== MANIFEST_KEY
      || !Number.isSafeInteger(object.size)
      || object.size <= 0
      || object.size > MAX_MANIFEST_BYTES
      || object.storageClass !== "Standard"
      || object.httpMetadata?.contentType !== "application/json") {
    await cancelBody(object);
    return { error: jsonError(503, "invalid_manifest") };
  }

  try {
    const text = await object.text();
    if (new TextEncoder().encode(text).byteLength !== object.size) throw new Error("manifest_size_mismatch");
    return { manifest: parseManifestText(text), error: null };
  } catch {
    return { error: jsonError(503, "invalid_manifest") };
  }
}

async function authorizedBearer(request, env) {
  const token = bearerToken(request);
  return token !== null && await authenticateToken(token, env.UPDATE_TOKEN_SHA256);
}

function unauthorized() {
  return jsonError(401, "unauthorized", { "WWW-Authenticate": 'Bearer realm="hataepilot-updates"' });
}

async function serveManifest(request, env, url) {
  if (request.method !== "GET") return jsonError(405, "method_not_allowed", { Allow: "GET" });
  if (url.search !== "") return jsonError(400, "invalid_query");
  if (!await authorizedBearer(request, env)) return unauthorized();

  const reservation = await reserve(env, "lookup", 0);
  if (reservation.error) return reservation.error;
  const loaded = await loadManifest(env);
  if (loaded.error) return loaded.error;
  return new Response(JSON.stringify(loaded.manifest), {
    status: 200,
    headers: { ...NO_STORE_HEADERS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function downloadRequestData(request, env, url) {
  if (request.method === "GET") {
    if (!await authorizedBearer(request, env)) return { error: unauthorized() };
    if (!hasOnlyQuery(url, "sha")) return { error: jsonError(400, "invalid_query") };
    return { sha: url.searchParams.get("sha"), error: null };
  }
  if (request.method === "POST") {
    let values;
    try {
      values = await parsePostDownload(request, url);
    } catch (error) {
      if (error.message === "body_too_large") return { error: jsonError(413, "body_too_large") };
      if (error.message === "invalid_origin") return { error: jsonError(403, "invalid_origin") };
      if (error.message === "parking_required") return { error: jsonError(409, "parking_required") };
      return { error: jsonError(400, "invalid_form") };
    }
    if (!await authenticateToken(values.token, env.UPDATE_TOKEN_SHA256)) return { error: unauthorized() };
    return { sha: values.sha, error: null };
  }
  return { error: jsonError(405, "method_not_allowed", { Allow: "GET, POST" }) };
}

async function serveApk(request, env, url, releaseName) {
  const requestData = await downloadRequestData(request, env, url);
  if (requestData.error) return requestData.error;
  if (request.headers.has("range")) return jsonError(416, "range_not_supported", { "Accept-Ranges": "none" });
  if (!isLowerHexSha256(requestData.sha)) return jsonError(400, "invalid_sha");

  const lookupReservation = await reserve(env, "lookup", 0);
  if (lookupReservation.error) return lookupReservation.error;
  const loaded = await loadManifest(env);
  if (loaded.error) return loaded.error;
  const release = loaded.manifest.releases[releaseName];
  if (requestData.sha !== release.sha256) return jsonError(409, "sha_mismatch");

  const downloadReservation = await reserve(env, "download", release.sizeBytes);
  if (downloadReservation.error) return downloadReservation.error;

  const key = APK_KEYS[releaseName];
  let object;
  try {
    object = await env.UPDATES_BUCKET.get(key);
  } catch {
    return jsonError(503, "storage_unavailable");
  }
  const expectedMetadata = expectedApkMetadata(releaseName, release);
  const metadata = object?.customMetadata ?? {};
  const expectedMetadataKeys = Object.keys(expectedMetadata).sort();
  const metadataKeys = Object.keys(metadata).sort();
  const metadataMatches = metadataKeys.length === expectedMetadataKeys.length
    && expectedMetadataKeys.every((name, index) => metadataKeys[index] === name && metadata[name] === expectedMetadata[name]);
  if (!object
      || object.key !== key
      || object.size !== release.sizeBytes
      || object.storageClass !== "Standard"
      || object.httpMetadata?.contentType !== "application/vnd.android.package-archive"
      || !metadataMatches
      || !object.body) {
    await cancelBody(object);
    return jsonError(503, "invalid_apk_object");
  }

  return new Response(object.body, {
    status: 200,
    headers: {
      ...NO_STORE_HEADERS,
      "Accept-Ranges": "none",
      "Content-Disposition": `attachment; filename="hataepilot-${releaseName}-v${release.versionCode}.apk"`,
      "Content-Length": String(release.sizeBytes),
      "Content-Type": "application/vnd.android.package-archive",
    },
  });
}

export async function handleRequest(request, env) {
  const url = new URL(request.url);
  if (url.pathname === "/updates/" && request.method === "GET" && url.search === "") {
    return new Response(null, {
      status: 302,
      headers: { ...NO_STORE_HEADERS, Location: "/app-recovery/" },
    });
  }

  const isManifest = url.pathname === "/updates/manifest";
  const releaseName = RELEASE_NAMES.find((name) => url.pathname === `/updates/apk/${name}`);
  if (!isManifest && !releaseName) return jsonError(404, "not_found");
  if (!hasWorkerConfiguration(env)) return jsonError(503, "server_not_configured");
  if (isManifest) return serveManifest(request, env, url);
  return serveApk(request, env, url, releaseName);
}

export { UpdateBudget };

export default { fetch: handleRequest };
