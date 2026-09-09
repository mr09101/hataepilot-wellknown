import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  ALLOWED_KEYS,
  BUCKET_NAME,
  buildUploadPlan,
  inspectApk,
  parseArguments,
  parseAaptBadging,
  parseApksignerOutput,
  publishArtifacts,
  validateArtifacts,
  validateInventory,
} from "../updates/publish.mjs";
import { validateManifest } from "../updates/src/manifest.js";

const CERT = "b".repeat(64);

function validManifest(currentSha, recoverySha, currentSize = 4, recoverySize = 5) {
  return validateManifest({
    schema: 1,
    packageName: "com.khs.hataepilot",
    publishedAt: "2026-09-10T00:00:00.000Z",
    releases: {
      current: { versionCode: 2, versionName: "0.2", sha256: currentSha, sizeBytes: currentSize, downloadPath: "/updates/apk/current", notes: "정상판", minSdk: 31, certificateSha256: CERT },
      recovery: { versionCode: 3, versionName: "0.2-recovery", sha256: recoverySha, sizeBytes: recoverySize, downloadPath: "/updates/apk/recovery", notes: "복구판", minSdk: 31, certificateSha256: CERT },
    },
  });
}

test("aapt and apksigner output is parsed strictly", () => {
  assert.deepEqual(parseAaptBadging("package: name='com.khs.hataepilot' versionCode='2' versionName='0.2'\nsdkVersion:'31'\n"), {
    packageName: "com.khs.hataepilot", versionCode: 2, versionName: "0.2", minSdk: 31,
  });
  assert.equal(parseApksignerOutput(`Signer #1 certificate SHA-256 digest: ${CERT}`), CERT);
  assert.equal(parseApksignerOutput(`Number of signers: 1\r\nV2 Signer: certificate SHA-256 digest: ${CERT}\r\n`), CERT);
  assert.throws(() => parseApksignerOutput(`Signer #1 certificate SHA-256 digest: ${CERT}\nSigner #2 certificate SHA-256 digest: ${"c".repeat(64)}`), /invalid_signer_set/);
  assert.throws(() => parseApksignerOutput(`Number of signers: 2\nV2 Signer: certificate SHA-256 digest: ${CERT}`), /invalid_signer_set/);
  assert.throws(
    () => parseAaptBadging("package: name='com.khs.hataepilot' versionCode='2' versionName='0.2'\nsdkVersion:'31'\napplication-debuggable\n"),
    /debuggable_apk_rejected/,
  );
});

test("APK inspection uses actual file hash and verified tool output", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "hataepilot-ota-"));
  const apk = path.join(directory, "current.apk");
  try {
    await writeFile(apk, new Uint8Array([1, 2, 3, 4]));
    const result = await inspectApk(apk, {
      aapt: "aapt-test",
      apksigner: "apksigner-test",
      runner(command) {
        if (command === "aapt-test") return "package: name='com.khs.hataepilot' versionCode='2' versionName='0.2'\nsdkVersion:'31'\n";
        return `Signer #1 certificate SHA-256 digest: ${CERT}`;
      },
    });
    assert.equal(result.sha256, createHash("sha256").update(new Uint8Array([1, 2, 3, 4])).digest("hex"));
    assert.equal(result.sizeBytes, 4);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("dry-run validation compares package, version, certificate, hash, size, and prior version", () => {
  const currentSha = "a".repeat(64);
  const recoverySha = "c".repeat(64);
  const manifest = validManifest(currentSha, recoverySha);
  const artifacts = {
    current: { packageName: "com.khs.hataepilot", versionCode: 2, versionName: "0.2", minSdk: 31, sha256: currentSha, sizeBytes: 4, certificateSha256: CERT, path: "current.apk" },
    recovery: { packageName: "com.khs.hataepilot", versionCode: 3, versionName: "0.2-recovery", minSdk: 31, sha256: recoverySha, sizeBytes: 5, certificateSha256: CERT, path: "recovery.apk" },
  };
  assert.equal(validateArtifacts(manifest, artifacts, 1, CERT), 9);
  assert.throws(() => validateArtifacts(manifest, artifacts, 2, CERT), /current_version_not_higher/);
  assert.throws(() => validateArtifacts(manifest, { ...artifacts, current: { ...artifacts.current, packageName: "other" } }, 1, CERT), /apk_package_mismatch/);
});

test("publish plan is fixed to three Standard objects and rejects inventory extras", () => {
  const currentSha = "a".repeat(64);
  const recoverySha = "c".repeat(64);
  const manifestSha = "d".repeat(64);
  const manifest = validManifest(currentSha, recoverySha);
  const artifacts = {
    current: { path: "current.apk", sizeBytes: 4, sha256: currentSha },
    recovery: { path: "recovery.apk", sizeBytes: 5, sha256: recoverySha },
  };
  const plan = buildUploadPlan(manifest, artifacts, "manifest.json", { sizeBytes: 10, sha256: manifestSha });
  assert.equal(BUCKET_NAME, "hataepilot-updates");
  assert.deepEqual(plan.map((item) => item.key).sort(), ALLOWED_KEYS);
  assert.ok(plan.every((item) => item.storageClass === "Standard"));
  assert.equal(plan[2].customMetadata.sha256, manifestSha);
  assert.deepEqual(validateInventory(["current.apk", "recovery.apk", "manifest.json"]), ALLOWED_KEYS);
  assert.throws(() => validateInventory(["manifest.json", "backup.apk"]), /unexpected_r2_object/);
});

function privateStandardFetch(url) {
  let result;
  if (url.endsWith("/domains/managed")) result = { enabled: false };
  else if (url.endsWith("/domains/custom")) result = { domains: [] };
  else result = { name: BUCKET_NAME, storage_class: "Standard" };
  return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, result }) });
}

