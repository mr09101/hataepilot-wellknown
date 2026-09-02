// 하태파일럿 앱용 Tesla 토큰 갱신 프록시 (Cloudflare Pages Function)
//
// 앱은 refresh_token만 보낸다. client_secret은 여기(Cloudflare 암호화 env)에만 있다.
// 응답은 Tesla 토큰 JSON을 그대로 전달한다.

const CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";
const TOKEN_ENDPOINT = "https://auth.tesla.com/oauth2/v3/token";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  if (!env.TESLA_CLIENT_SECRET) return json({ error: "server_not_configured" }, 500);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const refreshToken = body && body.refresh_token;
  if (!refreshToken) return json({ error: "missing_refresh_token" }, 400);

  const form = new URLSearchParams({
    grant_type: "refresh_token",
    client_id: CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    refresh_token: refreshToken,
  });

  const r = await fetch(TOKEN_ENDPOINT, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { "Content-Type": "application/json" },
  });
}
