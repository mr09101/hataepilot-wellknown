import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { PAGES_ASSET_OUTPUT, PUBLIC_ASSETS, stagePagesAssets } from "../scripts/stage-pages-assets.mjs";

const EXPECTED_ASSETS = [
  ".well-known/appspecific/com.tesla.3p.public-key.pem",
  "_headers",
  "app-recovery/index.html",
  "data/cameras.db",
  "data/cameras.json",
  "data/rear_cameras.json",
  "index.html",
];

async function filesBelow(directory, prefix = "") {
  const results = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) results.push(...await filesBelow(path.join(directory, entry.name), relative));
    else results.push(relative);
  }
  return results.sort();
}

test("deployment staging contains only the explicit public asset allowlist", async () => {
  assert.deepEqual([...PUBLIC_ASSETS].sort(), EXPECTED_ASSETS);
  await stagePagesAssets();
  assert.deepEqual(await filesBelow(PAGES_ASSET_OUTPUT), EXPECTED_ASSETS);
});

test("every Pages deployment uses the allowlisted staging directory", async () => {
  const cameraWorkflow = await readFile(new URL("../.github/workflows/update-cameras.yml", import.meta.url), "utf8");
  const deployWorkflow = await readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");
  for (const workflow of [cameraWorkflow, deployWorkflow]) {
    assert.doesNotMatch(workflow, /pages deploy \.(?:\s|$)/);
    assert.match(workflow, /node scripts\/stage-pages-assets\.mjs/);
    assert.match(workflow, /pages deploy build\/pages-assets/);
  }
});

test("the recovery page participates in Pages deployment triggers", async () => {
  const deployWorkflow = await readFile(new URL("../.github/workflows/deploy-pages.yml", import.meta.url), "utf8");
  assert.match(deployWorkflow, /- "app-recovery\/\*\*"/);
});

test("defense-in-depth ignore rules cover local secrets and generated staging", async () => {
  const assetsIgnore = (await readFile(new URL("../.assetsignore", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const gitIgnore = (await readFile(new URL("../.gitignore", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  for (const entry of ["tests", "docs", "*.env*", "*.key", "*private*.pem", "README.md", "HANDOFF.md", "PROJECT_BLUEPRINT.md", "package*.json", "build"]) {
    assert.match(assetsIgnore, new RegExp(`(^|\\n)${entry.replaceAll("*", "\\*")}($|\\n)`));
  }
  assert.match(gitIgnore, /(^|\n)build\/(?:$|\n)/);
});