function publishFixture() {
  const currentSha = "a".repeat(64);
  const recoverySha = "c".repeat(64);
  const manifestSha = "d".repeat(64);
  const manifest = validManifest(currentSha, recoverySha);
  const artifacts = {
    current: { path: "current.apk", sizeBytes: 4, sha256: currentSha },
    recovery: { path: "recovery.apk", sizeBytes: 5, sha256: recoverySha },
  };
  return buildUploadPlan(manifest, artifacts, "manifest.json", { sizeBytes: 10, sha256: manifestSha });
}

test("publish is an explicit opt-in with an account-free-headroom acknowledgment", () => {
  const common = [
    "--current", "current.apk",
    "--recovery", "recovery.apk",
    "--manifest", "manifest.json",
    "--previous-version-code", "1",
    "--trusted-certificate-sha256", CERT,
  ];
  assert.equal(parseArguments(common)["--publish"], undefined);
  assert.throws(() => parseArguments([...common, "--publish"]), /publish_requires_account_free_headroom_confirmation/);
  const parsed = parseArguments([...common, "--publish", "--confirm-account-free-headroom"]);
  assert.equal(parsed["--publish"], true);
  assert.equal(parsed["--confirm-account-free-headroom"], true);
});

test("publisher checks private Standard R2, uploads APKs before manifest, and verifies the final inventory", async () => {
  const plan = publishFixture();
  const calls = [];
  const uploaded = new Map();
  const commandRunner = (_command, args, options) => {
    calls.push({ args, options });
    assert.equal(options.env.AWS_MAX_ATTEMPTS, "1");
    const operation = args[1];
    if (operation === "list-objects-v2") {
      return JSON.stringify({
        IsTruncated: false,
        Contents: [...uploaded.entries()].map(([Key, item]) => ({ Key, Size: item.sizeBytes, StorageClass: "STANDARD" })),
      });
    }
    const key = args[args.indexOf("--key") + 1];
    const item = plan.find((candidate) => candidate.key === key);
    if (operation === "put-object") {
      uploaded.set(key, item);
      assert.ok(args.includes("--checksum-sha256"));
      assert.ok(args.includes("--metadata"));
      return "{}";
    }
    if (operation === "head-object") {
      return JSON.stringify({
        ContentLength: item.sizeBytes,
        ContentType: item.contentType,
        CacheControl: "no-store",
        StorageClass: "STANDARD",
        Metadata: item.customMetadata,
      });
    }
    throw new Error(`unexpected_test_operation:${operation}`);
  };

  const result = await publishArtifacts({
    plan,
    accountId: "1".repeat(32),
    apiToken: "read-token",
    environment: { R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret" },
    fetchImpl: privateStandardFetch,
    commandRunner,
    accountFreeHeadroomConfirmed: true,
  });
  const putKeys = calls
    .filter(({ args }) => args[1] === "put-object")
    .map(({ args }) => args[args.indexOf("--key") + 1]);
  assert.deepEqual(putKeys, ["current.apk", "recovery.apk", "manifest.json"]);
  assert.equal(calls.some(({ args }) => args.includes("delete-object")), false);
  assert.deepEqual(result.finalKeys, ALLOWED_KEYS);
});

test("publisher fails closed before uploads for public buckets or inventory extras", async () => {
  const plan = publishFixture();
  const environment = { R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret" };
  let commandCalls = 0;
  await assert.rejects(() => publishArtifacts({
    plan,
    accountId: "1".repeat(32),
    apiToken: "read-token",
    environment,
    fetchImpl: async (url) => ({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        result: url.endsWith("/domains/managed")
          ? { enabled: true }
          : { name: BUCKET_NAME, storage_class: "Standard" },
      }),
    }),
    commandRunner: () => { commandCalls += 1; return "{}"; },
    accountFreeHeadroomConfirmed: true,
  }), /managed_public_domain_enabled_or_unknown/);
  assert.equal(commandCalls, 0);

  await assert.rejects(() => publishArtifacts({
    plan,
    accountId: "1".repeat(32),
    apiToken: "read-token",
    environment,
    fetchImpl: privateStandardFetch,
    commandRunner: () => {
      commandCalls += 1;
      return JSON.stringify({ IsTruncated: false, Contents: [{ Key: "backup.apk", Size: 1 }] });
    },
    accountFreeHeadroomConfirmed: true,
  }), /unexpected_r2_object/);
  assert.equal(commandCalls, 1);
});

