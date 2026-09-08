import assert from "node:assert/strict";
import test from "node:test";

import { onRequest } from "../functions/api/welcome-lights.js";

test("route dispatches POST and rejects every other method", async () => {
  const getResponse = await onRequest({
    request: new Request("https://hataepilot.com/api/welcome-lights", { method: "GET" }),
    env: {},
  });
  assert.equal(getResponse.status, 405);
  assert.equal(getResponse.headers.get("Allow"), "POST");

  const postResponse = await onRequest({
    request: new Request("https://hataepilot.com/api/welcome-lights", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehicle_id: "123456", vin: "5YJ30123456789ABC", wake: false }),
    }),
    env: {},
  });
  assert.equal(postResponse.status, 503);
  assert.deepEqual(await postResponse.json(), { ok: false, code: "server_not_configured" });
});
