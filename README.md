# 하태파일럿 서버

`hataepilot.com`의 Tesla OAuth 교환, 카메라 데이터, 웰컴라이트 명령을 제공하는 Cloudflare Pages 프로젝트입니다.

## 웰컴라이트 API

`POST /api/welcome-lights`

요청에는 Tesla 사용자 액세스 토큰을 Bearer 헤더로 보내고, 본문은 아래 세 필드만 포함합니다.

```json
{
  "vehicle_id": "12345678901234567",
  "vin": "5YJ00000000000000",
  "wake": false
}
```

서버는 다음 순서로 요청을 처리합니다.

1. Tesla 공식 JWKS로 토큰 서명, 발급자, 대상 API, 앱 ID, 만료, `vehicle_cmds` 범위를 검증합니다.
2. 같은 토큰으로 Tesla 차량 목록을 조회해 요청한 차량 ID와 VIN의 소유권을 다시 확인합니다.
3. `wake=true`인 경우에만 잠든 차량을 깨우며, 횟수가 제한된 상태 조회 후에도 온라인이 아니면 중단합니다.
4. 30초 이내의 `drive_state`와 `vehicle_state`에서 주차 상태와 `is_user_present=false`가 모두 명시된 경우에만 진행합니다.
5. Cloudflare 비밀값에 저장한 P-256 개인키로 Tesla Vehicle Command Protocol 메시지를 만들고 `flash_lights` 한 건만 전송합니다.
6. Tesla의 프로토콜 오류, 암호화 응답 인증, `CarServer.ActionStatus`를 모두 확인한 뒤에만 성공을 반환합니다.

성공은 HTTP 200과 `{"ok":true,"code":"lights_flashed"}`입니다. 실패는 항상 4xx/5xx와 `{"ok":false,"code":"..."}`이며 Tesla 원문, 토큰, VIN을 반환하거나 기록하지 않습니다. 명령 전송 뒤 응답을 잃은 경우 `command_outcome_unknown`으로 반환하고 자동 재전송하지 않습니다.

## Cloudflare 설정

필수 비밀값:

- `TESLA_CLIENT_SECRET`: 기존 OAuth 토큰 교환용 Tesla 앱 비밀값
- `TESLA_COMMAND_PRIVATE_KEY`: 공개 호스팅 키와 짝이 맞는 P-256 개인키의 **암호화되지 않은 PKCS#8 PEM** 전체

개인 배포에서는 아래 제한도 권장합니다.

- `TESLA_COMMAND_ALLOWED_VIN`: 이 VIN 이외의 명령 거부
- `TESLA_COMMAND_ALLOWED_SUB`: 이 Tesla 토큰 subject 이외의 명령 거부

기존 `EC PRIVATE KEY`(SEC1)를 PKCS#8로 바꿀 때는 저장소 밖 임시 위치에서 다음 명령을 사용합니다. 결과 파일을 저장소에 복사하거나 커밋하지 마세요.

```powershell
openssl pkcs8 -topk8 -nocrypt -in private-key.pem -out private-key-pkcs8.pem
```

Cloudflare Pages의 `hataepilot` 프로젝트에 `TESLA_COMMAND_PRIVATE_KEY`를 비밀값으로 등록한 뒤 배포합니다. 배포 전에 `.well-known/appspecific/com.tesla.3p.public-key.pem`과 개인키에서 파생한 공개키가 일치하는지 확인해야 합니다. 실제 차량 명령에는 Tesla 로그인에서 `vehicle_cmds` 동의와 `https://tesla.com/_ak/hataepilot.com`을 통한 차량 키 페어링이 필요합니다.

## 로컬 검증

2026-09-09 보안 강화로 OAuth 요청·응답에 JSON 스키마와 크기/시간 제한, no-store 처리를 적용했습니다. 카메라 수집은 원본 페이지와 정규화 결과가 완전해야 게시합니다. 위협 모델, 48개 Node/6개 Python 검사와 운영 한계는 [전체 보안 보고서](docs/SECURITY_REVIEW_2026-09-09.md)를 확인하세요.

외부 패키지 없이 Node.js 내장 테스트만 사용합니다.

```powershell
npm test
node --check functions/_lib/tesla-protocol.js
node --check functions/_lib/tesla-jwt.js
node --check functions/_lib/welcome-lights.js
node --check functions/api/welcome-lights.js
```

테스트는 공개된 Tesla 프로토콜 벡터, 별도로 계산한 HMAC/AES-GCM 벡터, JWT 서명 검증, 차량 소유권, 주차·탑승자·신선도, wake 제한, 명령 결과 불확실성, 정적 배포 제외 규칙을 다룹니다. 테스트 중 Tesla 계정이나 차량에는 연결하지 않습니다.

Cloudflare 로컬 런타임으로 확인하려면 Wrangler를 사용합니다. 실제 비밀값 없이 실행한 웰컴라이트 요청은 의도대로 `server_not_configured`를 반환합니다.

```powershell
node scripts/stage-pages-assets.mjs
npx wrangler pages dev build/pages-assets
```

운영 배포도 저장소 루트가 아니라 `build/pages-assets`만 정적 자산으로 업로드합니다. 이 디렉터리는 스크립트의 고정 허용 목록에 있는 HTML, 헤더, 공개키, 카메라 데이터만 담고, Wrangler는 별도로 `functions/`를 번들링합니다. Wrangler Pages는 `.assetsignore`를 제외 규칙으로 읽지 않으므로 공개 범위는 이 허용 목록으로 제한합니다.

2026-09-09 코드 배포 및 운영 차단/공개범위 검증은 완료했습니다. 차량 명령 키 저장은 사용자 승인 대기 중이며 현재 명령 요청은 503으로 차단됩니다. 실제 점멸은 키 구성·차량 동의/등록 후 별도 검증합니다.
