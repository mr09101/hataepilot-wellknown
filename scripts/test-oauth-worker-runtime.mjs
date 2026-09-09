// Runs the built Pages bundle in workerd, with every outbound fetch replaced by a mock.
// Build first with Wrangler; MINIFLARE_MODULE may point to its installed miniflare package.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { Miniflare, convertV4MiniflareOptions } = require(process.env.MINIFLARE_MODULE || "miniflare");
let upstreamStatus = 200;
let fetches = 0;
const options = {
  modules: true,
  scriptPath: process.argv[2] || "build/pages-functions/index.js",
  compatibilityDate: "2026-09-09",
  bindings: { TESLA_CLIENT_SECRET: "fake-runtime-secret" },
  outboundService: async (request) => {
    fetches++;
    assert.equal(request.url, "https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token");
    assert.equal(request.method, "POST");
    const body = upstreamStatus === 200
      ? { access_token: "fake-access", refresh_token: "fake-refresh", expires_in: 3600 }
      : { error: "fake-private-provider-message" };
    return new Response(JSON.stringify(body), {
      status: upstreamStatus,
      headers: { "Content-Type": "application/json", Location: "https://never-follow.invalid/" },
    });
  },
};
const runtime = new Miniflare(convertV4MiniflareOptions ? convertV4MiniflareOptions(options) : options);
let checks = 0;
try {
  for (const route of ["refresh", "token"]) {
    for (const status of [200, 401, 302]) {
      upstreamStatus = status;
      const before = fetches;
      const response = await runtime.dispatchFetch(`https://hataepilot.com/api/${route}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(route === "refresh" ? { refresh_token: "fake-refresh" } : { code: "fake-code" }),
      });
      assert.equal(response.status, status === 302 ? 502 : status);
      assert.equal(response.headers.get("Cache-Control"), "no-store");
      assert.equal(fetches - before, 1, "redirects must not trigger a second request");
      const payload = await response.json();
      if (status === 200) assert.equal(payload.access_token, "fake-access");
      else assert.deepEqual(payload, { error: status === 302 ? "provider_unavailable" : "oauth_provider_rejected" });
      checks++;
    }
  }
  console.log(JSON.stringify({ runtime: "workerd", checks, passed: true, real_network_requests: 0 }));
} finally {
  await runtime.dispose();
}
