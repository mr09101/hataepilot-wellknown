// 하태파일럿 앱용 Tesla OAuth 토큰 교환 프록시 (Cloudflare Pages Function)
//
// 앱은 인증 code만 보낸다. client_secret은 여기(Cloudflare 암호화 env)에만 있고 앱엔 없다.
// client_id·redirect_uri·audience는 비밀이 아니므로(로그인 URL에 노출됨) 여기 상수로 둔다.
//
// 응답은 Tesla 토큰 JSON을 그대로 전달한다(앱의 parseTokens가 동일하게 처리).

const CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";
const REDIRECT_URI = "https://hataepilot.com/auth/callback";
const AUDIENCE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
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
  const code = body && body.code;
  if (!code) return json({ error: "missing_code" }, 400);

  const form = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: CLIENT_ID,
    client_secret: env.TESLA_CLIENT_SECRET,
    code,
    redirect_uri: body.redirect_uri || REDIRECT_URI,
    audience: AUDIENCE,
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