test("each object PUT or verification failure stops all later PUT operations", async (t) => {
  const cases = [
    { operation: "put-object", key: "current.apk", expectedPuts: ["current.apk"] },
    { operation: "head-object", key: "current.apk", expectedPuts: ["current.apk"] },
    { operation: "put-object", key: "recovery.apk", expectedPuts: ["current.apk", "recovery.apk"] },
    { operation: "head-object", key: "recovery.apk", expectedPuts: ["current.apk", "recovery.apk"] },
    { operation: "put-object", key: "manifest.json", expectedPuts: ["current.apk", "recovery.apk", "manifest.json"] },
    { operation: "head-object", key: "manifest.json", expectedPuts: ["current.apk", "recovery.apk", "manifest.json"] },
  ];

  for (const failure of cases) {
    await t.test(`${failure.operation}:${failure.key}`, async () => {
      const plan = publishFixture();
      const putKeys = [];
      const headCounts = new Map();
      const contents = plan.map((item) => ({ Key: item.key, Size: item.sizeBytes, StorageClass: "STANDARD" }));
      const commandRunner = (_command, args) => {
        const operation = args[1];
        if (operation === "list-objects-v2") return JSON.stringify({ IsTruncated: false, Contents: contents });
        const key = args[args.indexOf("--key") + 1];
        const item = plan.find((candidate) => candidate.key === key);
        if (operation === "put-object") {
          putKeys.push(key);
          if (failure.operation === operation && failure.key === key) throw new Error("injected_remote_failure");
          return "{}";
        }
        if (operation === "head-object") {
          const count = (headCounts.get(key) ?? 0) + 1;
          headCounts.set(key, count);
          if (count === 2 && failure.operation === operation && failure.key === key) {
            throw new Error("injected_remote_failure");
          }
          if (count === 1) return JSON.stringify({ StorageClass: "STANDARD" });
          return JSON.stringify({
            ContentLength: item.sizeBytes,
            ContentType: item.contentType,
            CacheControl: "no-store",
            StorageClass: "STANDARD",
            Metadata: item.customMetadata,
          });
        }
        throw new Error(`unexpected_test_operation:${operation}`);
      };

      await assert.rejects(() => publishArtifacts({
        plan,
        accountId: "1".repeat(32),
        apiToken: "read-token",
        environment: { R2_ACCESS_KEY_ID: "access", R2_SECRET_ACCESS_KEY: "secret" },
        fetchImpl: privateStandardFetch,
        commandRunner,
        accountFreeHeadroomConfirmed: true,
      }), /injected_remote_failure/);
      assert.deepEqual(putKeys, failure.expectedPuts);
    });
  }
});
