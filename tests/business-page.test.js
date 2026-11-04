import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const PUBLIC_PAGES = ["index.html", "app-recovery/index.html", "business/index.html"];
const read = (relativePath) => readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");

test("business page lists the registered sole proprietorship details in Korean and English", async () => {
  const html = await read("business/index.html");
  assert.match(html, /<title>[^<]*김현성[^<]*<\/title>/);
  for (const phrase of [
    "878-06-03886",
    "HyunSung Kim",
    "개인사업자",
    "sole proprietorship",
    "응용 소프트웨어 개발 및 공급업",
    "경기도 용인시 수지구 용구대로 2793, 1동 12층 1201호(죽전동)",
    "1201, Bldg 1, 2793 Yonggu-daero, Suji-gu, Yongin-si, Gyeonggi-do, Republic of Korea",
    "2026-07-08",
    "mailto:ilos1212@gmail.com",
    "@ryoka.trip",
    'href="https://ryoka-trip-link.vercel.app/privacy"',
    'href="https://ryoka-trip-link.vercel.app/terms"',
    'href="https://ryoka-trip-link.vercel.app/data-deletion"',
  ]) {
    assert.ok(html.includes(phrase), `missing: ${phrase}`);
  }
});

test("business page is static, script-free and exposes no resident registration number", async () => {
  const html = await read("business/index.html");
  assert.match(html, /http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline';/);
  assert.doesNotMatch(html, /<script|<iframe|<form|<img|\son[a-z]+=/i);
  assert.doesNotMatch(html, /주민등록|\b\d{6}-?[1-4]\d{6}\b/);
});

test("every public page footer names the operator and links to the business page", async () => {
  for (const page of PUBLIC_PAGES) {
    const footer = (await read(page)).match(/<footer>[\s\S]*?<\/footer>/)?.[0] ?? "";
    assert.ok(footer.includes("운영: 김현성 | 사업자등록번호 878-06-03886"), `${page} footer`);
    assert.match(footer, /href="\/business\/"/, `${page} link`);
  }
});

test("the business page participates in Pages deployment triggers", async () => {
  const deployWorkflow = await read(".github/workflows/deploy-pages.yml");
  assert.match(deployWorkflow, /- "business\/\*\*"/);
});
