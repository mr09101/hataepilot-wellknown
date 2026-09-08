import assert from "node:assert/strict";
import { createHmac, webcrypto } from "node:crypto";
import test from "node:test";

import {
  buildCommandMetadata,
  buildFlashLightsPayload,
  buildHandshakeRequest,
  buildSignedCommandForTest,
  bytesFromHex,
  concatBytes,
  decodeRoutableMessage,
  decryptCommandResponse,
  deriveSharedKey,
  encodeCommandResponseForTest,
  encodeRoutableMessageForTest,
  hexFromBytes,
  interpretCommandResponse,
  sendSignedCommandRequestForTest,
  verifySessionInfo,
} from "../functions/_lib/tesla-protocol.js";

globalThis.crypto ??= webcrypto;

const VIN = "5YJ30123456789ABC";
const CLIENT_D = "2538cdc29a97c19c1e99a637d6cf4f8c970c118b56ede1e6323e6d162c4b30db";
const CLIENT_X = "b2b6bc68c2da0665ce656815594996c62394edd8bea905fe781a754fe6a845a7";
const CLIENT_Y = "14330902f225e9269d466e05b349981fda9d85cc23c6fb444aa73b629105dc6e";
const VEHICLE_PUBLIC = "04c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d97";
const ROUTING = bytesFromHex("2c907bd76c640d360b3027dc7404efde");
const CHALLENGE = bytesFromHex("1588d5a30eabc6f8fc9a951b11f6fd11");
const SESSION_BYTES = bytesFromHex("0806124104c7a1f47138486aa4729971494878d33b1a24e39571f748a6e16c5955b3d877d3a6aaa0e955166474af5d32c410f439a2234137ad1bb085fd4e8813c958f11d971a104c463f9cc0d3d26906e982ed224adde6255a0a0000");
const SESSION_TAG = bytesFromHex("996c1fe38331be138f8039c194b14db2198846ed7d8251e6749284d7b32ea002");

function base64Url(hex) {
  return Buffer.from(hex, "hex").toString("base64url");
}

async function importClientTestKey() {
  return crypto.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64Url(CLIENT_D),
      x: base64Url(CLIENT_X),
      y: base64Url(CLIENT_Y),
      ext: true,
      key_ops: ["deriveBits"],
    },
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
}

test("official ECDH test vector derives the documented AES key", async () => {
  const clientKey = await importClientTestKey();
  const key = await deriveSharedKey(clientKey, bytesFromHex(VEHICLE_PUBLIC));
  assert.equal(hexFromBytes(key), "1b2fce19967b79db696f909cff89ea9a");
});

test("session response is accepted only with the official authentication tag", async () => {
  const clientKey = await importClientTestKey();
  const parsed = await verifySessionInfo({
    privateKey: clientKey,
    vin: VIN,
    challenge: CHALLENGE,
    sessionInfoBytes: SESSION_BYTES,
    sessionInfoTag: SESSION_TAG,
  });
  assert.equal(parsed.counter, 6);
  assert.equal(parsed.clockTime, 2650);
  assert.equal(hexFromBytes(parsed.epoch), "4c463f9cc0d3d26906e982ed224adde6");

  const altered = SESSION_TAG.slice();
  altered[0] ^= 1;
  await assert.rejects(
    verifySessionInfo({
      privateKey: clientKey,
      vin: VIN,
      challenge: CHALLENGE,
      sessionInfoBytes: SESSION_BYTES,
      sessionInfoTag: altered,
    }),
    /session_auth_failed/,
  );
});

test("handshake request binds domain, routing address, public key, and challenge", () => {
  const publicKey = concatBytes(
    new Uint8Array([4]),
    bytesFromHex(CLIENT_X),
    bytesFromHex(CLIENT_Y),
  );
  const encoded = buildHandshakeRequest({ publicKey, routingAddress: ROUTING, challenge: CHALLENGE });
  const decoded = decodeRoutableMessage(encoded);
  assert.equal(decoded.toDomain, 3);
  assert.deepEqual(decoded.fromRouting, ROUTING);
  assert.deepEqual(decoded.uuid, CHALLENGE);
  assert.deepEqual(decoded.sessionInfoRequestPublicKey, publicKey);
});

test("flash lights payload is the documented CarServer.Action encoding", () => {
  assert.equal(hexFromBytes(buildFlashLightsPayload()), "1203d20100");
});

test("HMAC command metadata matches Tesla canonical TLV encoding", () => {
  const metadata = buildCommandMetadata({
    vin: VIN,
    epoch: bytesFromHex("4c463f9cc0d3d26906e982ed224adde6"),
    expiresAt: 2655,
    counter: 7,
    flags: 2,
  });
  assert.equal(
    hexFromBytes(metadata),
    "000108010103021135594a333031323334353637383941424303104c463f9cc0d3d26906e982ed224adde6040400000a5f050400000007070400000002ff",
  );
});

