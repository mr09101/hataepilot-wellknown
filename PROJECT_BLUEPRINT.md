# 하태파일럿 서버 프로젝트 기준서

최신 OTA 작업은 `updates/운영-안내.md`와 `HANDOFF.md`의 2026-09-10 기록을 따릅니다. 로컬 구현·검수와 원격 배포 완료를 구분합니다.

## 1. 제품 요구사항 — 구현됐으나 검증 필요

- 개인 APK 무선 업데이트·같은 서명 복구판·사용량 제한과 고정 복구 안내를 제공합니다. 로컬 구현은 완료했고 R2 구독·권한/배포 및 실제 인터넷 설치는 남았습니다.
- `hataepilot.com`에서 Tesla OAuth 토큰 교환, 카메라 데이터, 개인용 웰컴라이트 명령을 제공합니다.
- 웰컴라이트는 인증된 소유 차량이 최신 상태에서 주차·무탑승일 때만 전조등을 한 번 점멸합니다.
- 코드와 mock 검증 및 Cloudflare 코드 배포(d438e159)는 완료했습니다. 서버 키 저장 승인·설정, 차량 동의/가상키, 실제 차량 end-to-end 검증이 남았습니다.

## 2. 현재 범위와 제외 범위 — 구현·검증 완료

- OTA 범위: 인증된 정상/복구 APK2개 및 버전 목록, 사용량 예약, 공개 안내 HTML. 제외: 강제 설치, 다사용자 배포, 임의 파일 저장/프록시, 계정 전체 강제 비용 차단.
- 현재 범위: `flash_lights` 단일 명령, 사용자 선택 wake, 엄격한 입력·소유권·안전 상태 검사
- 제외: 잠금 해제, 경적, 주행·충전, 임의 Tesla command 또는 임의 upstream URL proxy
- 재검토 조건: 사용자가 별도 차량 기능을 명시적으로 요청하고 각 명령의 안전 조건을 다시 설계할 때

## 3. 아키텍처와 데이터 모델 — 구현됐으나 검증 필요

- 앱/브라우저 → 별도 Worker → SQLite Durable Object 예산 예약 → private R2 Standard. 고정3객체, strict manifest와 APK metadata 대조. 공개 안내는 기존 Pages 허용 목록에 포함하며 인증 Worker와 분리합니다.
- Android → Cloudflare Pages Function → Tesla Fleet API `/vehicles`, `/vehicle_data`, `/wake_up`, `/signed_command`
- 서버는 요청 사이에 토큰, VIN, 세션 키, 차량 상태를 저장하지 않습니다.
- 세션은 요청마다 새 routing address와 UUID로 생성합니다. 실제 Tesla 응답 호환성은 운영 검증이 필요합니다.

## 4. 보안·개인정보 기준 — 구현됐으나 검증 필요

- OTA는 32byte 개인 암호의 SHA256만 Worker Secret에 저장합니다. 인증 전 R2/DO 비접근, POST 동일출처/주차확인, 응답 no-store/nosniff, 크기/버전/서명/디버그 APK/배포경계 검사. 독립 보안 재검수 P1/P2잔여0, 실제 원격 권한·저장소 검증은 남았습니다.
- 2026-09-09 전체 보안 강화: HTTP 입력→고정 Tesla API, 공공 원본→정규화 DB→공개 배포 경계에서 본문 크기·시간, 응답 캐시, 부분/손상 수집 게시 문제를 수정했습니다. Node 48·Python 6·Functions build와 독립 검수를 통과했습니다. 위협 모델·남은 운영 범위: `docs/SECURITY_REVIEW_2026-09-09.md`. 명령 키 업로드와 실제 차량 검증은 여전히 별도입니다.

- 근거: `docs/WELCOME_LIGHTS_SECURITY.md`
- JWT 서명·claims·scope, 차량 객체 소유권, 선택적 subject/VIN allowlist, 비밀키 Secret, fail-closed 상태 검증을 구현했습니다.
- 정적 자산 고정 허용 목록과 민감값 배포 방지 테스트 및 운영서버14검사를 통과했습니다. Cloudflare 차량 명령 secret은 자동 승인 검토 거절 후 사용자 승인 대기 중입니다.

## 5. 트래픽·확장성 가정 — 구현됐으나 검증 필요

- OTA 조회100/일·1000/월, 다운로드4/일·20/월·4GiB/월, APK합계384MiB 이하. SQLite 원자 예약과 UTC경계·동시110요청상한을 로컬에서 확인했습니다. Cloudflare 무료량은 계정전체이며 기존명령·다른프로젝트 소비는 별도입니다.
- 개인 사용자 한 명, 접근 이벤트당 최대 한 요청을 가정합니다.
- wake 포함 최악 경로는 제한된 네트워크 요청과 최대 네 번의 온라인 확인만 수행합니다.
- 다중 사용자 또는 높은 동시성이 생기면 Durable Object/KV 기반 서버 측 중복 억제를 별도 설계합니다.

