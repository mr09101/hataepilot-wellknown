// 하태파일럿 앱용 Tesla 토큰 갱신 프록시 (Cloudflare Pages Function)
//
// 앱은 refresh_token만 보낸다. client_secret은 여기(Cloudflare 암호화 env)에만 있다.
// 성공 응답은 Tesla 토큰 JSON을 전달하고, 오류 응답은 고정된 안전한 JSON으로 정규화한다.

import { createTeslaOAuthHandler } from "../_lib/oauth-proxy.js";

const CLIENT_ID = "8dcd603f-22b3-461d-87b8-07acd47f8bb9";
const TOKEN_ENDPOINT = "https://auth.tesla.com/oauth2/v3/token";

export function createRefreshHandler(options = {}) {
  return createTeslaOAuthHandler({
    ...options,
    flow: "refresh_token",
    clientId: CLIENT_ID,
    tokenEndpoint: TOKEN_ENDPOINT,
  });
}

const handle = createRefreshHandler();

export async function onRequestPost(context) {
  return handle(context);
}
