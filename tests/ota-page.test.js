import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pageUrl = new URL("../app-recovery/index.html", import.meta.url);

test("recovery page keeps credentials out of URLs and persistent browser storage", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /Content-Security-Policy[^>]+connect-src 'self'; form-action 'self'/);
  assert.match(html, /form\.method = "post"/);
  assert.match(html, /\["token", updateToken\].*\["sha", release\.sha256\].*\["parked", "true"\]/s);
  assert.doesNotMatch(html, /localStorage|sessionStorage|analytics|[?&]token=/i);
});

test("untrusted release notes are rendered as text and the layout has a mobile mode", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /notes\.textContent = release\.notes/);
  assert.doesNotMatch(html, /innerHTML|outerHTML|insertAdjacentHTML|document\.write/);
  assert.match(html, /@media\(max-width:680px\)/);
  assert.match(html, /min-height:52px/);
});

test("page explains parking, same-signature higher-version recovery, and browser limits", async () => {
  const html = await readFile(pageUrl, "utf8");
  for (const phrase of ["안전한 곳에 주차", "같은 서명", "더 높은 버전", "앱을 삭제하지 않고", "강제로 차단할 수 없으므로"]) {
    assert.match(html, new RegExp(phrase));
  }
});

test("no-JavaScript form behavior cannot put the password in a URL", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /<form id="auth-form" method="post" action="\/app-recovery\/"/);
  assert.match(html, /<button id="check-button" type="submit" disabled>/);
  assert.doesNotMatch(html, /id="update-token"[^>]*\sname=/);
  assert.match(html, /<noscript>/);
});

test("manifest checks are single-flight and expose busy state", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /if \(checking\) return/);
  assert.match(html, /authForm\.setAttribute\("aria-busy", "true"\)/);
  assert.match(html, /authForm\.removeAttribute\("aria-busy"\)/);
});

test("mobile Korean guidance avoids syllable-by-syllable wrapping", async () => {
  const html = await readFile(pageUrl, "utf8");
  assert.match(html, /\.safety span,\.warning\{word-break:keep-all;overflow-wrap:anywhere\}/);
  assert.match(html, /button\{[^}]*word-break:keep-all;overflow-wrap:anywhere/);
});
