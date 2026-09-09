# HANDOFF

## 2026-09-09 차량 목록 502 원인 — Workers redirect 옵션 미지원

- 주소 교정 `73001562478ba5e258bf99db9851b21a0cf06d8c`은 Actions `34344433048` 배포 성공했으나 휴대폰 502가 계속돼 추가 조사했습니다.
- 실제 workerd 런타임에 빌드된 Pages 번들을 넣고 모든 outbound를 모의 응답으로 대체하자, 공급자 호출 0회에서 `redirect: error` 미지원 TypeError → 502가 재현됐습니다. Node의 fetch 모의 검사만으로는 놓쳤던 실행 환경 차이입니다.
- `oauth-proxy.js`를 Workers가 지원하는 `redirect: manual`로 바꾸고 300~399는 본문 취소 후 고정 502로 거부합니다. 외부 Location으로 토큰을 보내지 않습니다. 기존 크기·시간 제한, 비밀값 비출력, no-store는 유지합니다.
- `node --test tests/*.test.js` 및 Wrangler Functions build, `scripts/test-oauth-worker-runtime.mjs`의 실제 workerd 모의 검사6개(토큰 교환/갱신 각각200/401/302)를 실행했습니다. 외부 실제 네트워크 요청은 0회입니다. 코드 배포 후 실제 휴대폰 갱신·목록 복구는 후속 기록에 남깁니다.
- 런타임 검증: Wrangler로 `build/oauth-endpoint-functions`를 만든 뒤 설치된 Miniflare 모듈 경로를 `MINIFLARE_MODULE`에 지정하고 `node scripts/test-oauth-worker-runtime.mjs build/oauth-endpoint-functions/index.js` 실행. Node 테스트와 별개로 실제 플랫폼 런타임에서도 성공·실패 경로를 확인하는 것을 재사용 규칙으로 남깁니다.
- 웰컴라이트 관련 세 모듈에도 같은 옵션이 남아 있음을 확인했습니다. 차량 명령 키 업로드 승인 대기 중인 비활성 경로로, 이번 토큰 갱신 수정과 별도로 실제 활성화 전에 교정·검증해야 합니다.

## 2026-09-09 차량 목록 조회 실패 — 토큰 서버 주소 교정

- 시작 커밋 `69e9147`. 연결 휴대폰에서 access 만료 → `/api/refresh` HTTP 502 → 차량 목록 GET 미실행을 확인했습니다. 기존 refresh 및 선택 차량은 보존됐습니다. 비식별 진단은 `D:\AI PROJECT\tesla-drive-assist\build\audio-mix-2026-09-09\vehicle-list-diagnostic.json`입니다.
- `functions/api/token.js`·`refresh.js`의 서버 토큰 주소를 현재 공식 `https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/token`으로 교정했습니다. 브라우저 로그인 주소·client ID/secret·scope·NA audience·redirect URI는 그대로입니다.
- 공식 근거: https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens
- 기존 정확 URL 계약 테스트에서 수정 전 2개 실패를 재현했고, 수정 후 `node --test tests/*.test.js` 48/48 및 Wrangler 4.129.0 Functions build를 통과했습니다. 독립 인증 검수도 OAuth 12/12 및 diff 검사 통과, 추가 확정 P1/P2 없음입니다.
- 이 커밋 시점에는 운영 배포와 실제 토큰 갱신·차량 목록 복구 검증이 남았습니다. 기존 Cloudflare Pages 배포 workflow를 사용하며 새 시크릿을 업로드하지 않습니다. 배포·실기기 후속 결과 및 최종 해시는 다음 기록에 남깁니다.

## 2026-09-09 전체 보안 강화

