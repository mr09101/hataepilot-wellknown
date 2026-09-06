"""전국무인교통단속카메라표준데이터(15028200)를 내려받아 앱용 SQLite로 변환한다.

공공데이터포털의 표준데이터 다운로드는 화면에서 내부 JSON API를 페이징 호출하는 구조라,
인증키 없이도 전량을 받을 수 있다. 다만 문서화되지 않은 경로이므로 초기 적재/검증용으로만 쓴다.
정기 갱신은 활용신청(자동승인) 후 오픈API로 전환한다.

코드값 근거: 행정안전부 고시 「공공데이터 제공 표준」 데이터셋 101 무인교통단속카메라
  단속구분      01 속도 / 02 신호 / 03 통행위반(갓길·버스전용) / 04 불법주정차 / 99 기타
  단속구간위치구분  01 시점 / 02 종점
  보호구역구분   01 노인 / 02 어린이 / 99 기타   ← 어린이가 02다. 뒤집어 쓰면 안 된다.
"""
import hashlib
import json
import re
import sqlite3
import sys
from datetime import date
import urllib.parse
import urllib.request
from pathlib import Path

PK = "15028200"
TABLE = "tn_pubr_public_unmanned_traffic_camera_svc"
BASE = "https://www.data.go.kr"
PER_PAGE = 10000
OUT_DIR = Path(__file__).resolve().parent.parent / "data"

# 앱이 실제로 쓰는 컬럼만 추린다. 원본 21개 중 8개.
KEEP = {
    "LATITUDE": "lat",
    "LONGITUDE": "lon",
    "REGLT_SE": "kind",             # 단속구분
    "LMTT_VE": "speed_limit",       # 제한속도 (0 = 속도 무제한, 결측 아님)
    "REGLT_SCTN_LC_SE": "sctn_pos",  # 구간단속 시점/종점
    "PRTCAREA_TYPE": "zone",        # 보호구역구분
    "ITLPC": "place",               # 설치장소
    "ROAD_ROUTE_NM": "route",       # 도로노선명 (구간단속 페어링용)
}


