import { DeadlineExceeded, withDeadline } from "./deadline.js";

const DOMAIN_INFOTAINMENT = 3;
const FLAG_ENCRYPT_RESPONSE = 2;
const SIGNATURE_TYPE_HMAC = 6;
const SIGNATURE_TYPE_HMAC_PERSONALIZED = 8;
const SIGNATURE_TYPE_AES_GCM_RESPONSE = 9;
const FLASH_LIGHTS_PAYLOAD = new Uint8Array([0x12, 0x03, 0xd2, 0x01, 0x00]);

export class TeslaProtocolError extends Error {
  constructor(code, { outcomeUnknown = false } = {}) {
    super(code);
    this.name = "TeslaProtocolError";
    this.code = code;
    this.outcomeUnknown = outcomeUnknown;
  }
}

export function concatBytes(...parts) {
  const normalized = parts.map((part) => part instanceof Uint8Array ? part : new Uint8Array(part));
  const result = new Uint8Array(normalized.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of normalized) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

export function bytesFromHex(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) {
    throw new TypeError("invalid_hex");
  }
  const result = new Uint8Array(hex.length / 2);
  for (let i = 0; i < result.length; i += 1) result[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return result;
}

export function hexFromBytes(bytes) {
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function encodeVarint(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("invalid_varint");
  const result = [];
  let remaining = BigInt(value);
  while (remaining >= 0x80n) {
    result.push(Number((remaining & 0x7fn) | 0x80n));
    remaining >>= 7n;
  }
  result.push(Number(remaining));
  return new Uint8Array(result);
}

function encodeKey(fieldNumber, wireType) {
  return encodeVarint(fieldNumber * 8 + wireType);
}

function fieldBytes(fieldNumber, value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  return concatBytes(encodeKey(fieldNumber, 2), encodeVarint(bytes.length), bytes);
}

function fieldVarint(fieldNumber, value) {
  return concatBytes(encodeKey(fieldNumber, 0), encodeVarint(value));
}

function fieldFixed32(fieldNumber, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TypeError("invalid_fixed32");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return concatBytes(encodeKey(fieldNumber, 5), bytes);
}

function readVarint(bytes, start) {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  for (let count = 0; count < 10; count += 1) {
    if (offset >= bytes.length) throw new TeslaProtocolError("invalid_protobuf");
    const current = bytes[offset];
    offset += 1;
    value |= BigInt(current & 0x7f) << shift;
    if ((current & 0x80) === 0) {
      if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TeslaProtocolError("invalid_protobuf");
      return { value: Number(value), offset };
    }
    shift += 7n;
  }
  throw new TeslaProtocolError("invalid_protobuf");
}

function parseFields(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const fields = [];
  let offset = 0;
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset);
    offset = key.offset;
    const fieldNumber = Math.floor(key.value / 8);
    const wireType = key.value % 8;
    if (fieldNumber <= 0) throw new TeslaProtocolError("invalid_protobuf");
    if (wireType === 0) {
      const item = readVarint(bytes, offset);
      offset = item.offset;
      fields.push({ fieldNumber, wireType, value: item.value });
    } else if (wireType === 2) {
      const length = readVarint(bytes, offset);
      offset = length.offset;
      if (length.value > bytes.length - offset) throw new TeslaProtocolError("invalid_protobuf");
      fields.push({ fieldNumber, wireType, value: bytes.slice(offset, offset + length.value) });
      offset += length.value;
    } else if (wireType === 5) {
      if (offset + 4 > bytes.length) throw new TeslaProtocolError("invalid_protobuf");
      fields.push({ fieldNumber, wireType, value: new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true) });
      offset += 4;
    } else if (wireType === 1) {
      if (offset + 8 > bytes.length) throw new TeslaProtocolError("invalid_protobuf");
      offset += 8;
    } else {
      throw new TeslaProtocolError("invalid_protobuf");
    }
  }
  return fields;
}

function firstField(fields, fieldNumber, wireType) {
  return fields.find((field) => field.fieldNumber === fieldNumber && field.wireType === wireType)?.value;
}

function equalBytes(left, right) {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array) || left.length !== right.length) return false;
  let difference = 0;
  for (let i = 0; i < left.length; i += 1) difference |= left[i] ^ right[i];
  return difference === 0;
}