- 시작 `eadd2f1`, 원본에 반영한 보안 구현 `ed9049ed4fe776540bc254e391668094057f4694`. 이후 정규화 최소 건수와 Windows 검사 호환성 보완을 같은 작업에서 반영했습니다. 최종 문서 포함 커밋은 `git log -1`을 기준으로 합니다.
- OAuth 요청 32 KiB/2초, 공급자 응답 64 KiB/8초, 고정 HTTPS·콜백, no-store/no-cache, 안전한 오류를 적용했습니다.
- 원본 전체/페이지별 건수와 정규화 후 최소 1,000건이 검증돼야 DB를 씁니다. 부분/손상 수집은 기존 DB/manifest를 보존합니다.
- Node 48/48, Python 6/6, Wrangler 4.129.0 Functions build 통과. 독립 보안 검수의 추가 확정 P1/P2 없음. 실행 명령·위협 모델·잔여 범위는 `D:\AI PROJECT\hataepilot-wellknown\docs\SECURITY_REVIEW_2026-09-09.md` 참조.
- 최종 보안 코드 `33bb64dcad0e950d163e6fca8c976c963404c93f` main push 완료. GitHub Actions `34258854160` 성공으로 기존 Pages 배포 완료. 운영 서버 18개 검사 PASS: OAuth 잘못된 형식/과대 본문 거부+no-store, 명령503 유지, 카메라3파일·manifest·후면511곳 유지, 개발/비밀 경로 비공개. 증거 `D:\AI PROJECT\hataepilot-wellknown\build\live-security-verification-2026-09-09.json`. Cloudflare HEAD는 Content-Length를 생략할 수 있어 응답 형식과 실제 JSON을 함께 검사했습니다. 차량 명령 키 업로드는 계속 승인 대기이며 수행하지 않았습니다.

## 현재 상태

- 절대 경로: `D:\AI PROJECT\hataepilot-wellknown`
- 시작 커밋: `437b429`, 웰컴라이트 구현 커밋: `dfd2f50fbacabb5f767c4f546f7db9649c3706d0`
- 웰컴라이트 서버 구현과 로컬 mock/암호 검증을 완료했습니다.
- 2026-09-09 Pages 코드 직접 배포 `d438e159`, 최종 Actions 배포 `95197078` → `https://hataepilot.com` 완료. 정적 공개 6파일만 업로드했습니다.
- 기존 Tesla 개인키와 사용자 subject를 Cloudflare 시크릿에 저장하는 작업은 자동 승인 검토가 해당 payload 외부 저장의 명시적 승인 부족으로 거절했습니다. 사용자 승인을 요청한 상태이며 키 업로드·우회 실행은 하지 않았습니다. 현재 POST는 503 `server_not_configured`로 차단됩니다.
- 독립 보안 재검수에서 이전 P2 네 건 해결, 추가 확정 P1/P2 없음. 코드와 실제 서버 검증 결과를 반영한 뒤 관련 파일만 커밋·푸시합니다. 최종 해시는 `git log -1` 및 Android 작업 보고서 참조.

## 최근 변경

- `POST /api/welcome-lights` 추가: Bearer 토큰, 차량 ID, VIN, wake opt-in만 허용
- Tesla 공식 JWKS 기반 JWT 서명·claims·`vehicle_cmds` 검증 추가
- 사용자 차량 목록에서 ID+VIN 소유권 재검증 추가
- wake 제한, 최신 주차·무탑승 상태 확인 추가
- Tesla Vehicle Command Protocol 세션 handshake, HMAC 서명, AES-GCM 응답 검증, `CarServer.ActionStatus` 판정 추가
- 고정 6파일 정적 허용 목록과 전용 스테이징 배포로 비밀 파일과 개발 파일의 공개 경계를 제한
- 네트워크 응답 본문까지 포함한 timeout과 명령 결과 불확실성 분류 추가
- 보안 설계, 환경 계약, 테스트 문서 추가

## 실행·검증

```powershell
cd "D:\AI PROJECT\hataepilot-wellknown"
npm test
node --check functions/_lib/tesla-protocol.js
node --check functions/_lib/tesla-jwt.js
node --check functions/_lib/welcome-lights.js
node --check functions/api/welcome-lights.js
npx --yes wrangler@4 pages functions build functions --outdir build/pages-functions
git diff --check
```