test("signed flash command matches an independently calculated HMAC vector", async () => {
  const publicKey = concatBytes(new Uint8Array([4]), bytesFromHex(CLIENT_X), bytesFromHex(CLIENT_Y));
  const command = await buildSignedCommandForTest({
    publicKey,
    sharedKey: bytesFromHex("1b2fce19967b79db696f909cff89ea9a"),
    vin: VIN,
    epoch: bytesFromHex("4c463f9cc0d3d26906e982ed224adde6"),
    clockTime: 2650,
    sessionCounter: 6,
    routingAddress: ROUTING,
    uuid: bytesFromHex("58406580528b6a5301391800b4fe9b99"),
  });
  assert.equal(hexFromBytes(command.tag), "3298ac4cf9b4d7d29f3034f931e730470d07e0fd3fecf9031b6be9a9d73a4d06");
  const decoded = decodeRoutableMessage(command.message);
  assert.equal(decoded.toDomain, 3);
  assert.equal(decoded.flags, 2);
  assert.equal(hexFromBytes(decoded.protobufMessage), "1203d20100");
});

test("encrypted response matches an independently calculated AES-GCM vector", async () => {
  const sharedKey = bytesFromHex("1b2fce19967b79db696f909cff89ea9a");
  const requestTag = bytesFromHex("3298ac4cf9b4d7d29f3034f931e730470d07e0fd3fecf9031b6be9a9d73a4d06");
  const response = await encodeRoutableMessageForTest({
    sharedKey,
    vin: VIN,
    routingAddress: ROUTING,
    requestUuid: bytesFromHex("58406580528b6a5301391800b4fe9b99"),
    requestTag,
    responsePayload: bytesFromHex("0a00"),
    responseCounter: 1,
  });
  const decoded = decodeRoutableMessage(response);
  assert.equal(hexFromBytes(decoded.protobufMessage), "135c");
  assert.equal(hexFromBytes(decoded.signature.aesResponse.tag), "c9ce09dfd3ac958d67f30bafec7a3dfb");
});

test("encrypted response is authenticated against request hash and parsed", async () => {
  const sharedKey = bytesFromHex("1b2fce19967b79db696f909cff89ea9a");
  const requestTag = new Uint8Array(createHmac("sha256", Buffer.from(sharedKey)).update("request").digest());
  const commandUuid = bytesFromHex("58406580528b6a5301391800b4fe9b99");
  const responsePayload = encodeCommandResponseForTest({ result: 0 });
  const response = await encodeRoutableMessageForTest({
    sharedKey,
    vin: VIN,
    routingAddress: ROUTING,
    requestUuid: commandUuid,
    requestTag,
    responsePayload,
    responseCounter: 8,
  });

  const result = await decryptCommandResponse({
    encodedResponse: response,
    sharedKey,
    vin: VIN,
    routingAddress: ROUTING,
    requestUuid: commandUuid,
    requestTag,
  });
  assert.deepEqual(result, { ok: true });

  const wrongTag = requestTag.slice();
  wrongTag[0] ^= 1;
  await assert.rejects(
    decryptCommandResponse({
      encodedResponse: response,
      sharedKey,
      vin: VIN,
      routingAddress: ROUTING,
      requestUuid: commandUuid,
      requestTag: wrongTag,
    }),
    /response_auth_failed/,
  );
});

test("post-command gateway and malformed responses are unknown, while explicit auth rejection is known", async () => {
  const options = {
    apiBase: "https://fleet-api.prd.na.vn.cloud.tesla.com",
    vin: VIN,
    token: "test-token",
    message: new Uint8Array([1]),
    outcomeUnknown: true,
    timeoutMs: 20,
  };
  await assert.rejects(
    sendSignedCommandRequestForTest({ ...options, fetchImpl: async () => new Response("", { status: 504 }) }),
    (error) => error.outcomeUnknown === true,
  );
  await assert.rejects(
    sendSignedCommandRequestForTest({ ...options, fetchImpl: async () => new Response("{}", { status: 403 }) }),
    (error) => error.outcomeUnknown === false && error.code === "tesla_http_403",
  );
  await assert.rejects(
    sendSignedCommandRequestForTest({ ...options, fetchImpl: async () => new Response('{"response":"!"}', { status: 200 }) }),
    (error) => error.outcomeUnknown === true,
  );

  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"response":"'));
    },
  });
  await assert.rejects(
    sendSignedCommandRequestForTest({ ...options, fetchImpl: async () => new Response(body, { status: 200 }) }),
    (error) => error.outcomeUnknown === true,
  );
});

test("authenticated CarServer rejection is known but corrupt response authentication is unknown", async () => {
  const sharedKey = bytesFromHex("1b2fce19967b79db696f909cff89ea9a");
  const requestTag = bytesFromHex("3298ac4cf9b4d7d29f3034f931e730470d07e0fd3fecf9031b6be9a9d73a4d06");
  const requestUuid = bytesFromHex("58406580528b6a5301391800b4fe9b99");
  const encodedResponse = await encodeRoutableMessageForTest({
    sharedKey,
    vin: VIN,
    routingAddress: ROUTING,
    requestUuid,
    requestTag,
    responsePayload: encodeCommandResponseForTest({ result: 1 }),
    responseCounter: 8,
  });
  const parameters = { encodedResponse, sharedKey, vin: VIN, routingAddress: ROUTING, requestUuid, requestTag };
  await assert.rejects(
    interpretCommandResponse(parameters),
    (error) => error.code === "command_rejected" && error.outcomeUnknown === false,
  );

  const corrupt = encodedResponse.slice();
  corrupt[corrupt.length - 20] ^= 1;
  await assert.rejects(
    interpretCommandResponse({ ...parameters, encodedResponse: corrupt }),
    (error) => error.outcomeUnknown === true,
  );
});