function uint32BigEndian(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new TeslaProtocolError("invalid_session");
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, false);
  return bytes;
}

function destinationDomain(domain) {
  return fieldVarint(1, domain);
}

function destinationRouting(routingAddress) {
  if (!(routingAddress instanceof Uint8Array) || routingAddress.length !== 16) throw new TypeError("invalid_routing_address");
  return fieldBytes(2, routingAddress);
}

function parseDestination(bytes) {
  if (!(bytes instanceof Uint8Array)) return {};
  const fields = parseFields(bytes);
  return {
    domain: firstField(fields, 1, 0),
    routing: firstField(fields, 2, 2),
  };
}

function decodeSignatureData(bytes) {
  if (!(bytes instanceof Uint8Array)) return {};
  const fields = parseFields(bytes);
  const sessionTagData = firstField(fields, 6, 2);
  const hmacData = firstField(fields, 8, 2);
  const aesResponseData = firstField(fields, 9, 2);
  const result = {};
  if (sessionTagData) result.sessionInfoTag = firstField(parseFields(sessionTagData), 1, 2);
  if (hmacData) {
    const nested = parseFields(hmacData);
    result.hmacPersonalized = {
      epoch: firstField(nested, 1, 2),
      counter: firstField(nested, 2, 0) ?? 0,
      expiresAt: firstField(nested, 3, 5) ?? 0,
      tag: firstField(nested, 4, 2),
    };
  }
  if (aesResponseData) {
    const nested = parseFields(aesResponseData);
    result.aesResponse = {
      nonce: firstField(nested, 1, 2),
      counter: firstField(nested, 2, 0) ?? 0,
      tag: firstField(nested, 3, 2),
    };
  }
  return result;
}

export function decodeRoutableMessage(bytes) {
  const fields = parseFields(bytes);
  const to = parseDestination(firstField(fields, 6, 2));
  const from = parseDestination(firstField(fields, 7, 2));
  const statusBytes = firstField(fields, 12, 2);
  let operationStatus = 0;
  let messageFault = 0;
  if (statusBytes) {
    const statusFields = parseFields(statusBytes);
    operationStatus = firstField(statusFields, 1, 0) ?? 0;
    messageFault = firstField(statusFields, 2, 0) ?? 0;
  }
  const sessionRequest = firstField(fields, 14, 2);
  return {
    toDomain: to.domain,
    toRouting: to.routing,
    fromDomain: from.domain,
    fromRouting: from.routing,
    protobufMessage: firstField(fields, 10, 2),
    operationStatus,
    messageFault,
    signature: decodeSignatureData(firstField(fields, 13, 2)),
    sessionInfoRequestPublicKey: sessionRequest ? firstField(parseFields(sessionRequest), 1, 2) : undefined,
    sessionInfo: firstField(fields, 15, 2),
    requestUuid: firstField(fields, 50, 2),
    uuid: firstField(fields, 51, 2),
    flags: firstField(fields, 52, 0) ?? 0,
  };
}

function encodeMetadata(entries) {
  const parts = [];
  for (const [tag, raw] of [...entries].sort((left, right) => left[0] - right[0])) {
    const value = raw instanceof Uint8Array ? raw : new Uint8Array(raw);
    if (!Number.isInteger(tag) || tag < 0 || tag >= 255 || value.length > 255) throw new TypeError("invalid_metadata");
    parts.push(new Uint8Array([tag, value.length]), value);
  }
  parts.push(new Uint8Array([0xff]));
  return concatBytes(...parts);
}

export function buildCommandMetadata({ vin, epoch, expiresAt, counter, flags }) {
  return encodeMetadata([
    [0, new Uint8Array([SIGNATURE_TYPE_HMAC_PERSONALIZED])],
    [1, new Uint8Array([DOMAIN_INFOTAINMENT])],
    [2, new TextEncoder().encode(vin)],
    [3, epoch],
    [4, uint32BigEndian(expiresAt)],
    [5, uint32BigEndian(counter)],
    ...(flags === 0 ? [] : [[7, uint32BigEndian(flags)]]),
  ]);
}