- 공개 Tesla protocol.md의 ECDH와 세션 HMAC 벡터 통과
- 별도로 계산한 flash HMAC와 AES-GCM 응답 벡터 통과
- `npm test`: 36개 테스트 모두 통과
- mock Tesla API로 입력, JWT, 소유권, stale/moving/occupied/unknown, wake 제한, 응답 본문 deadline, 불확실 명령 결과 검증
- Wrangler 4.129.0 Pages Functions 번들 성공, `/api/welcome-lights` 라우트 포함 확인
- 정적 스테이징에는 HTML, `_headers`, 공개키, 카메라 데이터 세 파일만 포함됨을 확인
- 첫 GitHub Actions 배포(34248808175)는 계정 ID 자동 조회 실패로 중단됐습니다. 성공한 로컬 배포와 같은 기존 `CLOUDFLARE_ACCOUNT_ID`를 두 배포 workflow에 명시했습니다. 수정 커밋 `5fd5acea6081754115bcb0f1cbe30d2db2fa4d74` main push 및 후속 Actions 34249152849 성공. 정적 경계3검사·독립 검수·배포 후 운영14검사 통과. 기존 API 토큰과 Tesla 시크릿은 변경하지 않았습니다.
- 실제 계정 토큰과 실제 차량은 테스트에 사용하지 않았습니다.
- 운영 서버 14개 검사 PASS: GET405, POST503/no-store, 기존 공개키 일치, 카메라3파일 HEAD200, 내부7경로가 소스 파일을 반환하지 않음. Cloudflare HTML 폴백은 HTTP200만으로 정보 노출로 판단하지 않고 페이지 내용으로 구분했습니다. `build/live-verification-2026-09-09.json`에 비식별 결과 기록.
- 공개키와 기존 로컬 개인키가 같은 P-256 키쌍임을 값 출력 없이 확인했습니다. 최종 시크릿 저장은 위 사용자 승인 뒤에만 재시도합니다.

## 기능 활성화 전 남은 작업

1. 공개 호스팅 키와 기존 개인키의 짝이 맞는지 다시 확인합니다.
2. 개인키를 P-256 PKCS#8 PEM으로 변환해 Cloudflare `TESLA_COMMAND_PRIVATE_KEY` Secret에 등록합니다.
3. 개인용 방어선으로 `TESLA_COMMAND_ALLOWED_SUB`를 설정합니다. 사용자 소유 여러 차량을 앱에서 선택하므로 VIN 제한은 기본적으로 두지 않고, 매 요청의 소유권 ID+VIN 검증을 유지합니다.
4. Pages Function을 배포하고, GET이 405이며 실제 키 없는 환경에서 POST가 503 `server_not_configured`인지 먼저 확인합니다.
5. Android가 `vehicle_cmds` 권한 재로그인과 `hataepilot.com` 키 페어링을 완료한 뒤, 주차·무탑승 상태에서 수동 점멸 한 번만 실행합니다.

## 주의할 점

- `TESLA_COMMAND_PRIVATE_KEY`는 `BEGIN PRIVATE KEY` PKCS#8만 받습니다. 기존 `BEGIN EC PRIVATE KEY` SEC1을 그대로 넣으면 안전하게 `server_not_configured`로 실패합니다.
- 명령 응답이 끊기면 차량에서 이미 실행됐을 수 있으므로 `command_outcome_unknown`을 자동 재시도하면 안 됩니다.
- `is_user_present` 또는 상태 timestamp가 없으면 의도적으로 거부합니다.
- `deploy-pages.yml`은 Functions·공개 자산 변경 push와 수동 실행에서 고정 스테이징을 배포하며, 카메라 갱신 workflow도 같은 스테이징만 배포합니다.
- Android 최종 통합 보고서: `D:\AI PROJECT\tesla-drive-assist\docs\VEHICLE_CONVENIENCE_2026-09-09.md`. 현재 휴대폰의 vehicle_cmds 동의, 차량 가상키 등록, 실제 주차/점유 응답과 점멸은 미검증입니다.
