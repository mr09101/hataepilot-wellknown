import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, readFile, readdir, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import {
  APK_KEYS,
  MANIFEST_KEY,
  MAX_MANIFEST_BYTES,
  MAX_TOTAL_APK_BYTES,
  PACKAGE_NAME,
  RELEASE_NAMES,
  expectedApkMetadata,
  isLowerHexSha256,
  parseManifestText,
} from "./src/manifest.js";

export const BUCKET_NAME = "hataepilot-updates";
export const ALLOWED_KEYS = Object.freeze([MANIFEST_KEY, APK_KEYS.current, APK_KEYS.recovery].sort());
export const MAX_BUCKET_BYTES = MAX_TOTAL_APK_BYTES + MAX_MANIFEST_BYTES;
export const R2_STANDARD_FREE_STORAGE_BYTES = 10 * 1024 * 1024 * 1024;

const BOOLEAN_ARGUMENTS = new Set(["--publish", "--confirm-account-free-headroom"]);
const VALUE_ARGUMENTS = new Set([
  "--aapt",
  "--apksigner",
  "--aws",
  "--current",
  "--inventory",
  "--java",
  "--manifest",
  "--previous-version-code",
  "--recovery",
  "--trusted-certificate-sha256",
]);

export function parseArguments(argv) {
  const values = {};
  for (let index = 0; index < argv.length;) {
    const name = argv[index];
    if (!name?.startsWith("--") || Object.hasOwn(values, name)) {
      throw new Error(`invalid_argument:${name ?? "missing"}`);
    }
    if (BOOLEAN_ARGUMENTS.has(name)) {
      values[name] = true;
      index += 1;
      continue;
    }
    if (!VALUE_ARGUMENTS.has(name)) throw new Error(`unknown_argument:${name}`);
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`invalid_argument:${name ?? "missing"}`);
    }
    values[name] = value;
    index += 2;
  }
  for (const required of ["--current", "--recovery", "--manifest", "--previous-version-code", "--trusted-certificate-sha256"]) {
    if (!values[required]) throw new Error(`missing_argument:${required}`);
  }
  if (values["--confirm-account-free-headroom"] && !values["--publish"]) {
    throw new Error("free_headroom_confirmation_requires_publish");
  }
  if (values["--publish"] && !values["--confirm-account-free-headroom"]) {
    throw new Error("publish_requires_account_free_headroom_confirmation");
  }
  return values;
}

export async function sha256File(filePath) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest("hex");
}

export function parseAaptBadging(output) {
  if (/^application-debuggable(?:$|:)/mu.test(output)) throw new Error("debuggable_apk_rejected");
  const packageLine = output.match(/^package:\s+name='([^']+)'\s+versionCode='([^']+)'\s+versionName='([^']*)'/mu);
  const sdkLine = output.match(/^sdkVersion:'([^']+)'/mu);
  if (!packageLine || !sdkLine || !/^\d+$/.test(packageLine[2]) || !/^\d+$/.test(sdkLine[1])) {
    throw new Error("invalid_aapt_output");
  }
  return {
    packageName: packageLine[1],
    versionCode: Number(packageLine[2]),
    versionName: packageLine[3],
    minSdk: Number(sdkLine[1]),
  };
}