function buildResponseMetadata({ vin, counter, flags, requestHash, fault }) {
  return encodeMetadata([
    [0, new Uint8Array([SIGNATURE_TYPE_AES_GCM_RESPONSE])],
    [1, new Uint8Array([DOMAIN_INFOTAINMENT])],
    [2, new TextEncoder().encode(vin)],
    [5, uint32BigEndian(counter)],
    [7, uint32BigEndian(flags)],
    [8, requestHash],
    [9, uint32BigEndian(fault)],
  ]);
}

async function importHmacKey(keyBytes) {
  return crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

async function hmac(keyBytes, data) {
  const key = await importHmacKey(keyBytes);
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, data));
}

async function verifyHmac(keyBytes, tag, data) {
  if (!(tag instanceof Uint8Array) || tag.length !== 32) return false;
  const key = await importHmacKey(keyBytes);
  return crypto.subtle.verify("HMAC", key, tag, data);
}

export async function deriveSharedKey(privateKey, vehiclePublicKey) {
  if (!(vehiclePublicKey instanceof Uint8Array) || vehiclePublicKey.length !== 65 || vehiclePublicKey[0] !== 4) {
    throw new TeslaProtocolError("invalid_vehicle_public_key");
  }
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      "raw",
      vehiclePublicKey,
      { name: "ECDH", namedCurve: "P-256" },
      false,
      [],
    );
  } catch {
    throw new TeslaProtocolError("invalid_vehicle_public_key");
  }
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: publicKey }, privateKey, 256));
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-1", secret));
  return digest.slice(0, 16);
}

