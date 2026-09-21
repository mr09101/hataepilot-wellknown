// Explicit operator read only. Credentials never become command arguments or output.
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
try {
  const env = Object.fromEntries((await readFile(resolve(root, ".env.local"), "utf8"))
    .split(/\r?\n/).filter(line => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1).trim().replace(/^(['"])(.*)\1$/, "$2")]));
  const token = process.env.HATAEPILOT_DIAGNOSTICS_READ_TOKEN || env.HATAEPILOT_DIAGNOSTICS_READ_TOKEN;
  if (!/^[A-Za-z0-9_-]{43}$/.test(token ?? "")) throw Error("관리자 진단 조회 키가 설정되지 않았습니다.");
  const response = await fetch("https://hataepilot.com/updates/diagnostics", {
    headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: AbortSignal.timeout(15000) });
  if (!response.ok) throw Error(`진단 조회 실패: HTTP ${response.status}`);
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength; if (size > 700000) throw Error("진단 조회 응답 크기 초과");
    chunks.push(chunk);
  }
  const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if (!body.ok || !Array.isArray(body.reports) || body.reports.length > 5) throw Error("진단 조회 응답 형식 오류");
  const path = resolve(root, "build", "diagnostics", "latest.json");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ path, reports: body.reports.map(r => ({ id: r.id, receivedAtMs: r.receivedAtMs,
    versionCode: r.report.versionCode, events: r.report.events.length })) }, null, 2));
} catch (error) {
  // Do not print fetch exceptions, headers, URL credentials or remote response bodies.
  console.error(error.message?.startsWith("진단") || error.message?.startsWith("관리자") ? error.message : "진단 조회에 실패했습니다.");
  process.exitCode = 1;
}
