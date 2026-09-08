# 서버 전체 보안 강화 — 2026-09-09

## 범위와 위협 모델

대상은 기존 `hataepilot.com`의 OAuth 프록시와 전국 카메라 수집·배포입니다. 시작 커밋은 `eadd2f1`, 격리 구현을 원본 main에 반영한 커밋은 `ed9049e`입니다. 기존 차량 명령의 개인키 업로드와 실제 차량 명령은 이번 작업에 포함하지 않습니다.

보호 자산은 OAuth 클라이언트 비밀·사용자 토큰·차량 식별 정보와 카메라 데이터 무결성입니다. 인터넷 HTTP 입력 → Pages → 고정 Tesla 토큰 엔드포인트, 공공 원본 → 정규화 SQLite → 정적 배포를 각각 신뢰 경계로 검토했습니다. 요청/응답 자원 소모, 토큰 캐시·오류 노출, 부분 수집의 정상 배포가 이번 수정 대상입니다.

## 확인한 문제와 수정

| 위험도 | 문제 | 반영한 방어 |
|---|---|---|
| MEDIUM | OAuth 본문 크기·타입·읽기 시간 제한 누락 | JSON 객체·허용 필드만 수신, 32 KiB와 2초 전체 본문 제한 |
| MEDIUM | 공급자 응답 대기·크기·리다이렉트 제한 누락 | fetch부터 본문 소비까지 8초, AbortSignal, 64 KiB, redirect:error, JSON 객체 검사 |
| MEDIUM | 토큰 응답 캐시와 공급자 오류 원문 노출 | 성공/실패 모두 no-store/no-cache/nosniff, 고정 오류 코드 |
| MEDIUM | 수집 중간 페이지가 비어도 작은 DB 게시 | totalCount·페이지별 예상 건수·행 필수 컬럼·최종 건수 일치 검사 |
| MEDIUM | 모든 페이지가 있어도 좌표가 손상되면 거의 빈 DB 게시 | 정규화 후 전국 데이터 최소 1,000건 검증, 쓰기 전 실패 |

원본 건수는 1,000~1,000,000 범위의 정수이며, 정상적인 감소는 허용합니다. 예를 들어 24,001건을 10,000+10,000+4,001로 온전히 수집하면 통과합니다. 25,000건 메타데이터 뒤 두 번째 페이지가 비거나, 1,000개 원본 중 좌표 유효 데이터가 0~1개라면 기존 DB와 manifest를 보존합니다.

Tesla endpoint·client ID·audience·등록 콜백은 기존 계약을 유지합니다. 임의 URL 프록시, CORS 와일드카드, 토큰 로그, 추가 시크릿은 도입하지 않았습니다. 입력 제한은 전체 서비스 사용량 제한을 대신하지 않습니다.

## 실행 증거

- Node 전체 48개 통과: 기존 36개와 새 OAuth 공격 회귀 12개.
- Python 모의 수집 6개 통과: 불완전 페이지·손상된 정규화 결과의 기존 파일 보존 포함.
- Wrangler 4.129.0 `pages functions build functions --outdir build/pages-functions`: 성공.
- Windows에서도 배포 경계 검사가 동일하게 동작하도록 ignore 파일 CRLF를 테스트에서 정규화했습니다.
- 읽기 전용 독립 보안 검수: 추가로 확정한 P1/P2 없음. 검수 중 발견된 정규화 후 0~1건 게시 문제를 수정하고 재검증했습니다.
- 실제 Tesla 토큰·차량 명령 없이 가짜 공급자와 로컬 파일로 검증했습니다. 운영 배포 후 증거는 `HANDOFF.md`에 별도로 기록합니다.
- 최종 코드 `33bb64d`의 Actions `34258854160` 배포 성공 및 운영 18개 검사 통과. 기존 키·시크릿 설정을 유지했습니다.

```powershell
cd "D:\AI PROJECT\hataepilot-wellknown"
npm test
python -m unittest discover -s tests -p "test_fetch_cameras.py"
node --check functions/_lib/oauth-proxy.js
npx wrangler pages functions build functions --outdir build/pages-functions
git diff --check
```

## 남은 운영 경계

- 이 점검은 침해 사고가 없었다거나 모든 공격이 불가능함을 보증하지 않습니다. 검사한 로컬 Git 이력에서 비밀 패턴 노출 증거는 발견되지 않았습니다.
- Cloudflare 계정 전체의 WAF·요금·접근 로그·사용자 권한은 별도 운영 점검 범위입니다. 다수 사용자 공개 서비스로 확장하기 전 서버 요청 횟수 제한을 재설계해야 합니다.
- 실제 새 로그인/MFA, 토큰 갱신 공급자 응답, 실제 차량 명령 검증은 이번 가짜 입력 테스트와 구분합니다.
- 차량 명령 개인키·subject를 Cloudflare에 저장하는 이전 승인 요청은 여전히 대기 상태입니다. 일반 보안 요청을 그 업로드 승인으로 해석하지 않았습니다.

관련 근거: [Tesla OAuth 공식 문서](https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens), 기존 `docs/WELCOME_LIGHTS_SECURITY.md`, Android 저장소의 `docs/SECURITY_REVIEW_2026-09-09.md`.
