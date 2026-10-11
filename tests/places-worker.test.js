import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { handleRequest } from "../updates/src/worker.js";
import { mapKakaoPlaces, parsePlacesQuery } from "../updates/src/places.js";

// 앱 홈 "목적지 보내기"의 장소 검색(2026-10-12). 카카오 키는 서버에만 있고, 기기 암호가 있어야 쓴다.
const token = Buffer.alloc(32, 7).toString("base64url");
const kakaoKey = "0123456789abcdef0123456789abcdef";
const hash = (value) => createHash("sha256").update(value).digest("hex");
const env = (extra = {}) => ({ UPDATE_TOKEN_SHA256: hash(token), KAKAO_LOCAL_REST_API_KEY: kakaoKey, ...extra });
const request = (query, headers = {}, init = {}) => new Request(`https://hataepilot.com/updates/places${query}`, {
  headers: { Authorization: `Bearer ${token}`, ...headers }, ...init,
});

function kakaoDocument(overrides = {}) {
  return {
    place_name: "물치항", road_address_name: "강원특별자치도 양양군 강현면 동해대로 3580",
    address_name: "강원 양양군 강현면 물치리", x: "128.6214", y: "38.1342", distance: "1234",
    category_group_name: "", ...overrides,
  };
}

async function withFetch(stub, run) {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push({ url: new URL(url), init }); return stub(url, init); };
  try { return await run(calls); } finally { globalThis.fetch = original; }
}

test("검색은 기기 암호가 맞을 때만 카카오를 부른다(키가 서버에만 있어도 아무나 쓰면 무료 쿼터가 바닥난다)", async () => {
  await withFetch(() => Response.json({ documents: [] }), async (calls) => {
    assert.equal((await handleRequest(request("?q=물치항", { Authorization: "" }), env())).status, 401);
    const wrong = Buffer.alloc(32, 8).toString("base64url");
    assert.equal((await handleRequest(request("?q=물치항", { Authorization: `Bearer ${wrong}` }), env())).status, 401);
    assert.equal(calls.length, 0);
  });
});

test("브라우저 요청·다른 방식·이상한 검색어는 카카오까지 가지 않는다", async () => {
  await withFetch(() => Response.json({ documents: [] }), async (calls) => {
    assert.equal((await handleRequest(request("?q=물치항", { Origin: "https://evil.invalid" }), env())).status, 403);
    assert.equal((await handleRequest(request("?q=물치항", {}, { method: "POST", body: "{}" }), env())).status, 405);
    for (const query of ["", "?q=가", "?q=물치항&token=x", "?q=물치항&lat=38.1", "?q=물치항&lat=abc&lon=128.6", "?q=a&q=b"]) {
      assert.equal((await handleRequest(request(query), env())).status, 400, query);
    }
    assert.equal(calls.length, 0);
  });
});

test("키나 기기 암호 설정이 없으면 막고 캐시하지 않는다", async () => {
  for (const broken of [env({ KAKAO_LOCAL_REST_API_KEY: undefined }), env({ UPDATE_TOKEN_SHA256: "x" })]) {
    const response = await handleRequest(request("?q=물치항"), broken);
    assert.equal(response.status, 503);
    assert.equal(response.headers.get("cache-control"), "no-store");
  }
});

