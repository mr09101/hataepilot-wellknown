# HANDOFF

## 현재 상태

- 절대 경로: `D:\AI PROJECT\hataepilot-wellknown`
- 기준 커밋: `437b429`
- 웰컴라이트 서버 구현과 로컬 mock/암호 검증을 완료했습니다.
- 2026-09-09 Pages 코드 배포 `d438e159` → `https://hataepilot.com` 완료. 정적 공개 6파일만 업로드했습니다.
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
- 실제 계정 토큰과 실제 차량은 테스트에 사용하지 않았습니다.
- 운영 서버 14개 검사 PASS: GET405, POST503/no-store, 기존 공개키 일치, 카메라3파일 HEAD200, 내부7경로가 소스 파일을 반환하지 않음. Cloudflare HTML 폴백은 HTTP200만으로 정보 노출로 판단하지 않고 페이지 내용으로 구분했습니다. `build/live-verification-2026-09-09.json`에 비식별 결과 기록.
- 공개키와 기존 로컬 개인키가 같은 P-256 키쌍임을 값 출력 없이 확인했습니다. 최종 시크릿 저장은 위 사용자 승인 뒤에만 재시도합니다.

## 배포 전 필수 작업

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
