# PROJECT_BLUEPRINT — hataepilot-wellknown

## 1. 제품 요구사항 — 구현됐으나 검증 필요

- `hataepilot.com`에서 Tesla OAuth 토큰 교환, 카메라 데이터, 개인용 웰컴라이트 명령을 제공합니다.
- 웰컴라이트는 인증된 소유 차량이 최신 상태에서 주차·무탑승일 때만 전조등을 한 번 점멸합니다.
- 코드와 mock 검증 및 Cloudflare 코드 배포(d438e159)는 완료했습니다. 서버 키 저장 승인·설정, 차량 동의/가상키, 실제 차량 end-to-end 검증이 남았습니다.

## 2. 현재 범위와 제외 범위 — 구현·검증 완료

- 현재 범위: `flash_lights` 단일 명령, 사용자 선택 wake, 엄격한 입력·소유권·안전 상태 검사
- 제외: 잠금 해제, 경적, 주행·충전, 임의 Tesla command 또는 임의 upstream URL proxy
- 재검토 조건: 사용자가 별도 차량 기능을 명시적으로 요청하고 각 명령의 안전 조건을 다시 설계할 때

## 3. 아키텍처와 데이터 모델 — 구현됐으나 검증 필요

- Android → Cloudflare Pages Function → Tesla Fleet API `/vehicles`, `/vehicle_data`, `/wake_up`, `/signed_command`
- 서버는 요청 사이에 토큰, VIN, 세션 키, 차량 상태를 저장하지 않습니다.
- 세션은 요청마다 새 routing address와 UUID로 생성합니다. 실제 Tesla 응답 호환성은 운영 검증이 필요합니다.

## 4. 보안·개인정보 기준 — 구현됐으나 검증 필요

- 2026-09-09 전체 보안 강화: HTTP 입력→고정 Tesla API, 공공 원본→정규화 DB→공개 배포 경계에서 본문 크기·시간, 응답 캐시, 부분/손상 수집 게시 문제를 수정했습니다. Node 48·Python 6·Functions build와 독립 검수를 통과했습니다. 위협 모델·남은 운영 범위: `docs/SECURITY_REVIEW_2026-09-09.md`. 명령 키 업로드와 실제 차량 검증은 여전히 별도입니다.

- 근거: `docs/WELCOME_LIGHTS_SECURITY.md`
- JWT 서명·claims·scope, 차량 객체 소유권, 선택적 subject/VIN allowlist, 비밀키 Secret, fail-closed 상태 검증을 구현했습니다.
- 정적 자산 고정 허용 목록과 민감값 배포 방지 테스트 및 운영서버14검사를 통과했습니다. Cloudflare 차량 명령 secret은 자동 승인 검토 거절 후 사용자 승인 대기 중입니다.

## 5. 트래픽·확장성 가정 — 계획됨

- 개인 사용자 한 명, 접근 이벤트당 최대 한 요청을 가정합니다.
- wake 포함 최악 경로는 제한된 네트워크 요청과 최대 네 번의 온라인 확인만 수행합니다.
- 다중 사용자 또는 높은 동시성이 생기면 Durable Object/KV 기반 서버 측 중복 억제를 별도 설계합니다.

## 6. 장애·운영 대응 — 구현됐으나 검증 필요

- 2026-09-09 휴대폰의 토큰 갱신 502로 차량 목록 조회가 중단됐습니다. 서버용 공식 Fleet 인증 주소로 교정하고 Node 48개 및 독립 검수를 통과했습니다. 운영 배포와 실기기 복구 여부는 `HANDOFF.md`의 최신 토큰 주소 교정 기록을 기준으로 합니다.

- 외부 요청 timeout, 공급자 상태 코드 매핑, no-store 응답, 결과 불확실 시 무재시도를 구현했습니다.
- 이전 배포로 되돌리는 방법은 Cloudflare Pages deployment rollback입니다. 실제 rollback 권한과 절차 확인이 남았습니다.

## 7. 테스트와 검수 기준 — 구현됐으나 검증 필요

- `npm test`, 네 JavaScript 구문의 `node --check`, `git diff --check`를 완료 조건으로 사용합니다.
- 공식 ECDH·세션 벡터와 독립 HMAC/AES-GCM 벡터, 인증·입력·상태 실패 사례를 검증합니다.
- 실제 차량에서는 주차·무탑승·수동 1회 점멸만 허용하며 자동 접근 테스트는 그 이후에 수행합니다.

## 8. 향후 확장 경로 — 계획됨

- 명령 세션 cache는 개인 사용량에서 필요하지 않습니다. 비용·지연 문제가 측정될 때 암호화 cache를 검토합니다.
- 서버 측 중복 방지는 다중 사용자 또는 재전송 사고가 관측될 때 Durable Object로 도입합니다.

## 9. 작업 담당과 검수 배정 — 구현됐으나 검증 필요

- 구현: Codex 웰컴라이트 서버 하위 작업
- 최종 통합·Cloudflare 배포·실차 검증: 상위 `tesla-drive-assist` 작업
- 인증·보안 독립 검수 결과를 반영한 공식 field 번호와 암호 벡터를 테스트에 고정했습니다.

## 10. 완료 증거와 보고 형식 — 구현됐으나 검증 필요

- 코드: `functions/api/welcome-lights.js`, `functions/_lib/*.js`
- 테스트: `tests/*.test.js`
- 보안 설계: `docs/WELCOME_LIGHTS_SECURITY.md`
- 운영 계약: `README.md`, `HANDOFF.md`
- Node36개 PASS, 독립 검수35개 PASS/추가확정P1P2없음, Functions bundle성공, 실제 서버14개 검사PASS를 `HANDOFF.md`에 기록했습니다. 실차 검증은 별도입니다.