export function parseApksignerOutput(output) {
  const signerCount = output.match(/^Number of signers:\s*(\d+)$/mu);
  if (signerCount && signerCount[1] !== "1") throw new Error("invalid_signer_set");
  const digests = [...output.matchAll(/^(?:Signer #\d+ certificate|V\d+(?:\.\d+)? Signer: certificate) SHA-256 digest:\s*([0-9a-f]{64})[ \t\r]*$/gimu)]
    .map((match) => match[1].toLowerCase());
  const unique = [...new Set(digests)];
  if (unique.length !== 1) throw new Error("invalid_signer_set");
  return unique[0];
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: 4 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`command_failed:${path.basename(command)}:${result.status}`);
  return result.stdout;
}

async function fileExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function discoverBuildTools() {
  const roots = [process.env.ANDROID_HOME, process.env.ANDROID_SDK_ROOT];
  if (process.platform === "win32") roots.push(path.join(os.homedir(), "AppData", "Local", "Android", "Sdk"));
  for (const root of roots.filter(Boolean)) {
    const directory = path.join(root, "build-tools");
    let versions;
    try { versions = await readdir(directory); } catch { continue; }
    versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const base = path.join(directory, version);
      const aapt = path.join(base, process.platform === "win32" ? "aapt.exe" : "aapt");
      const apksigner = path.join(base, process.platform === "win32" ? "apksigner.bat" : "apksigner");
      if (await fileExists(aapt) && await fileExists(apksigner)) return { aapt, apksigner };
    }
  }
  return { aapt: "aapt", apksigner: "apksigner" };
}

function verifySignature(apksigner, apkPath, javaCommand, runner) {
  if (!runner && process.platform === "win32" && /\.bat$/iu.test(apksigner)) {
    const jar = path.join(path.dirname(apksigner), "lib", "apksigner.jar");
    return run(javaCommand, ["-jar", jar, "verify", "--verbose", "--print-certs", apkPath]);
  }
  return (runner ?? run)(apksigner, ["verify", "--verbose", "--print-certs", apkPath]);
}

export async function inspectApk(apkPath, options = {}) {
  const file = await stat(apkPath);
  if (!file.isFile()) throw new Error(`apk_not_file:${apkPath}`);
  const discovered = await discoverBuildTools();
  const aapt = options.aapt ?? discovered.aapt;
  const apksigner = options.apksigner ?? discovered.apksigner;
  const runner = options.runner ?? run;
  const badging = parseAaptBadging(runner(aapt, ["dump", "badging", apkPath]));
  const signerOutput = verifySignature(apksigner, apkPath, options.java ?? "java", options.runner);
  return {
    ...badging,
    certificateSha256: parseApksignerOutput(signerOutput),
    sha256: await sha256File(apkPath),
    sizeBytes: file.size,
    path: apkPath,
  };
}

export function validateArtifacts(manifest, artifacts, previousVersionCode, trustedCertificateSha256) {
  if (!Number.isSafeInteger(previousVersionCode) || previousVersionCode <= 0) throw new Error("invalid_previous_version_code");
  if (!isLowerHexSha256(trustedCertificateSha256)) throw new Error("invalid_trusted_certificate_sha256");
  if (manifest.releases.current.versionCode <= previousVersionCode) throw new Error("current_version_not_higher");
  for (const name of RELEASE_NAMES) {
    const release = manifest.releases[name];
    const artifact = artifacts[name];
    for (const field of ["versionCode", "versionName", "minSdk", "sha256", "sizeBytes", "certificateSha256"]) {
      if (artifact[field] !== release[field]) throw new Error(`apk_${field}_mismatch:${name}`);
    }
    if (artifact.packageName !== PACKAGE_NAME) throw new Error(`apk_package_mismatch:${name}`);
    if (artifact.certificateSha256 !== trustedCertificateSha256) throw new Error(`untrusted_certificate:${name}`);
  }
  const totalBytes = artifacts.current.sizeBytes + artifacts.recovery.sizeBytes;
  if (totalBytes > MAX_TOTAL_APK_BYTES) throw new Error("total_apk_size_exceeded");
  return totalBytes;
}

export function validateInventory(entries) {
  if (!Array.isArray(entries)) throw new Error("invalid_inventory");
  const keys = entries.map((entry) => typeof entry === "string" ? entry : entry?.key);
  if (keys.some((key) => typeof key !== "string" || !ALLOWED_KEYS.includes(key))) throw new Error("unexpected_r2_object");
  if (new Set(keys).size !== keys.length) throw new Error("duplicate_r2_object");
  return keys.sort();
}

export function buildUploadPlan(manifest, artifacts, manifestPath, manifestDetails = {}) {
  return [
    ...RELEASE_NAMES.map((name) => ({
      key: APK_KEYS[name],
      file: artifacts[name].path,
      sizeBytes: artifacts[name].sizeBytes,
      sha256: artifacts[name].sha256,
      storageClass: "Standard",
      contentType: "application/vnd.android.package-archive",
      customMetadata: expectedApkMetadata(name, manifest.releases[name]),
    })),
    {
      key: MANIFEST_KEY,
      file: manifestPath,
      sizeBytes: manifestDetails.sizeBytes,
      sha256: manifestDetails.sha256,
      storageClass: "Standard",
      contentType: "application/json",
      customMetadata: { schema: "1", "package-name": PACKAGE_NAME, sha256: manifestDetails.sha256 },
    },
  ];
}

function assertNonEmpty(value, name) {
  if (typeof value !== "string" || value.length === 0) throw new Error(`missing_environment:${name}`);
  return value;
}

function normalizeStorageClass(value) {
  return typeof value === "string" ? value.toUpperCase() : "";
}

function parseJsonOutput(output, operation) {
  try {
    return JSON.parse(output || "{}");
  } catch {
    throw new Error(`invalid_remote_json:${operation}`);
  }
}

function metadataArgument(metadata) {
  const entries = Object.entries(metadata).sort(([left], [right]) => left.localeCompare(right));
  for (const [key, value] of entries) {
    if (!/^[a-z0-9-]+$/u.test(key) || !/^[A-Za-z0-9._+-]+$/u.test(value)) {
      throw new Error(`invalid_upload_metadata:${key}`);
    }
  }
  return entries.map(([key, value]) => `${key}=${value}`).join(",");
}

function sha256Base64(hexDigest) {
  if (!isLowerHexSha256(hexDigest)) throw new Error("invalid_upload_sha256");
  return Buffer.from(hexDigest, "hex").toString("base64");
}

function assertPublishPlan(plan) {
  if (!Array.isArray(plan) || plan.length !== 3) throw new Error("invalid_upload_plan");
  const expectedOrder = [APK_KEYS.current, APK_KEYS.recovery, MANIFEST_KEY];
  for (let index = 0; index < expectedOrder.length; index += 1) {
    const item = plan[index];
    if (!item || item.key !== expectedOrder[index]) throw new Error("invalid_upload_order");
    if (item.storageClass !== "Standard") throw new Error(`invalid_upload_storage_class:${item.key}`);
    if (!Number.isSafeInteger(item.sizeBytes) || item.sizeBytes <= 0) throw new Error(`invalid_upload_size:${item.key}`);
    if (!isLowerHexSha256(item.sha256)) throw new Error(`invalid_upload_sha256:${item.key}`);
  }
  const totalBytes = plan.reduce((sum, item) => sum + item.sizeBytes, 0);
  if (totalBytes > MAX_BUCKET_BYTES || totalBytes > R2_STANDARD_FREE_STORAGE_BYTES) {
    throw new Error("publish_storage_envelope_exceeded");
  }
  return totalBytes;
}

function normalizeInventory(raw) {
  if (!raw || typeof raw !== "object" || raw.IsTruncated === true || !Array.isArray(raw.Contents ?? [])) {
    throw new Error("invalid_or_truncated_remote_inventory");
  }
  const entries = (raw.Contents ?? []).map((entry) => ({
    key: entry?.Key,
    size: entry?.Size,
    storageClass: entry?.StorageClass,
  }));
  validateInventory(entries);
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`invalid_remote_object_size:${entry.key}`);
    if (normalizeStorageClass(entry.storageClass) !== "STANDARD") {
      throw new Error(`non_standard_remote_object:${entry.key}`);
    }
  }
  return entries;
}

