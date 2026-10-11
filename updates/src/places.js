// 앱 홈 "목적지 보내기"의 장소 검색(2026-10-12). 카카오 로컬 키워드 검색을 대신 부른다.
// 카카오 키는 Worker 비밀값(KAKAO_LOCAL_REST_API_KEY)에만 두고 앱에는 넣지 않는다.
// 키는 카카오맵 무료 쿼터를 가진 "공유지도" 앱의 REST 키다. 결제(비즈월렛)가 없어 한도를 넘으면 그날 검색만 막힌다.

export const KAKAO_KEYWORD_URL = "https://dapi.kakao.com/v2/local/search/keyword.json";
export const PLACES_MAX_RESULTS = 10;
export const PLACES_QUERY_MAX_CHARS = 60;
const UPSTREAM_TIMEOUT_MS = 5_000;
const UPSTREAM_MAX_BYTES = 256 * 1024;
// 앱 DestinationSearch와 같은 대략의 국내 범위.
const KOREA = Object.freeze({ south: 33.0, west: 124.5, north: 38.7, east: 132.0 });
const INVISIBLE = /[\p{Cc}\p{Cf}]/gu;

function cleanText(value, maxChars) {
  if (typeof value !== "string") return "";
  // 줄바꿈·탭은 지우지 않고 공백으로 바꾼다("강남역\n스타벅스"가 붙지 않게, 코드 검수 LOW).
  const text = value.replace(/\s+/gu, " ").replace(INVISIBLE, "").trim();
  return [...text].slice(0, maxChars).join("").trim();
}

export function inKorea(lat, lon) {
  return Number.isFinite(lat) && Number.isFinite(lon)
    && lat >= KOREA.south && lat <= KOREA.north && lon >= KOREA.west && lon <= KOREA.east;
}

function coordinate(text) {
  if (typeof text !== "string" || !/^-?\d{1,3}(?:\.\d{1,8})?$/u.test(text)) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

/** 약 1km(소수 둘째 자리)로 줄인다. 근처 매장을 앞에 두는 데는 충분하고 정확한 위치는 넘기지 않는다. */
function rounded(value) {
  return Math.round(value * 100) / 100;
}

/**
 * q(필수), lat·lon(둘 다 있거나 둘 다 없음)만 받는다. 형식이 틀리면 null(400).
 * 국내 밖 좌표는 위치 없이 찾는다(해외에서 켜도 검색은 된다).
 */
export function parsePlacesQuery(url) {
  const keys = [...url.searchParams.keys()];
  if (keys.length === 0 || new Set(keys).size !== keys.length || keys.some((key) => !["q", "lat", "lon"].includes(key))) {
    return null;
  }
  const query = cleanText(url.searchParams.get("q"), PLACES_QUERY_MAX_CHARS);
  if ([...query].length < 2) return null;
  const hasLat = url.searchParams.has("lat");
  if (hasLat !== url.searchParams.has("lon")) return null;
  if (!hasLat) return { query, near: null };
  const lat = coordinate(url.searchParams.get("lat"));
  const lon = coordinate(url.searchParams.get("lon"));
  if (lat === null || lon === null) return null;
  return { query, near: inKorea(lat, lon) ? { lat: rounded(lat), lon: rounded(lon) } : null };
}

/**
 * 카카오 응답에서 앱이 쓰는 값만 남긴다. 국내 밖·좌표나 주소가 없는 결과는 빼고, 같은 이름·주소는 한 번만 둔다.
 * 주소는 도로명을 먼저 쓴다(차 내비가 글로 다시 찾는다).
 */
export function mapKakaoPlaces(body) {
  if (!Array.isArray(body?.documents)) throw new Error("invalid_upstream");
  const seen = new Set();
  const places = [];
  for (const document of body.documents) {
    if (places.length >= PLACES_MAX_RESULTS) break;
    const name = cleanText(document?.place_name, 100);
    const address = cleanText(document?.road_address_name, 200) || cleanText(document?.address_name, 200);
    const lat = Number(document?.y);
    const lon = Number(document?.x);
    if (!name || !address || !inKorea(lat, lon)) continue;
    const key = JSON.stringify([name, address]);
    if (seen.has(key)) continue;
    seen.add(key);
    const distance = typeof document?.distance === "string" && /^\d{1,7}$/u.test(document.distance)
      ? Number(document.distance) : null;
    places.push({ name, address, lat, lon, distanceM: distance, category: cleanText(document?.category_group_name, 40) });
  }
  return places;
}

async function readLimited(response, maximumBytes) {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) throw new Error("too_large");
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) throw new Error("too_large");
      chunks.push(value);
    }
  } catch (error) {
    try { await reader.cancel(); } catch { /* Nothing to retry. */ }
    throw error;
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

/**
 * 결과: ok(places), quota(카카오 한도 초과), misconfigured(키·권한 문제), unavailable(그 밖). 카카오 원문은 앱에 넘기지 않는다.
 * 실패에는 [reason](상태 코드·예외 이름만)을 붙인다. 검색어·위치·키는 담지 않는다(배포 첫날 502 원인 확인용, 2026-10-12).
 */
export async function searchKakaoPlaces(params, apiKey, fetchImpl = fetch) {
  const url = new URL(KAKAO_KEYWORD_URL);
  url.searchParams.set("query", params.query);
  url.searchParams.set("size", String(PLACES_MAX_RESULTS));
  // 위치가 있으면 정확도순 그대로 두고 기준점만 준다(거리순은 "강남역" 같은 장소 검색을 망쳤다, 2026-10-12 실측).
  if (params.near) {
    url.searchParams.set("x", String(params.near.lon));
    url.searchParams.set("y", String(params.near.lat));
  }
  let response;
  try {
    response = await fetchImpl(url.toString(), {
      headers: { Authorization: `KakaoAK ${apiKey}` },
      // Workers에서 redirect "error"는 fetch가 TypeError로 실패했다(10/12 배포 기록). "manual"로 받고 3xx는 아래에서 실패로 본다.
      redirect: "manual",
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
    });
  } catch (error) {
    return { status: "unavailable", reason: `fetch_${error?.name ?? "error"}` };
  }
  if (!response.ok) {
    try { await response.body?.cancel(); } catch { /* Ignored. */ }
    const reason = `status_${response.status}`;
    if (response.status === 429) return { status: "quota", reason };
    if (response.status === 401 || response.status === 403) return { status: "misconfigured", reason };
    return { status: "unavailable", reason };
  }
  try {
    return { status: "ok", places: mapKakaoPlaces(JSON.parse(await readLimited(response, UPSTREAM_MAX_BYTES))) };
  } catch (error) {
    return { status: "unavailable", reason: `body_${error?.name ?? "error"}_${String(error?.message ?? "").slice(0, 40)}` };
  }
}