def http_get(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def fetch_total() -> int:
    url = f"{BASE}/download/columList.json?{urllib.parse.urlencode({'pk': PK, 'ext': 'CSV'})}"
    return int(json.loads(http_get(url))["totalCount"])


def fetch_rows(total: int) -> list[dict]:
    """KEEP에 있는 컬럼만 요청한다.

    전체 23개 컬럼을 한 번에 요청하면 서버가 빈 응답(0바이트)을 돌려준다.
    필요한 8개만 요청하면 perPage=10000도 정상 응답한다.
    """
    rows: list[dict] = []
    pages = (total + PER_PAGE - 1) // PER_PAGE
    for page in range(1, pages + 1):
        params = [
            ("publicDataPk", PK),
            ("totalCount", str(total)),
            ("svcTableNm", TABLE),
            ("perPage", str(PER_PAGE)),
            ("page", str(page)),
        ] + [("colNmList", c) for c in KEEP]
        url = f"{BASE}/download/standard.json?{urllib.parse.urlencode(params)}"
        got = json.loads(http_get(url))
        rows.extend(got)
        print(f"  page {page}/{pages}: {len(got)}건 (누적 {len(rows)})")
    return rows


def norm_code(raw) -> str:
    """'01' -> '1', '01+02' -> '1+2', None/'' -> ''. 기관마다 제로패딩이 제각각이다."""
    if raw is None:
        return ""
    s = str(raw).strip()
    if not s:
        return ""
    return "+".join(str(int(p)) for p in s.split("+") if p.strip().isdigit())


def to_float(raw):
    try:
        return float(str(raw).strip())
    except (TypeError, ValueError):
        return None


def build(rows: list[dict]) -> list[tuple]:
    out, skipped = [], 0
    for r in rows:
        lat, lon = to_float(r.get("LATITUDE")), to_float(r.get("LONGITUDE"))
        # 한반도 밖 좌표는 오입력으로 보고 버린다.
        if lat is None or lon is None or not (33.0 <= lat <= 38.7) or not (124.5 <= lon <= 132.0):
            skipped += 1
            continue
        speed = to_float(r.get("LMTT_VE"))
        out.append((
            round(lat, 7),
            round(lon, 7),
            norm_code(r.get("REGLT_SE")),
            int(speed) if speed is not None else 0,
            norm_code(r.get("REGLT_SCTN_LC_SE")),
            norm_code(r.get("PRTCAREA_TYPE")),
            (r.get("ITLPC") or "").strip(),
            (r.get("ROAD_ROUTE_NM") or "").strip(),
        ))
    if skipped:
        print(f"  좌표 이상으로 제외: {skipped}건")
    return out


def write_db(records: list[tuple], path: Path) -> None:
    path.unlink(missing_ok=True)
    con = sqlite3.connect(path)
    con.executescript("""
        CREATE TABLE camera (
            id          INTEGER PRIMARY KEY,
            lat         REAL NOT NULL,
            lon         REAL NOT NULL,
            kind        TEXT NOT NULL,
            speed_limit INTEGER NOT NULL,
            sctn_pos    TEXT NOT NULL,
            zone        TEXT NOT NULL,
            place       TEXT NOT NULL,
            route       TEXT NOT NULL
        );
    """)
    con.executemany(
        "INSERT INTO camera (lat, lon, kind, speed_limit, sctn_pos, zone, place, route)"
        " VALUES (?,?,?,?,?,?,?,?)",
        records,
    )
    # 주행 중 근접 검색은 위경도 범위 스캔이므로 복합 인덱스를 건다.
    con.execute("CREATE INDEX idx_camera_latlon ON camera (lat, lon);")
    con.commit()
    con.close()


def report(records: list[tuple]) -> None:
    from collections import Counter
    kinds = Counter(r[2] for r in records)
    names = {"1": "속도", "2": "신호", "3": "통행위반", "4": "불법주정차", "99": "기타"}
    print("\n단속구분 분포")
    for code, n in kinds.most_common():
        print(f"  {code:<6} {names.get(code, '복합/미상'):<10} {n:>6}건")
    sctn = Counter(r[4] for r in records if r[4])
    print(f"\n구간단속: 시점 {sctn.get('1', 0)}건 / 종점 {sctn.get('2', 0)}건")
    zones = Counter(r[5] for r in records if r[5])
    print(f"보호구역: 노인(1) {zones.get('1', 0)}건 / 어린이(2) {zones.get('2', 0)}건 / 기타(99) {zones.get('99', 0)}건")
    speed_ok = sum(1 for r in records if r[3] > 0)
    print(f"제한속도 지정: {speed_ok}건 / 0(무제한·미해당): {len(records) - speed_ok}건")


PORTAL_PAGE = "https://www.data.go.kr/data/15028200/standard.do"


def fetch_portal_updated() -> str:
    """포털 상세 페이지의 '수정일'. 앱은 이 값을 데이터 버전으로 비교한다. 못 읽으면 오늘 날짜."""
    try:
        req = urllib.request.Request(PORTAL_PAGE, headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            html = resp.read().decode("utf-8", "ignore")
        m = re.search(r"수정일</strong>\s*<div class=\"value\">(\d{4}-\d{2}-\d{2})", html)
        if m:
            return m.group(1)
    except Exception as e:  # 페이지 구조가 바뀌어도 수집은 계속돼야 한다
        print(f"  수정일 조회 실패({e}); 오늘 날짜를 버전으로 씁니다")
    return date.today().isoformat()


def write_manifest(db: Path, count: int, version: str) -> Path:
    """앱 자동 갱신용 매니페스트. version이 다르면 앱이 db를 새로 받는다(순서 비교 없음)."""
    data = db.read_bytes()
    manifest = {
        "version": version,
        "sha256": hashlib.sha256(data).hexdigest(),
        "size": len(data),
        "count": count,
        "source_updated": version,
        "generated_at": date.today().isoformat(),
    }
    out = db.with_name("cameras.json")
    out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return out


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    if "--manifest-only" in sys.argv:
        # 이미 만든 cameras.db로 매니페스트만 다시 쓴다(배포 준비용).
        db = OUT_DIR / "cameras.db"
        count = sqlite3.connect(db).execute("SELECT COUNT(*) FROM camera").fetchone()[0]
        out = write_manifest(db, count, fetch_portal_updated())
        print(out.read_text(encoding="utf-8"))
        return
    print("[1/4] 메타데이터 조회")
    total = fetch_total()
    print(f"  전체 {total}건, 요청 컬럼 {len(KEEP)}개")

    print("[2/4] 원본 다운로드")
    rows = fetch_rows(total)

    print("[3/4] 정규화")
    records = build(rows)
    print(f"  유효 {len(records)}건")

    print("[4/4] SQLite 생성")
    db = OUT_DIR / "cameras.db"
    write_db(records, db)
    print(f"  {db} ({db.stat().st_size / 1024 / 1024:.2f} MB)")
    out = write_manifest(db, len(records), fetch_portal_updated())
    print(f"  {out}")

    report(records)


if __name__ == "__main__":
    main()