function assertStorageEnvelope(entries, plan) {
  const sizes = new Map(entries.map((entry) => [entry.key, entry.size]));
  const initialBytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
  if (initialBytes > MAX_BUCKET_BYTES) throw new Error("existing_bucket_storage_exceeded");
  for (const item of plan) {
    sizes.set(item.key, item.sizeBytes);
    const bytes = [...sizes.values()].reduce((sum, size) => sum + size, 0);
    if (bytes > MAX_BUCKET_BYTES) throw new Error(`transient_bucket_storage_exceeded:${item.key}`);
  }
}

function assertHeadObject(head, item, { requireMetadata }) {
  if (!head || typeof head !== "object") throw new Error(`invalid_head_object:${item.key}`);
  if (head.StorageClass && normalizeStorageClass(head.StorageClass) !== "STANDARD") {
    throw new Error(`non_standard_remote_object:${item.key}`);
  }
  if (!requireMetadata) return;
  if (head.ContentLength !== item.sizeBytes) throw new Error(`uploaded_size_mismatch:${item.key}`);
  if (head.ContentType !== item.contentType) throw new Error(`uploaded_content_type_mismatch:${item.key}`);
  if (head.CacheControl !== "no-store") throw new Error(`uploaded_cache_control_mismatch:${item.key}`);
  const actual = head.Metadata;
  if (!actual || typeof actual !== "object" || Array.isArray(actual)) throw new Error(`uploaded_metadata_missing:${item.key}`);
  const expectedKeys = Object.keys(item.customMetadata).sort();
  const actualKeys = Object.keys(actual).sort();
  if (expectedKeys.length !== actualKeys.length || expectedKeys.some((key, index) => key !== actualKeys[index])) {
    throw new Error(`uploaded_metadata_keys_mismatch:${item.key}`);
  }
  for (const key of expectedKeys) {
    if (actual[key] !== item.customMetadata[key]) throw new Error(`uploaded_metadata_mismatch:${item.key}:${key}`);
  }
}

