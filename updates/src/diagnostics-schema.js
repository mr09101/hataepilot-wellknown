import { vocabulary } from "./diagnostics-vocabulary.js";

export const DIAGNOSTIC_BYTES = 128 * 1024;
export const RETENTION_MS = 3 * 86400000;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const int = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const bool = n => typeof n === "boolean";
const optionalBool = n => n === null || bool(n);
const choice = (name, value) => vocabulary[name].includes(value);
function keys(o, required, optional = []) {
  return !!o && typeof o === "object" && !Array.isArray(o)
    && required.every(k => Object.hasOwn(o, k)) && Object.keys(o).every(k => required.includes(k) || optional.includes(k));
}
export const SNAPSHOT_BOOLS = ["running", "gpsValid", "autoStart", "carSelected", "btPermission", "btEnabled",
  "locationFine", "locationBackground", "locationEnabled", "notifications", "batteryUnrestricted",
  "kakaoEnabled", "fallbackEnabled", "enrolling", "bleKeyPaired", "bleEnabled", "vehicleExitEnabled"];
const CONTEXT_NUMBERS = { speed: [-1, 400], distance: [-1, 10000], candidates: [-1, 10000],
  gps: [-1, 1000000], rejected: [-1, 1000000], guide: [-1, 1000000], around: [-1, 1000000],
  gpsAge: [-1, 600000], callbackMs: [-1, 60000], stopSeconds: [-1, 300], vehicleAgeMs: [-1, 600000] };
const CONTEXT_BOOLS = ["selected", "heading", "foreground", "focused", "attached"];
const CONTEXT_NULL_BOOLS = ["recording", "carConnected", "carSeen", "mainProcess", "vehicleParked", "vehiclePresent", "driverDoorOpen", "vehicleLocked"];
function validContext(c) {
  return keys(c, [], ["source", "kakaoPhase", ...Object.keys(CONTEXT_NUMBERS), ...CONTEXT_BOOLS, ...CONTEXT_NULL_BOOLS])
    && Object.entries(c).every(([key, value]) => {
      if (key === "source") return choice("GuidanceSource", value);
      if (key === "kakaoPhase") return choice("KakaoReceptionPhase", value);
      if (Object.hasOwn(CONTEXT_NUMBERS, key)) return int(value, ...CONTEXT_NUMBERS[key]);
      return CONTEXT_BOOLS.includes(key) ? bool(value) : optionalBool(value);
    });
}
export function parseDiagnostic(text, now) {
  if (new TextEncoder().encode(text).byteLength > DIAGNOSTIC_BYTES) throw Error("body_too_large");
  const r = JSON.parse(text);
  if (!keys(r, ["schema", "id", "createdAtMs", "versionCode", "androidSdk", "snapshot", "events"]) ||
    r.schema !== 1 || !uuid.test(r.id) || !int(r.createdAtMs, now - RETENTION_MS, now + 60000) ||
    !int(r.versionCode, 1, 2100000000) || !int(r.androidSdk, 31, 100) ||
    !keys(r.snapshot, [...SNAPSHOT_BOOLS, "carConnected", "kakaoPhase"]) ||
    !SNAPSHOT_BOOLS.every(k => bool(r.snapshot[k])) || !optionalBool(r.snapshot.carConnected) ||
    !choice("KakaoReceptionPhase", r.snapshot.kakaoPhase) || !Array.isArray(r.events) || r.events.length > 200) {
    throw Error("invalid_report");
  }
  for (const e of r.events) {
    if (!keys(e, ["at", "stage", "kind", "reason", "component", "backend", "version", "run", "id", "mode", "volume"], ["context"]) ||
      !int(e.at, now - RETENTION_MS - 60000, now + 60000) || !int(e.version, 0, 2100000000) ||
      !int(e.mode, -1, 6) || !int(e.volume, -1, 100) || ![e.run, e.id].every(v => v === "" || (typeof v === "string" && uuid.test(v))) ||
      !choice("GuidanceStage", e.stage) || !choice("GuidanceKind", e.kind) || !choice("GuidanceReason", e.reason) ||
      !choice("GuidanceComponent", e.component) || !choice("GuidanceBackend", e.backend) ||
      (e.context !== undefined && !validContext(e.context))) throw Error("invalid_event");
  }
  return r;
}
