// 하태파일럿 앱용 Tesla OAuth 토큰 교환 프록시 (Cloudflare Pages Function)
//
// 앱은 인증 code만 보낸다. client_secret은 여기(Cloudflare 암호화 env)에만 있고 앱엔 없다.
// client_id·redirect_uri·audience는 비밀이 아니므로(로그인 URL에 노출됨) 여기 상수로 둔다.
//
// 성공 응답은 Tesla 토큰 JSON을 전달하고, 오류 응답은 고정된 안전한 JSON으로 정규화한다.

import { createTeslaOAuthHandler } from "../_lib/oauth-proxy.js";

const CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";
const REDIRECT_URI = "https://hataepilot.com/auth/callback";
const AUDIENCE = "https://fleet-api.prd.na.vn.cloud.tesla.com";
const TOKEN_ENDPOINT = "https://auth.tesla.com/oauth2/v3/token";

export function createTokenHandler(options = {}) {
  return createTeslaOAuthHandler({
    ...options,
    flow: "authorization_code",
    audience: AUDIENCE,
    clientId: CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
    redirectUri: REDIRECT_URI,
  });
}

const handle = createTokenHandler();

export async function onRequestPost(context) {
  return handle(context);
}