function decodeBase64Url(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new TeslaProtocolError("invalid_private_key");
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function decodePemPkcs8(pem) {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PRIVATE KEY-----") || !pem.includes("-----END PRIVATE KEY-----")) {
    throw new TeslaProtocolError("invalid_private_key");
  }
  const base64 = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");
  if (!base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new TeslaProtocolError("invalid_private_key");
  try {
    return Uint8Array.from(atob(base64), (character) => character.charCodeAt(0));
  } catch {
    throw new TeslaProtocolError("invalid_private_key");
  }
}

export async function importCommandPrivateKey(pem) {
  let privateKey;
  try {
    privateKey = await crypto.subtle.importKey(
      "pkcs8",
      decodePemPkcs8(pem),
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    );
  } catch (error) {
    if (error instanceof TeslaProtocolError) throw error;
    throw new TeslaProtocolError("invalid_private_key");
  }
  const jwk = await crypto.subtle.exportKey("jwk", privateKey);
  const x = decodeBase64Url(jwk.x);
  const y = decodeBase64Url(jwk.y);
  if (x.length !== 32 || y.length !== 32 || !jwk.d) throw new TeslaProtocolError("invalid_private_key");
  return { privateKey, publicKey: concatBytes(new Uint8Array([4]), x, y) };
}

function parseSessionInfo(bytes) {
  const fields = parseFields(bytes);
  const session = {
    counter: firstField(fields, 1, 0) ?? 0,
    vehiclePublicKey: firstField(fields, 2, 2),
    epoch: firstField(fields, 3, 2),
    clockTime: firstField(fields, 4, 5) ?? 0,
    status: firstField(fields, 5, 0) ?? 0,
  };
  if (
    session.status !== 0 ||
    !(session.vehiclePublicKey instanceof Uint8Array) || session.vehiclePublicKey.length !== 65 ||
    !(session.epoch instanceof Uint8Array) || session.epoch.length !== 16 ||
    !Number.isInteger(session.counter) || session.counter < 0 || session.counter >= 0xffffffff ||
    !Number.isInteger(session.clockTime) || session.clockTime < 0 || session.clockTime > 0xffffffff - 5
  ) {
    throw new TeslaProtocolError(session.status === 1 ? "key_not_paired" : "invalid_session");
  }
  return session;
}

export async function verifySessionInfo({ privateKey, vin, challenge, sessionInfoBytes, sessionInfoTag }) {
  if (!(challenge instanceof Uint8Array) || challenge.length !== 16 || !(sessionInfoBytes instanceof Uint8Array)) {
    throw new TeslaProtocolError("invalid_session");
  }
  const session = parseSessionInfo(sessionInfoBytes);
  const sharedKey = await deriveSharedKey(privateKey, session.vehiclePublicKey);
  const authKey = await hmac(sharedKey, new TextEncoder().encode("session info"));
  const metadata = encodeMetadata([
    [0, new Uint8Array([SIGNATURE_TYPE_HMAC])],
    [2, new TextEncoder().encode(vin)],
    [6, challenge],
  ]);
  const authenticated = concatBytes(metadata, sessionInfoBytes);
  if (!(await verifyHmac(authKey, sessionInfoTag, authenticated))) throw new TeslaProtocolError("session_auth_failed");
  return { ...session, sharedKey };
}

export function buildHandshakeRequest({ publicKey, routingAddress, challenge }) {
  if (!(publicKey instanceof Uint8Array) || publicKey.length !== 65 || publicKey[0] !== 4) throw new TypeError("invalid_public_key");
  if (!(challenge instanceof Uint8Array) || challenge.length !== 16) throw new TypeError("invalid_challenge");
  const sessionRequest = fieldBytes(1, publicKey);
  return concatBytes(
    fieldBytes(6, destinationDomain(DOMAIN_INFOTAINMENT)),
    fieldBytes(7, destinationRouting(routingAddress)),
    fieldBytes(14, sessionRequest),
    fieldBytes(51, challenge),
  );
}

export function buildFlashLightsPayload() {
  return FLASH_LIGHTS_PAYLOAD.slice();
}

async function buildSignedCommand({ publicKey, sharedKey, vin, epoch, clockTime, sessionCounter, routingAddress, uuid }) {
  const payload = buildFlashLightsPayload();
  const counter = sessionCounter + 1;
  const expiresAt = clockTime + 5;
  const metadata = buildCommandMetadata({ vin, epoch, expiresAt, counter, flags: FLAG_ENCRYPT_RESPONSE });
  const commandKey = await hmac(sharedKey, new TextEncoder().encode("authenticated command"));
  const tag = await hmac(commandKey, concatBytes(metadata, payload));
  const signerIdentity = fieldBytes(1, publicKey);
  const personalized = concatBytes(
    fieldBytes(1, epoch),
    fieldVarint(2, counter),
    fieldFixed32(3, expiresAt),
    fieldBytes(4, tag),
  );
  const signatureData = concatBytes(fieldBytes(1, signerIdentity), fieldBytes(8, personalized));
  const message = concatBytes(
    fieldBytes(6, destinationDomain(DOMAIN_INFOTAINMENT)),
    fieldBytes(7, destinationRouting(routingAddress)),
    fieldBytes(10, payload),
    fieldBytes(13, signatureData),
    fieldBytes(51, uuid),
    fieldVarint(52, FLAG_ENCRYPT_RESPONSE),
  );
  return { message, tag };
}

export async function buildSignedCommandForTest(options) {
  return buildSignedCommand(options);
}

function parseCarServerResponse(payload) {
  if (!(payload instanceof Uint8Array) || payload.length === 0) throw new TeslaProtocolError("missing_action_status");
  const responseFields = parseFields(payload);
  const actionStatusBytes = firstField(responseFields, 1, 2);
  if (!(actionStatusBytes instanceof Uint8Array)) throw new TeslaProtocolError("missing_action_status");
  const statusFields = parseFields(actionStatusBytes);
  const result = firstField(statusFields, 1, 0) ?? 0;
  if (result === 0) return { ok: true };
  if (result === 1) throw new TeslaProtocolError("command_rejected");
  throw new TeslaProtocolError("invalid_action_status");
}

export async function decryptCommandResponse({ encodedResponse, sharedKey, vin, routingAddress, requestUuid, requestTag }) {
  const response = decodeRoutableMessage(encodedResponse);
  if (
    !equalBytes(response.toRouting, routingAddress) ||
    response.fromDomain !== DOMAIN_INFOTAINMENT ||
    !equalBytes(response.requestUuid, requestUuid)
  ) {
    throw new TeslaProtocolError("response_mismatch");
  }
  if (response.operationStatus !== 0 || response.messageFault !== 0) {
    throw new TeslaProtocolError(`vehicle_protocol_fault_${response.messageFault || response.operationStatus}`);
  }
  if (!(response.protobufMessage instanceof Uint8Array)) throw new TeslaProtocolError("missing_command_response");

  const aesResponse = response.signature.aesResponse;
  if (
    !(aesResponse?.nonce instanceof Uint8Array) || aesResponse.nonce.length !== 12 ||
    !(aesResponse.tag instanceof Uint8Array) || aesResponse.tag.length !== 16 ||
    !Number.isInteger(aesResponse.counter) || aesResponse.counter < 0
  ) {
    throw new TeslaProtocolError("invalid_encrypted_response");
  }
  const requestHash = concatBytes(new Uint8Array([SIGNATURE_TYPE_HMAC_PERSONALIZED]), requestTag);
  const metadata = buildResponseMetadata({
    vin,
    counter: aesResponse.counter,
    flags: response.flags,
    requestHash,
    fault: response.messageFault,
  });
  const aad = new Uint8Array(await crypto.subtle.digest("SHA-256", metadata));
  const key = await crypto.subtle.importKey("raw", sharedKey, { name: "AES-GCM" }, false, ["decrypt"]);
  let payload;
  try {
    payload = new Uint8Array(await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: aesResponse.nonce, additionalData: aad, tagLength: 128 },
      key,
      concatBytes(response.protobufMessage, aesResponse.tag),
    ));
  } catch {
    throw new TeslaProtocolError("response_auth_failed");
  }
  return parseCarServerResponse(payload);
}

