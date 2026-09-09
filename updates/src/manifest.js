export const PACKAGE_NAME = "com.khs.hataepilot";
export const MANIFEST_KEY = "manifest.json";
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const MAX_APK_BYTES = 192 * 1024 * 1024;
export const MAX_TOTAL_APK_BYTES = 384 * 1024 * 1024;
export const RELEASE_NAMES = Object.freeze(["current", "recovery"]);
export const APK_KEYS = Object.freeze({
  current: "current.apk",
  recovery: "recovery.apk",
});
export const DOWNLOAD_PATHS = Object.freeze({
  current: "/updates/apk/current",
  recovery: "/updates/apk/recovery",
});

const HEX_64 = /^[0-9a-f]{64}$/;
const VERSION_NAME = /^[0-9A-Za-z][0-9A-Za-z._+-]{0,63}$/;
const ISO_8601_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
const TOP_LEVEL_KEYS = Object.freeze(["packageName", "publishedAt", "releases", "schema"]);
const RELEASE_KEYS = Object.freeze([
  "certificateSha256",
  "downloadPath",
  "minSdk",
  "notes",
  "sha256",
  "sizeBytes",
  "versionCode",
  "versionName",
]);

function hasExactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSafeText(value, maximumLength) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= maximumLength
    && !/[\u0000-\u001f\u007f]/u.test(value);
}

function isStrictIso8601(value) {
  if (typeof value !== "string" || !ISO_8601_UTC.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().startsWith(value.slice(0, 19));
}

function assertRelease(name, release) {
  if (!hasExactKeys(release, RELEASE_KEYS)) throw new Error(`invalid_release_keys:${name}`);
  if (!Number.isSafeInteger(release.versionCode) || release.versionCode <= 0) {
    throw new Error(`invalid_version_code:${name}`);
  }
  if (typeof release.versionName !== "string" || !VERSION_NAME.test(release.versionName)) {
    throw new Error(`invalid_version_name:${name}`);
  }
  if (!HEX_64.test(release.sha256)) throw new Error(`invalid_sha256:${name}`);
  if (!Number.isSafeInteger(release.sizeBytes) || release.sizeBytes <= 0 || release.sizeBytes > MAX_APK_BYTES) {
    throw new Error(`invalid_size:${name}`);
  }
  if (release.downloadPath !== DOWNLOAD_PATHS[name]) throw new Error(`invalid_download_path:${name}`);
  if (!isSafeText(release.notes, 1000)) throw new Error(`invalid_notes:${name}`);
  if (release.minSdk !== 31) throw new Error(`invalid_min_sdk:${name}`);
  if (!HEX_64.test(release.certificateSha256)) throw new Error(`invalid_certificate_sha256:${name}`);
}

export function validateManifest(manifest) {
  if (!hasExactKeys(manifest, TOP_LEVEL_KEYS)) throw new Error("invalid_manifest_keys");
  if (manifest.schema !== 1) throw new Error("invalid_schema");
  if (manifest.packageName !== PACKAGE_NAME) throw new Error("invalid_package_name");
  if (!isStrictIso8601(manifest.publishedAt)) throw new Error("invalid_published_at");
  if (!hasExactKeys(manifest.releases, RELEASE_NAMES)) throw new Error("invalid_release_names");

  for (const name of RELEASE_NAMES) assertRelease(name, manifest.releases[name]);

  if (manifest.releases.recovery.versionCode <= manifest.releases.current.versionCode) {
    throw new Error("recovery_version_not_higher");
  }
  if (manifest.releases.current.certificateSha256 !== manifest.releases.recovery.certificateSha256) {
    throw new Error("certificate_mismatch_between_releases");
  }
  if (manifest.releases.current.sizeBytes + manifest.releases.recovery.sizeBytes > MAX_TOTAL_APK_BYTES) {
    throw new Error("total_apk_size_exceeded");
  }
  return manifest;
}

export function parseManifestText(text) {
  if (typeof text !== "string") throw new Error("manifest_not_text");
  if (new TextEncoder().encode(text).byteLength > MAX_MANIFEST_BYTES) throw new Error("manifest_too_large");
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch {
    throw new Error("manifest_not_json");
  }
  return validateManifest(manifest);
}

export function expectedApkMetadata(name, release) {
  if (!RELEASE_NAMES.includes(name)) throw new Error("invalid_release_name");
  return Object.freeze({
    release: name,
    sha256: release.sha256,
    "package-name": PACKAGE_NAME,
    "version-code": String(release.versionCode),
    "certificate-sha256": release.certificateSha256,
  });
}

export function isLowerHexSha256(value) {
  return typeof value === "string" && HEX_64.test(value);
}
