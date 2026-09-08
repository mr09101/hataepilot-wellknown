# 웰컴라이트 보안 설계

## 위협 모델

- 보호 자산: Tesla OAuth 액세스 토큰, 명령 서명 개인키, 사용자 차량 소유권, 차량의 물리 상태
- 진입점: 공개 `POST /api/welcome-lights` 요청 본문과 Authorization 헤더, Tesla API 및 JWKS 응답, Cloudflare 환경 변수
- 신뢰 경계: Android 앱 → Cloudflare Pages Function → Tesla Fleet API → 차량
- 주요 실패 형태: 위조 토큰, 다른 사람 차량 ID 대입, 범위 없는 토큰, VIN/호스트 주입, 주행·탑승 중 점멸, 오래된 상태 사용, 비밀키 정적 배포, 네트워크 재시도로 중복 점멸, 성공 오보
- 안전한 검증: 생성한 테스트 키와 공개 Tesla 벡터, mock Fleet API만 사용하며 실제 토큰과 실제 차량 명령은 사용하지 않음

## 적용한 방어

- HTTP 본문은 512바이트 이하이며 `vehicle_id`, `vin`, `wake` 세 필드만 허용합니다.
- Tesla API와 JWKS 호스트는 코드에 고정되어 요청자가 URL을 지정할 수 없습니다.
- 액세스 토큰의 JWT payload만 읽어 신뢰하지 않습니다. Tesla 공식 JWKS에서 선택한 키로 JWS를 검증한 뒤 발급자, audience, 앱 ID, 만료, `vehicle_cmds`를 검사합니다.
- 같은 Bearer 토큰으로 `GET /api/1/vehicles`를 호출하고, 반환된 한 항목에서 ID와 VIN이 동시에 일치해야 합니다.
- 개인 배포는 `TESLA_COMMAND_ALLOWED_VIN`과 `TESLA_COMMAND_ALLOWED_SUB`를 추가 방어선으로 사용할 수 있습니다.
- 요청 본문 읽기는 2초, Tesla API·JWKS·명령 요청과 응답 본문 소비는 각각 5~8초 안에 끝나야 하며, wake 후 온라인 확인은 최대 네 번입니다.
- 차량 상태 두 묶음의 timestamp가 모두 30초 이내여야 합니다. `P`이면서 속도가 null/0이거나, 기어가 null이면서 속도가 명시적 0일 때만 주차로 인정합니다.
- `is_user_present`가 정확히 `false`일 때만 허용합니다. 누락이나 알 수 없는 값은 거부합니다.
- 개인키는 Cloudflare Secret의 PKCS#8 PEM에서만 읽습니다. 테스트, 문서, 정적 파일, 응답, 로그에는 포함하지 않습니다.
- Tesla 공식 규격의 P-256 ECDH, SHA-1 절단 키 유도, HMAC-SHA256, AES-GCM을 WebCrypto로 수행합니다. 세션 응답 HMAC, routing address, domain, UUID, VIN, counter, epoch, TTL, 응답 request hash와 인증 태그를 검증합니다.
- `CarServer.ActionStatus`가 실제로 존재하고 OK일 때만 성공입니다. HTTP 200만으로 성공 판정하지 않습니다.
- 물리 명령은 한 요청에서 한 번만 전송합니다. 전송 이후 timeout이나 해석 오류는 결과 불확실로 처리하고 재전송하지 않습니다.
- 모든 API 응답은 `Cache-Control: no-store`이며 공급자 원문과 식별자를 내보내지 않습니다.
- 운영 배포는 고정 허용 목록을 새 스테이징 디렉터리에 복사한 뒤 그 디렉터리만 업로드합니다. 테스트, 문서, 환경 파일, 비밀키, 패키지 메타데이터는 목록에 없으며 `.assetsignore`도 보조 방어선으로 유지합니다.

## 공식 근거

- Tesla Vehicle Command Protocol: https://github.com/teslamotors/vehicle-command/blob/main/pkg/protocol/protocol.md
- Tesla 공식 Go 구현: https://github.com/teslamotors/vehicle-command
- Tesla Vehicle Commands: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands
- Tesla Vehicle Endpoints: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints
- Tesla OAuth Authentication: https://developer.tesla.com/docs/fleet-api/authentication/overview
- Tesla 공식 OpenID metadata: https://fleet-auth.prd.vn.cloud.tesla.com/oauth2/v3/thirdparty/.well-known/openid-configuration

## 남은 운영 검증

- Cloudflare Secret에 공개키와 짝이 맞는 PKCS#8 개인키를 등록하고 새 Function을 배포해야 합니다.
- 사용자가 `vehicle_cmds`를 동의한 뒤 차량에 `hataepilot.com` 키를 페어링해야 합니다.
- 차량이 주차되어 있고 사람이 타지 않은 상태에서 수동 점멸 한 번으로 end-to-end 성공을 확인해야 합니다.
- 실제 응답이 문서 계약과 다를 경우 원문을 저장하거나 출력하지 말고, 마스킹된 코드와 단계만으로 진단합니다.