export async function interpretCommandResponse(parameters) {
  try {
    return await decryptCommandResponse(parameters);
  } catch (error) {
    if (error instanceof TeslaProtocolError && error.code === "command_rejected") throw error;
    if (error instanceof TeslaProtocolError) {
      throw new TeslaProtocolError(error.code, { outcomeUnknown: true });
    }
    throw new TeslaProtocolError("command_outcome_unknown", { outcomeUnknown: true });
  }
}

function randomBytes(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return bytes;
}

function base64Encode(bytes) {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function base64Decode(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 131072 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new TeslaProtocolError("invalid_tesla_response");
  }
  try {
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch {
    throw new TeslaProtocolError("invalid_tesla_response");
  }
}

async function readBoundedResponseText(response, setReader) {
  if (!response.body || typeof response.body.getReader !== "function") {
    const text = await response.text();
    if (text.length > 262144) throw new Error("oversized");
    return text;
  }
  const reader = response.body.getReader();
  setReader(reader);
  const chunks = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
    length += chunk.length;
    if (length > 262144) {
      void reader.cancel().catch(() => {});
      throw new Error("oversized");
    }
    chunks.push(chunk);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function signedCommandRequest(fetchImpl, apiBase, vin, token, message, { outcomeUnknown, timeoutMs = 8_000 }) {
  const controller = new AbortController();
  let reader;
  try {
    return await withDeadline(async () => {
      let response;
      try {
        response = await fetchImpl(`${apiBase}/api/1/vehicles/${encodeURIComponent(vin)}/signed_command`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ routable_message: base64Encode(message) }),
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        throw new TeslaProtocolError(outcomeUnknown ? "command_outcome_unknown" : "tesla_unavailable", { outcomeUnknown });
      }
      if (!response.ok) {
        const explicitRejection = response.status >= 400 && response.status < 500 && response.status !== 408;
        throw new TeslaProtocolError(`tesla_http_${response.status}`, {
          outcomeUnknown: outcomeUnknown && !explicitRejection,
        });
      }
      let body;
      try {
        const text = await readBoundedResponseText(response, (value) => { reader = value; });
        body = JSON.parse(text);
      } catch {
        throw new TeslaProtocolError("invalid_tesla_response", { outcomeUnknown });
      }
      try {
        return base64Decode(body?.response);
      } catch {
        throw new TeslaProtocolError("invalid_tesla_response", { outcomeUnknown });
      }
    }, timeoutMs, () => {
      controller.abort();
      if (reader) void reader.cancel().catch(() => {});
    });
  } catch (error) {
    if (error instanceof TeslaProtocolError) throw error;
    if (error instanceof DeadlineExceeded) {
      throw new TeslaProtocolError(outcomeUnknown ? "command_outcome_unknown" : "tesla_unavailable", { outcomeUnknown });
    }
    throw new TeslaProtocolError(outcomeUnknown ? "command_outcome_unknown" : "tesla_unavailable", { outcomeUnknown });
  }
}

export async function sendSignedCommandRequestForTest({
  fetchImpl,
  apiBase,
  vin,
  token,
  message,
  outcomeUnknown,
  timeoutMs,
}) {
  return signedCommandRequest(fetchImpl, apiBase, vin, token, message, { outcomeUnknown, timeoutMs });
}

export async function executeTeslaSignedFlash({ fetchImpl, apiBase, token, vin, privateKeyPem, requestTimeoutMs = 8_000 }) {
  const { privateKey, publicKey } = await importCommandPrivateKey(privateKeyPem);
  const routingAddress = randomBytes(16);
  const challenge = randomBytes(16);
  const handshake = buildHandshakeRequest({ publicKey, routingAddress, challenge });
  const handshakeBytes = await signedCommandRequest(fetchImpl, apiBase, vin, token, handshake, {
    outcomeUnknown: false,
    timeoutMs: requestTimeoutMs,
  });
  const handshakeResponse = decodeRoutableMessage(handshakeBytes);
  if (
    !equalBytes(handshakeResponse.toRouting, routingAddress) ||
    handshakeResponse.fromDomain !== DOMAIN_INFOTAINMENT ||
    !equalBytes(handshakeResponse.requestUuid, challenge) ||
    handshakeResponse.operationStatus !== 0 || handshakeResponse.messageFault !== 0 ||
    !(handshakeResponse.sessionInfo instanceof Uint8Array) ||
    !(handshakeResponse.signature.sessionInfoTag instanceof Uint8Array)
  ) {
    throw new TeslaProtocolError("invalid_handshake_response");
  }
  const session = await verifySessionInfo({
    privateKey,
    vin,
    challenge,
    sessionInfoBytes: handshakeResponse.sessionInfo,
    sessionInfoTag: handshakeResponse.signature.sessionInfoTag,
  });
  const commandUuid = randomBytes(16);
  const command = await buildSignedCommand({
    publicKey,
    sharedKey: session.sharedKey,
    vin,
    epoch: session.epoch,
    clockTime: session.clockTime,
    sessionCounter: session.counter,
    routingAddress,
    uuid: commandUuid,
  });
  const responseBytes = await signedCommandRequest(fetchImpl, apiBase, vin, token, command.message, {
    outcomeUnknown: true,
    timeoutMs: requestTimeoutMs,
  });
  return interpretCommandResponse({
    encodedResponse: responseBytes,
    sharedKey: session.sharedKey,
    vin,
    routingAddress,
    requestUuid: commandUuid,
    requestTag: command.tag,
  });
}

export function encodeCommandResponseForTest({ result }) {
  const actionStatus = result === 0 ? new Uint8Array() : fieldVarint(1, result);
  return fieldBytes(1, actionStatus);
}

export async function encodeRoutableMessageForTest({
  sharedKey,
  vin,
  routingAddress,
  requestUuid,
  requestTag,
  responsePayload,
  responseCounter,
}) {
  const nonce = new Uint8Array(12);
  for (let i = 0; i < nonce.length; i += 1) nonce[i] = i;
  const requestHash = concatBytes(new Uint8Array([SIGNATURE_TYPE_HMAC_PERSONALIZED]), requestTag);
  const metadata = buildResponseMetadata({ vin, counter: responseCounter, flags: 0, requestHash, fault: 0 });
  const aad = new Uint8Array(await crypto.subtle.digest("SHA-256", metadata));
  const key = await crypto.subtle.importKey("raw", sharedKey, { name: "AES-GCM" }, false, ["encrypt"]);
  const encrypted = new Uint8Array(await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: aad, tagLength: 128 },
    key,
    responsePayload,
  ));
  const ciphertext = encrypted.slice(0, -16);
  const tag = encrypted.slice(-16);
  const responseSignature = concatBytes(fieldBytes(1, nonce), fieldVarint(2, responseCounter), fieldBytes(3, tag));
  const signatureData = fieldBytes(9, responseSignature);
  return concatBytes(
    fieldBytes(6, destinationRouting(routingAddress)),
    fieldBytes(7, destinationDomain(DOMAIN_INFOTAINMENT)),
    fieldBytes(10, ciphertext),
    fieldBytes(13, signatureData),
    fieldBytes(50, requestUuid),
  );
}
