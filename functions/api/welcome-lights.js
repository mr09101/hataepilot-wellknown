import { createWelcomeLightsHandler } from "../_lib/welcome-lights.js";

const handle = createWelcomeLightsHandler();

export async function onRequest(context) {
  if (context.request.method === "POST") return handle(context.request, context.env);
  return new Response(JSON.stringify({ ok: false, code: "method_not_allowed" }), {
    status: 405,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Allow": "POST",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