## 6. 장애·운영 대응 — 구현됐으나 검증 필요

- OTA는 예산/인증/메타데이터 실패 시 파일 제공을 차단합니다. 게시 도구는 PUT/HEAD 실패 뒤 후속PUT 없이 종료하며 같은 산출물 재게시로 복구합니다. manifest마지막 게시 전 부분교체의 일시503 가능성을 기록했고 각 PUT/HEAD 실패 주입을 검증했습니다. 실제원격 재게시/복구는 남았습니다.
- 2026-09-09 토큰 갱신 502는 Workers의 `redirect:error` 미지원으로 재현했습니다. 공식 Fleet 인증 주소와 `manual`+3xx 명시 거부를 배포(d914a7d/Actions34345866658)한 뒤 동일 휴대폰의 갱신200·목록200·차량2대·선택 보존을 확인했습니다. Node49·실제workerd 모의6·독립 검수를 통과했습니다. 웰컴 경로의 같은 옵션은 비활성 기능의 별도 수정/검증 항목으로 남아 있습니다. 상세 근거는 `HANDOFF.md` 최신 기록을 따릅니다.

- 외부 요청 timeout, 공급자 상태 코드 매핑, no-store 응답, 결과 불확실 시 무재시도를 구현했습니다.
- 이전 배포로 되돌리는 방법은 Cloudflare Pages deployment rollback입니다. 실제 rollback 권한과 절차 확인이 남았습니다.

## 7. 테스트와 검수 기준 — 구현됐으나 검증 필요

- OTA Node39/전체89 PASS, Wrangler deploy dry-run, 실제APK dry-run, local workerd+SQLite 인증·동시요청한도 검사. 웹 desktop/mobile 및 보안 독립검수. 실제 R2·AWS호환·인터넷다운로드·폰 복구설치는 미검증입니다.
- `npm test`, 네 JavaScript 구문의 `node --check`, `git diff --check`를 완료 조건으로 사용합니다.
- 공식 ECDH·세션 벡터와 독립 HMAC/AES-GCM 벡터, 인증·입력·상태 실패 사례를 검증합니다.
- 실제 차량에서는 주차·무탑승·수동 1회 점멸만 허용하며 자동 접근 테스트는 그 이후에 수행합니다.

## 8. 향후 확장 경로 — 계획됨

- OTA는 개인사용 고정3객체를 유지합니다. 다사용자·무중단 다버전 배포 요구가 생기면 인증/예산·불변객체 게시·수명정책을 재설계합니다.
- 명령 세션 cache는 개인 사용량에서 필요하지 않습니다. 비용·지연 문제가 측정될 때 암호화 cache를 검토합니다.
- 서버 측 중복 방지는 다중 사용자 또는 재전송 사고가 관측될 때 Durable Object로 도입합니다.

## 9. 작업 담당과 검수 배정 — 구현됐으나 검증 필요

- OTA worker 구현 후 쓰기 소유권을 상위 세션에 반환했습니다. 별도 security_architect/UI 읽기전용 검수, 상위가 앱·배포·기기·문서·Git을 마무리합니다.
- 구현: Codex 웰컴라이트 서버 하위 작업
- 최종 통합·Cloudflare 배포·실차 검증: 상위 `tesla-drive-assist` 작업
- 인증·보안 독립 검수 결과를 반영한 공식 field 번호와 암호 벡터를 테스트에 고정했습니다.

## 10. 완료 증거와 보고 형식 — 구현됐으나 검증 필요

- OTA 소스/테스트는 `updates`, `tests/ota-*.test.js`; 운영·복구 절차는 `updates/운영-안내.md`. 실제기기/최신APK는 `D:\AI PROJECT\tesla-drive-assist\FINAL_KEEP`. 원격미완료를 전체완료로 세지 않습니다.
- 코드: `functions/api/welcome-lights.js`, `functions/_lib/*.js`
- 테스트: `tests/*.test.js`
- 보안 설계: `docs/WELCOME_LIGHTS_SECURITY.md`
- 운영 계약: `README.md`, `HANDOFF.md`
- Node36개 PASS, 독립 검수35개 PASS/추가확정P1P2없음, Functions bundle성공, 실제 서버14개 검사PASS를 `HANDOFF.md`에 기록했습니다. 실차 검증은 별도입니다.