async function cloudflareGet(fetchImpl, apiToken, accountId, suffix) {
  const response = await fetchImpl(`https://api.cloudflare.com/client/v4/accounts/${accountId}/r2/buckets/${encodeURIComponent(BUCKET_NAME)}${suffix}`, {
    method: "GET",
    headers: { Accept: "application/json", Authorization: `Bearer ${apiToken}` },
    redirect: "error",
  });
  if (!response?.ok) throw new Error(`cloudflare_preflight_failed:${response?.status ?? "network"}`);
  const payload = await response.json();
  if (payload?.success !== true) throw new Error("cloudflare_preflight_unsuccessful");
  return payload.result;
}

export async function preflightBucket({ accountId, apiToken, fetchImpl = fetch }) {
  if (!/^[0-9a-f]{32}$/u.test(accountId)) throw new Error("invalid_cloudflare_account_id");
  assertNonEmpty(apiToken, "CLOUDFLARE_API_TOKEN");
  const bucket = await cloudflareGet(fetchImpl, apiToken, accountId, "");
  if (bucket?.name !== BUCKET_NAME || normalizeStorageClass(bucket?.storage_class) !== "STANDARD") {
    throw new Error("bucket_not_fixed_standard");
  }
  const managedDomain = await cloudflareGet(fetchImpl, apiToken, accountId, "/domains/managed");
  if (managedDomain?.enabled !== false) throw new Error("managed_public_domain_enabled_or_unknown");
  const customResult = await cloudflareGet(fetchImpl, apiToken, accountId, "/domains/custom");
  const customDomains = Array.isArray(customResult) ? customResult : customResult?.domains;
  if (!Array.isArray(customDomains) || customDomains.length !== 0) throw new Error("custom_public_domain_configured_or_unknown");
  return { bucket: BUCKET_NAME, storageClass: "Standard", private: true };
}

function awsBaseArguments(accountId) {
  return [
    "--endpoint-url", `https://${accountId}.r2.cloudflarestorage.com`,
    "--no-cli-pager",
    "--output", "json",
  ];
}

function awsEnvironment(environment) {
  return {
    ...environment,
    AWS_ACCESS_KEY_ID: assertNonEmpty(environment.R2_ACCESS_KEY_ID, "R2_ACCESS_KEY_ID"),
    AWS_SECRET_ACCESS_KEY: assertNonEmpty(environment.R2_SECRET_ACCESS_KEY, "R2_SECRET_ACCESS_KEY"),
    AWS_DEFAULT_REGION: "auto",
    AWS_EC2_METADATA_DISABLED: "true",
    AWS_MAX_ATTEMPTS: "1",
    AWS_RETRY_MODE: "standard",
  };
}

function invokeAws(commandRunner, awsCommand, args, environment, operation) {
  return parseJsonOutput(commandRunner(awsCommand, args, { env: environment }), operation);
}

function listRemoteObjects(commandRunner, awsCommand, accountId, environment) {
  return normalizeInventory(invokeAws(commandRunner, awsCommand, [
    "s3api", "list-objects-v2",
    "--bucket", BUCKET_NAME,
    "--max-keys", "1000",
    ...awsBaseArguments(accountId),
  ], environment, "list-objects-v2"));
}

function headRemoteObject(commandRunner, awsCommand, accountId, environment, key) {
  return invokeAws(commandRunner, awsCommand, [
    "s3api", "head-object",
    "--bucket", BUCKET_NAME,
    "--key", key,
    ...awsBaseArguments(accountId),
  ], environment, `head-object:${key}`);
}