test("근처 매장을 앞에 두려고 위치를 보내되 약 1km로 줄여 보낸다(정확한 위치는 서버 밖으로 나가지 않는다)", async () => {
  await withFetch(() => Response.json({ documents: [kakaoDocument()] }), async (calls) => {
    const response = await handleRequest(request("?q=%20%EB%AC%BC%EC%B9%98%ED%95%AD%20&lat=38.134567&lon=128.621234"), env());
    assert.equal(response.status, 200);
    const sent = calls[0].url;
    assert.equal(sent.origin + sent.pathname, "https://dapi.kakao.com/v2/local/search/keyword.json");
    assert.equal(sent.searchParams.get("query"), "물치항");
    assert.equal(sent.searchParams.get("y"), "38.13");
    assert.equal(sent.searchParams.get("x"), "128.62");
    assert.equal(sent.searchParams.get("sort"), null, "거리순은 장소 이름 검색을 망쳐 정확도순(기본)을 쓴다");
    assert.equal(calls[0].init.headers.Authorization, `KakaoAK ${kakaoKey}`);
    assert.equal(calls[0].init.redirect, "manual", "다른 주소로 넘어가지 않는다(Workers는 error를 못 써 manual로 받고 3xx는 실패)");
  });
  await withFetch(() => Response.json({ documents: [] }), async (calls) => {
    assert.equal((await handleRequest(request("?q=물치항&lat=35.68&lon=139.69"), env())).status, 200);
    assert.equal(calls[0].url.searchParams.get("x"), null, "국내 밖 위치는 보내지 않고 위치 없이 찾는다");
  });
});

test("앱에는 정리한 값만 돌려주고 카카오 원문과 키는 넘기지 않는다", async () => {
  const documents = [
    kakaoDocument({ place_name: "물치\u0007항", extra: "secret-upstream-field" }),
    kakaoDocument(), // 같은 이름·주소
    kakaoDocument({ place_name: "Gangnam", x: "-118.24", y: "34.05" }), // 해외
    kakaoDocument({ place_name: "좌표 없음", x: "", y: "" }),
    kakaoDocument({ place_name: "지번만", road_address_name: "", address_name: "강원 양양군 강현면 물치리 7-23", distance: "" }),
  ];
  await withFetch(() => Response.json({ documents, meta: { total_count: 5 } }), async () => {
    const response = await handleRequest(request("?q=물치항"), env());
    const text = await response.text();
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.doesNotMatch(text, new RegExp(kakaoKey));
    assert.doesNotMatch(text, /secret-upstream-field|total_count/);
    const body = JSON.parse(text);
    assert.deepEqual(body.places.map((place) => place.name), ["물치항", "지번만"]);
    assert.equal(body.places[0].address, "강원특별자치도 양양군 강현면 동해대로 3580", "도로명 주소를 먼저 쓴다");
    assert.equal(body.places[0].distanceM, 1234);
    assert.equal(body.places[1].address, "강원 양양군 강현면 물치리 7-23", "도로명이 없으면 지번 주소");
    assert.equal(body.places[1].distanceM, null);
  });
});

test("카카오 한도 초과는 429, 키·권한 문제는 503, 연결 실패·큰 응답은 502로 알린다", async () => {
  const cases = [
    [() => new Response("{}", { status: 429 }), 429],
    [() => new Response("{}", { status: 403 }), 503],
    [() => new Response("{}", { status: 500 }), 502],
    [() => new Response(null, { status: 302, headers: { Location: "https://evil.invalid/" } }), 502],
    [() => { throw new TypeError("network"); }, 502],
    [() => new Response("x".repeat(300 * 1024), { headers: { "Content-Type": "application/json" } }), 502],
    [() => Response.json({ unexpected: true }), 502],
  ];
  for (const [stub, status] of cases) {
    await withFetch(stub, async () => {
      assert.equal((await handleRequest(request("?q=물치항"), env())).status, status);
    });
  }
});

test("결과는 10개까지만 보낸다", () => {
  const documents = Array.from({ length: 15 }, (_, index) => kakaoDocument({ place_name: `장소${index}` }));
  assert.equal(mapKakaoPlaces({ documents }).length, 10);
  assert.equal(parsePlacesQuery(new URL(`https://x.invalid/?q=${"가".repeat(80)}`)).query.length, 60);
  assert.equal(parsePlacesQuery(new URL("https://x.invalid/?q=%EA%B0%95%EB%82%A8%EC%97%AD%0A%EC%8A%A4%ED%83%80%EB%B2%85%EC%8A%A4")).query,
    "강남역 스타벅스", "줄바꿈은 지우지 않고 띄어 쓴다(두 낱말이 붙으면 엉뚱한 곳이 나온다)");
});
