# .claude — 이 저장소의 Claude Code 설정

## 서브에이전트 (`.claude/agents/`)

작업 성격에 따라 Claude 가 알아서 골라 쓰고, `> vlbi-domain 으로 ...` 처럼 이름을 직접 불러도 된다.

| 에이전트 | 담당 | 언제 쓰나 |
|---|---|---|
| `vlbi-domain` | 관측 도메인·좌표·시각 계산 | RA/Dec→Az/El, MJD/UTC/LST, 스캔 스케줄, 구동 한계 |
| `miniapp-ui` | `index.html` | 탭·카드·7종 테마, Telegram WebApp 연동, 한국어 문구 |
| `cesium-globe` | `globe.html` | 지구본 엔티티·카메라·패널·성능 |
| `antenna-3d` | `antenna3d.html` | Three.js r128 안테나 지오메트리·슬루·HUD |
| `data-contract` | Gist JSON ↔ `/api/globe/*` | 스키마 불일치, fetch shim, 폴링·캐시, 오류 상태 |

`vlbi-domain` 과 `data-contract` 는 파일을 고치지 않는 **조사 전용**이다(읽기 도구만 가짐).
나머지 셋은 담당 파일을 직접 편집한다.

## 이 프로젝트의 불변 규칙

에이전트 각각의 파일에 자세히 적혀 있지만, 가장 자주 깨지는 것만 추리면:

1. **빌드 도구가 없다.** npm, 번들러, ES 모듈 import, TypeScript 를 도입하지 않는다.
   단일 HTML 파일 안의 평범한 `<script>` 와 전역 네임스페이스(`Cesium`, `THREE`)만 쓴다.
2. **`cesium/` 는 23MB 벤더 번들이다.** 수정하지 않고, grep 할 때도 제외한다.
3. **Three.js 는 r128 로 고정**이다. 최신 API 는 동작하지 않는다.
4. **색은 CSS 변수로.** `index.html` 에서 색을 하드코딩하면 7개 테마 중 일부가 깨진다.
5. **GitHub API 로 Gist 를 읽지 않는다.** 시간당 60회 제한 때문에 raw 경로를 쓴다.
6. **`scans` 는 위치 기반 배열**이다. 필드는 끝에만 추가하고, 읽는 쪽 세 군데를 함께 고친다.
7. **UI 문구는 한국어**이며 기존 말투를 따른다.

## 확인 방법

번들러가 없으므로 정적 서버로 바로 띄워 본다.

```sh
python3 -m http.server 8000
# http://localhost:8000/index.html?g=<gist-id>
# http://localhost:8000/globe.html?code=r11269
# http://localhost:8000/antenna3d.html
```

브라우저 콘솔에 오류가 없는지, 그리고 `index.html` 은 최소 `dark`/`paper`/`ops` 세 테마와
360px 폭에서 확인한다.