export async function publishArtifacts({
  plan,
  accountId,
  apiToken,
  environment = process.env,
  fetchImpl = fetch,
  commandRunner = run,
  awsCommand = "aws",
  accountFreeHeadroomConfirmed = false,
}) {
  const finalBytes = assertPublishPlan(plan);
  if (!accountFreeHeadroomConfirmed) throw new Error("account_free_headroom_not_confirmed");
  const credentialsEnvironment = awsEnvironment(environment);

  const bucket = await preflightBucket({ accountId, apiToken, fetchImpl });
  const before = listRemoteObjects(commandRunner, awsCommand, accountId, credentialsEnvironment);
  assertStorageEnvelope(before, plan);
  for (const entry of before) {
    const head = headRemoteObject(commandRunner, awsCommand, accountId, credentialsEnvironment, entry.key);
    assertHeadObject(head, { key: entry.key }, { requireMetadata: false });
  }

  const baseArguments = awsBaseArguments(accountId);
  for (const item of plan) {
    const putResult = invokeAws(commandRunner, awsCommand, [
      "s3api", "put-object",
      "--bucket", BUCKET_NAME,
      "--key", item.key,
      "--body", path.resolve(item.file),
      "--content-type", item.contentType,
      "--cache-control", "no-store",
      "--storage-class", "STANDARD",
      "--metadata", metadataArgument(item.customMetadata),
      "--checksum-algorithm", "SHA256",
      "--checksum-sha256", sha256Base64(item.sha256),
      ...baseArguments,
    ], credentialsEnvironment, `put-object:${item.key}`);
    if (putResult.ChecksumSHA256 && putResult.ChecksumSHA256 !== sha256Base64(item.sha256)) {
      throw new Error(`uploaded_checksum_mismatch:${item.key}`);
    }
    const head = headRemoteObject(commandRunner, awsCommand, accountId, credentialsEnvironment, item.key);
    assertHeadObject(head, item, { requireMetadata: true });
  }

  const after = listRemoteObjects(commandRunner, awsCommand, accountId, credentialsEnvironment);
  const keys = after.map((entry) => entry.key).sort();
  if (keys.length !== ALLOWED_KEYS.length || keys.some((key, index) => key !== ALLOWED_KEYS[index])) {
    throw new Error("final_inventory_not_exact");
  }
  const finalInventoryBytes = after.reduce((sum, entry) => sum + entry.size, 0);
  if (finalInventoryBytes !== finalBytes) throw new Error("final_inventory_size_mismatch");
  return { bucket, beforeKeys: before.map((entry) => entry.key).sort(), finalKeys: keys, finalBytes };
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const values = parseArguments(argv);
  const manifestPath = path.resolve(values["--manifest"]);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifestSizeBytes = Buffer.byteLength(manifestText);
  if (manifestSizeBytes > MAX_MANIFEST_BYTES) throw new Error("manifest_too_large");
  const manifest = parseManifestText(manifestText);
  const options = { aapt: values["--aapt"], apksigner: values["--apksigner"], java: values["--java"] };
  const artifacts = {
    current: await inspectApk(path.resolve(values["--current"]), options),
    recovery: await inspectApk(path.resolve(values["--recovery"]), options),
  };
  const previousVersionCode = Number(values["--previous-version-code"]);
  const trustedCertificateSha256 = values["--trusted-certificate-sha256"].toLowerCase();
  const totalApkBytes = validateArtifacts(manifest, artifacts, previousVersionCode, trustedCertificateSha256);
  if (values["--inventory"]) validateInventory(JSON.parse(await readFile(path.resolve(values["--inventory"]), "utf8")));
  const manifestSha256 = createHash("sha256").update(manifestText).digest("hex");
  const uploadPlan = buildUploadPlan(manifest, artifacts, manifestPath, {
    sizeBytes: manifestSizeBytes,
    sha256: manifestSha256,
  });
  let publishResult;
  if (values["--publish"]) {
    const environment = dependencies.environment ?? process.env;
    publishResult = await publishArtifacts({
      plan: uploadPlan,
      accountId: environment.CLOUDFLARE_ACCOUNT_ID,
      apiToken: environment.CLOUDFLARE_API_TOKEN,
      environment,
      fetchImpl: dependencies.fetchImpl ?? fetch,
      commandRunner: dependencies.commandRunner ?? run,
      awsCommand: values["--aws"] ?? "aws",
      accountFreeHeadroomConfirmed: values["--confirm-account-free-headroom"] === true,
    });
  }
  const result = {
    mode: values["--publish"] ? "published" : "dry-run",
    bucket: BUCKET_NAME,
    allowedKeys: ALLOWED_KEYS,
    versions: { previous: previousVersionCode, current: manifest.releases.current.versionCode, recovery: manifest.releases.recovery.versionCode },
    totalApkBytes,
    manifestSha256,
    uploadPlan,
    remoteWritesPerformed: values["--publish"] === true,
    ...(publishResult ? { publishResult } : {}),
  };
  (dependencies.stdout ?? process.stdout).write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`게시 검증 실패: ${error.message}\n`);
    process.exitCode = 1;
  });
}
