import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import test from "node:test";

import { verifyTeslaAccessToken } from "../functions/_lib/tesla-jwt.js";

globalThis.crypto ??= webcrypto;

const ISSUER = "https://auth.tesla.com/oauth2/v3/nts";
const AUDIENCE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";

function b64url(value) {
  return Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");
}

async function fixture() {
  const pair = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicJwk.kid = "test-key";
  publicJwk.alg = "RS256";
  publicJwk.use = "sig";

  async function token(overrides = {}) {
    const now = 1_800_000_000;
    const header = b64url({ alg: "RS256", typ: "JWT", kid: "test-key" });
    const body = b64url({
      iss: ISSUER,
      aud: AUDIENCE,
      azp: CLIENT_ID,
      sub: "owner-1",
      scope: "openid vehicle_device_data vehicle_cmds",
      iat: now - 10,
      exp: now + 300,
      ...overrides,
    });
    const input = `${header}.${body}`;
    const signature = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", pair.privateKey, new TextEncoder().encode(input));
    return `${input}.${Buffer.from(signature).toString("base64url")}`;
  }

  return {
    token,
    fetchJwks: async () => new Response(JSON.stringify({ keys: [publicJwk] }), { status: 200 }),
  };
}

test("accepts a correctly signed Tesla token with vehicle_cmds", async () => {
  const f = await fixture();
  const claims = await verifyTeslaAccessToken(await f.token(), {
    fetchImpl: f.fetchJwks,
    nowSeconds: 1_800_000_000,
  });
  assert.equal(claims.sub, "owner-1");
});

test("JWKS retrieval is bounded by an abort signal", async () => {
  const f = await fixture();
  let bounded = false;
  await verifyTeslaAccessToken(await f.token(), {
    fetchImpl: async (_url, options) => {
      bounded = options.signal instanceof AbortSignal;
      return f.fetchJwks();
    },
    nowSeconds: 1_800_000_000,
  });
  assert.equal(bounded, true);
});

test("JWKS response body must finish before the deadline", async () => {
  const f = await fixture();
  const neverEndingBody = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"keys":['));
    },
  });
  const started = Date.now();
  await assert.rejects(
    verifyTeslaAccessToken(await f.token(), {
      fetchImpl: async () => new Response(neverEndingBody, { status: 200 }),
      nowSeconds: 1_800_000_000,
      jwksTimeoutMs: 20,
    }),
    /token_verification_unavailable/,
  );
  assert.ok(Date.now() - started < 500);
});

test("rejects a signed token missing vehicle_cmds", async () => {
  const f = await fixture();
  await assert.rejects(
    verifyTeslaAccessToken(await f.token({ scope: "openid vehicle_device_data" }), {
      fetchImpl: f.fetchJwks,
      nowSeconds: 1_800_000_000,
    }),
    /missing_scope/,
  );
});

test("rejects wrong issuer, audience, client, expiry, and tampering", async () => {
  const f = await fixture();
  const cases = [
    f.token({ iss: "https://attacker.invalid" }),
    f.token({ aud: "https://attacker.invalid" }),
    f.token({ azp: "another-client" }),
    f.token({ exp: 1_799_999_000 }),
  ];
  for (const candidate of await Promise.all(cases)) {
    await assert.rejects(
      verifyTeslaAccessToken(candidate, { fetchImpl: f.fetchJwks, nowSeconds: 1_800_000_000 }),
    );
  }

  const valid = await f.token();
  const [header, payload, signature] = valid.split(".");
  const altered = `${header}.${payload.slice(0, -1)}A.${signature}`;
  await assert.rejects(
    verifyTeslaAccessToken(altered, { fetchImpl: f.fetchJwks, nowSeconds: 1_800_000_000 }),
    /invalid_token/,
  );
});
