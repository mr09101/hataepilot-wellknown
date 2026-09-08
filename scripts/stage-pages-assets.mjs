import { copyFile, lstat, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIRECTORY = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(SCRIPT_DIRECTORY, "..");

export const PAGES_ASSET_OUTPUT = path.resolve(PROJECT_ROOT, "build", "pages-assets");
export const PUBLIC_ASSETS = Object.freeze([
  "index.html",
  "_headers",
  ".well-known/appspecific/com.tesla.3p.public-key.pem",
  "data/cameras.db",
  "data/cameras.json",
  "data/rear_cameras.json",
]);

function assertInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("unsafe_staging_path");
}

export async function stagePagesAssets() {
  const expectedOutput = path.resolve(PROJECT_ROOT, "build", "pages-assets");
  if (PAGES_ASSET_OUTPUT !== expectedOutput) throw new Error("unsafe_staging_output");
  await rm(PAGES_ASSET_OUTPUT, { recursive: true, force: true });
  await mkdir(PAGES_ASSET_OUTPUT, { recursive: true });

  for (const relativePath of PUBLIC_ASSETS) {
    const source = path.resolve(PROJECT_ROOT, ...relativePath.split("/"));
    const destination = path.resolve(PAGES_ASSET_OUTPUT, ...relativePath.split("/"));
    assertInside(PROJECT_ROOT, source);
    assertInside(PAGES_ASSET_OUTPUT, destination);
    if (!(await lstat(source)).isFile()) throw new Error(`public_asset_not_file:${relativePath}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(source, destination);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await stagePagesAssets();
}
