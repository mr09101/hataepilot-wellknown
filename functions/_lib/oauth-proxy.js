import { DeadlineExceeded, withDeadline } from "./deadline.js";

const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024;
const DEFAULT_MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_CREDENTIAL_CHARS = 16 * 1024;
const MAX_REDIRECT_URI_CHARS = 2 * 1024;

class OAuthInputError extends Error {
  constructor(code, status) {
    super(code);
    this.name = "OAuthInputError";
    this.code = code;
    this.status = status;
  }
}

class OAuthProviderError extends Error {
  constructor(code, status = 502) {
    super(code);
    this.name = "OAuthProviderError";
    this.code = code;
    this.status = status;
  }
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      Pragma: "no-cache",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isJsonContentType(value) {
  return /^application\/(?:[a-z0-9!#$&^_.+-]+\+)?json(?:\s*;|$)/i.test(value);
}

function contentLengthExceeds(request, maxBytes) {
  const raw = request.headers.get("Content-Length");
  if (raw === null || !/^\d+$/.test(raw.trim())) return false;
  return Number(raw) > maxBytes;
}

async function readBytes(stream, maxBytes, tooLargeError, onReader = () => {}) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  onReader(reader);
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      total += chunk.byteLength;
      if (total > maxBytes) {
        void reader.cancel().catch(() => {});
        throw tooLargeError;
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function decodeUtf8(bytes, error) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw error;
  }
}

async function readRequestObject(request, { maxRequestBytes, requestBodyTimeoutMs }) {
  const contentType = request.headers.get("Content-Type") ?? "";
  if (!isJsonContentType(contentType)) {
    throw new OAuthInputError("unsupported_media_type", 415);
  }
  if (contentLengthExceeds(request, maxRequestBytes)) {
    throw new OAuthInputError("request_too_large", 413);
  }

  let reader;
  let bytes;
  try {
    bytes = await withDeadline(
      () => readBytes(
        request.body,
        maxRequestBytes,
        new OAuthInputError("request_too_large", 413),
        (value) => { reader = value; },
      ),
      requestBodyTimeoutMs,
      () => { void reader?.cancel().catch(() => {}); },
    );
  } catch (error) {
    if (error instanceof OAuthInputError) throw error;
    if (error instanceof DeadlineExceeded) throw new OAuthInputError("request_timeout", 408);
    throw new OAuthInputError("invalid_request", 400);
  }

  let body;
  try {
    body = JSON.parse(decodeUtf8(bytes, new OAuthInputError("invalid_request", 400)));
  } catch (error) {
    if (error instanceof OAuthInputError) throw error;
    throw new OAuthInputError("invalid_request", 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthInputError("invalid_request", 400);
  }
  return body;
}

function boundedCredential(value, code) {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > MAX_CREDENTIAL_CHARS) {
    throw new OAuthInputError(code, 400);
  }
  return value;
}

function authorizationCodeForm(body, { audience, clientId, clientSecret, redirectUri }) {
  if (Object.keys(body).some((key) => key !== "code" && key !== "redirect_uri")) {
    throw new OAuthInputError("invalid_request", 400);
  }
  const code = boundedCredential(body.code, "invalid_code");
  const suppliedRedirect = body.redirect_uri;
  if (suppliedRedirect !== undefined && (
    typeof suppliedRedirect !== "string" ||
    suppliedRedirect.length > MAX_REDIRECT_URI_CHARS ||
    suppliedRedirect !== redirectUri
  )) {
    throw new OAuthInputError("invalid_redirect_uri", 400);
  }
  return new URLSearchParams({
    grant_type: "authorization_code",
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: suppliedRedirect ?? redirectUri,
    audience,
  });
}

function refreshTokenForm(body, { clientId, clientSecret }) {
  if (Object.keys(body).some((key) => key !== "refresh_token")) {
    throw new OAuthInputError("invalid_request", 400);
  }
  return new URLSearchParams({
    grant_type: "refresh_token",
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: boundedCredential(body.refresh_token, "invalid_refresh_token"),
  });
}

function providerErrorStatus(status) {
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : 502;
}

async function readProviderJson(response, maxResponseBytes, onReader) {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (!isJsonContentType(contentType)) {
    void response.body?.cancel().catch(() => {});
    throw new OAuthProviderError("provider_response_invalid");
  }
  const bytes = await readBytes(
    response.body,
    maxResponseBytes,
    new OAuthProviderError("provider_response_invalid"),
    onReader,
  );
  let body;
  try {
    body = JSON.parse(decodeUtf8(bytes, new OAuthProviderError("provider_response_invalid")));
  } catch (error) {
    if (error instanceof OAuthProviderError) throw error;
    throw new OAuthProviderError("provider_response_invalid");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new OAuthProviderError("provider_response_invalid");
  }
  return body;
}

export function createTeslaOAuthHandler({
  flow,
  audience,
  clientId,
  tokenEndpoint,
  redirectUri,
  fetchImpl = globalThis.fetch,
  requestBodyTimeoutMs = 2_000,
  providerTimeoutMs = 8_000,
  maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
}) {
  return async ({ request, env }) => {
    const clientSecret = env?.TESLA_CLIENT_SECRET;
    if (typeof clientSecret !== "string" || clientSecret.length === 0) {
      return json({ error: "server_not_configured" }, 500);
    }

    let body;
    let form;
    try {
      body = await readRequestObject(request, { maxRequestBytes, requestBodyTimeoutMs });
      form = flow === "authorization_code"
        ? authorizationCodeForm(body, { audience, clientId, clientSecret, redirectUri })
        : refreshTokenForm(body, { clientId, clientSecret });
    } catch (error) {
      if (error instanceof OAuthInputError) return json({ error: error.code }, error.status);
      return json({ error: "invalid_request" }, 400);
    }

    const controller = new AbortController();
    let providerReader;
    try {
      const result = await withDeadline(async () => {
        const response = await fetchImpl(tokenEndpoint, {
          method: "POST",
          headers: {
            Accept: "application/json",
            "Content-Type": "application/x-www-form-urlencoded",
          },
          body: form.toString(),
          redirect: "error",
          signal: controller.signal,
        });
        const providerBody = await readProviderJson(
          response,
          maxResponseBytes,
          (value) => { providerReader = value; },
        );
        return { response, providerBody };
      }, providerTimeoutMs, () => {
        controller.abort();
        void providerReader?.cancel().catch(() => {});
      });

      if (!result.response.ok) {
        return json(
          { error: "oauth_provider_rejected" },
          providerErrorStatus(result.response.status),
        );
      }
      return json(result.providerBody, result.response.status);
    } catch (error) {
      if (error instanceof DeadlineExceeded) return json({ error: "provider_timeout" }, 504);
      if (error instanceof OAuthProviderError) return json({ error: error.code }, error.status);
      return json({ error: "provider_unavailable" }, 502);
    }
  };
}
