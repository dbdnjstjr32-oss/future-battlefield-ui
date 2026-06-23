# 🛡️ 미래형 전장 UI — 시스템 아키텍처

> **Tactical HUD Command Interface**  
> 실시간 항공·해상·위성 정보를 통합 시각화하는 군사 전술 대시보드

---

## 1. 전체 구조 개요

```
┌─────────────────────────────────────────────────────────────────────┐
│                        브라우저 (Client)                             │
│                                                                     │
│  ┌──────────┐  ┌──────────────────────────────────────────────────┐ │
│  │index.html│  │              app.js (Main Engine)                │ │
│  │ (DOM /   │  │  ┌──────────┐ ┌───────────┐ ┌────────────────┐  │ │
│  │  UI 구조) │  │  │MapLibre  │ │ Canvas2D  │ │ State Machine  │  │ │
│  └──────────┘  │  │GL Map    │ │ Overlay   │ │ & Render Loop  │  │ │
│  ┌──────────┐  │  └──────────┘ └───────────┘ └────────────────┘  │ │
│  │styles.css│  └──────────────────────────────────────────────────┘ │
│  │ (HUD 스타) │                                                      │
│  └──────────┘                                                       │
└──────────────────────┬──────────────────────────────────────────────┘
                       │ HTTP  (localhost:8080)
                       ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    server.js (Node.js Proxy Server)                 │
│                                                                     │
│  /api/flights       → Flightradar24 (실시간 항공편)                  │
│  /api/satellites    → CelesTrak SGP4 TLE (위성궤적)                 │
│  /api/vessels       → MarineTraffic / vessels.json (선박)           │
│  /api/aircraft-photo→ Planespotters.net (항공기 사진)               │
│  /api/geocode       → Nominatim OSM (주소 → 좌표)                   │
│  /api/track         → Tracker.delivery (택배 추적)                  │
│  /*                 → Static file server (index/css/js)            │
└─────────────────────────────────────────────────────────────────────┘
```

---

## 2. 파일 구조

```
미래형 전장 ui/
├── index.html        # DOM 구조, HUD 레이아웃, 패널 정의
├── app.js            # 클라이언트 전체 로직 (~2,860줄)
├── styles.css        # 전술 HUD 스타일 시스템 (~730줄)
├── server.js         # Node.js HTTP 프록시 서버 (~323줄)
└── vessels.json      # MarineTraffic 선박 캐시 데이터 (~1,531척)
```

---

## 3. 서버 레이어 (server.js)

| 엔드포인트 | 방향 | 외부 API | 캐싱 |
|-----------|------|----------|------|
| `GET /api/flights` | 프록시 | Flightradar24 (FR24) | 없음 (매요청) |
| `GET /api/satellites` | 프록시 + 캐시 | CelesTrak NORAD GP | 1시간 메모리 캐시 |
| `GET /api/vessels` | 로컬 반환 | `vessels.json` 파일 | 파일 영속화 |
| `POST /api/vessels` | 수신 저장 | MarineTraffic 스크레이퍼 | `vessels.json` 쓰기 |
| `GET /api/aircraft-photo` | 프록시 | Planespotters.net API | 없음 |
| `GET /api/geocode` | 프록시 | Nominatim OSM API | 없음 |
| `GET /api/track` | 프록시 | tracker.delivery API | 없음 |
| `GET /*` | 정적 파일 | 로컬 디렉토리 | `no-store` |

### 추적 위성 목록 (NORAD Catalog ID)
```
ISS(25544), NOAA-19(33591), Aqua(27424), Terra(25994),
Landsat-8(39084), Landsat-9(49260), Sentinel-1A(39634),
Sentinel-2A(40697), KOMPSAT-3(39237), KOMPSAT-5(40786)
```

---

## 4. 클라이언트 엔진 (app.js)

### 4.1 전역 상태 (State Machine)

```javascript
state = {
  yaw, pitch, zoom,          // 카메라 자세
  isAutoRot,                  // 자동 회전 활성
  isNoiseWave,                // 지각 파동 시뮬레이션
  showAircraft,               // 항공기 레이어 표시
  showVessels,                // 선박 레이어 표시
  showDataCenters,            // 데이터센터 망 표시
  showSatTracks,              // 위성 궤적 표시
  isFollowing                 // 선택 표적 자동 팔로우
}

userInteracting = false       // 사용자 조작 중 플래그
userInteractResumeTimer = ... // 자동 재개 2초 타이머
```

### 4.2 렌더 파이프라인

```
requestAnimationFrame
        │
        ▼
   render(time)
        │
        ├─► updateFPS()
        │
        ├─► [isAutoRot && !userInteracting]
        │       └─► map.setBearing()          // 자동 회전
        │
        ├─► ctx.clearRect()                   // Canvas 초기화
        │
        ├─► drones.forEach → 위치 업데이트    // 물리 시뮬레이션
        │       └─► (velocity m/s → 위도/경도 변환)
        │
        ├─► vessels.forEach → 위치 업데이트
        │
        ├─► [isFollowing && !userInteracting]
        │       └─► map.setCenter()           // 표적 팔로우
        │
        ├─► drawTerrain()                     // 지형 와이어프레임
        ├─► drawDataCenters()                 // 데이터센터망
        ├─► drawSatelliteTracks()             // 위성 궤적
        ├─► drawBases()                       // 전술 기지 마커
        ├─► drawDrones()                      // 항공기 마커
        ├─► drawVessels()                     // 선박 마커
        ├─► drawTargetDetails()               // 선택 표적 정보선
        └─► updateTacticalPanel()             // 우측 HUD 패널 갱신
```

### 4.3 데이터 흐름

```
Flightradar24 API
        │ fetchFlightData() (30초 주기)
        ▼
  drones[] 배열
        │ 실시간 위치 보간
        ▼
  Canvas2D drawDrones()
        │ 클릭 이벤트 감지
        ▼
  selectedDrone 선택
        │
        ├─► updateSidePanel()
        ├─► fetchAircraftPhoto(registration)  → Planespotters API
        └─► fetchAirlineLogo(icao)            → airlineLogo CDN
```

```
CelesTrak TLE
        │ fetchSatelliteTLEs() (30초 주기)
        ▼
  satObjects[] (satellite.js SGP4 전파)
        │ 현재 시각 → 위도/경도/고도 계산
        ▼
  Canvas2D drawSatelliteTracks()
```

```
vessels.json (캐시)
        │ fetchVessels() (초기 로드)
        ▼
  vessels[] 배열
        │ AIS 속도/방향으로 위치 보간
        ▼
  Canvas2D drawVessels()
```

---

## 5. UI 레이어 구조 (index.html / styles.css)

```
<body>
 ├── #map                         // MapLibre GL 위성지도 (배경)
 ├── #terrain-canvas              // Canvas2D HUD 오버레이 (전경)
 ├── .scanlines                   // CRT 스캔라인 오버레이
 ├── .hud-overlay
 │    ├── .control-panel (aside)  // 좌측 컨트롤 패널
 │    │    ├── MAP CONTROLS       // 줌, 필터, 회전속도
 │    │    ├── SIMULATION MODULE  // 레이어 토글
 │    │    ├── CARGO TRACKING     // 택배 추적
 │    │    ├── GEO-PLOTTER        // 좌표 표적 지정
 │    │    └── TELEMETRY          // FPS, 자세 정보
 │    └── #panel-toggle           // 패널 접기/펼치기 버튼
 ├── #target-popup                // 표적 클릭 시 팝업 모달
 └── #tactical-right-panel        // 우측 슬라이딩 전술 패널
      ├── card-tracking            // 추적 좌표 카드
      │    ├── 텔레메트리 그리드
      │    ├── 항공기 실제 사진    // Planespotters.net
      │    └── HUD 그리드 박스
      └── card-spec                // 제원/상태 카드
           ├── 항공사 로고         // Airhex CDN
           ├── 회전 링 그래픽
           └── 호출부호/출발지
```

---

## 6. 지도 필터 시스템

| 필터명 | CSS filter 값 | data-theme | 기본값 |
|--------|--------------|-----------|--------|
| 흑백 (Gray) | `grayscale(100%) brightness(0.75) contrast(1.1)` | `gray` | ✅ |
| 연청록 (Cyan) | `grayscale(100%) sepia(100%) hue-rotate(150deg) saturate(180%) brightness(0.7)` | `cyan` | |
| 초록 (Green) | `grayscale(100%) sepia(100%) hue-rotate(85deg) saturate(300%) brightness(0.75)` | `green` | |
| 실제지도 (Real) | `none` | `real` | |

> **이미지/로고 보호**: `.tac-photo-card`, `.tac-airline-container`에  
> `filter: none !important` 적용 → 색상 필터와 무관하게 항상 풀컬러 표시

---

## 7. 사용자 상호작용 우선순위 시스템

```
사용자 터치/드래그/줌/회전 발생
          │
          ▼
  onUserInteractStart()
          │
          ├─► userInteracting = true
          ├─► state.isFollowing = false
          └─► 기존 재개 타이머 취소
                    │
          조작 종료 (end 이벤트)
                    │
                    ▼
         onUserInteractEnd()
                    │
            2초 타이머 예약
                    │
            2초 후 자동 재개
                    │
                    ▼
         userInteracting = false
         [selectedDrone 존재 시]
         state.isFollowing = true
```

**캡처 이벤트 목록:**
- MapLibre: `dragstart/end`, `zoomstart/end`, `pitchstart/end`, `rotatestart/end`
- Native Canvas: `touchstart/end`, `mousedown/up`

---

## 8. 전술 기지 (militaryBases)

| 이름 | 좌표 | 타입 |
|------|------|------|
| **CHEONGJU UNIV HQ** | 127.4957°E, 36.6506°N | ⭐ HQ (청주대학교) |
| SEOUL HQ | 127.05°E, 37.45°N | 일반 기지 |
| GYERYONGDAE | 127.24°E, 36.29°N | 일반 기지 |
| BUSAN NAVAL BASE | 129.09°E, 35.10°N | 일반 기지 |
| JEJU AIRFIELD | 126.46°E, 33.24°N | 일반 기지 |

**HQ 마커**: 별★ + 이중 링, 색상은 현재 지도 필터 테마에 연동

---

## 9. 외부 의존성

| 라이브러리 | 버전 | 용도 |
|-----------|------|------|
| MapLibre GL JS | 4.3.0 | WebGL 위성 지도 렌더링 |
| satellite.js | 4.1.4 | SGP4/SDP4 궤도 역학 계산 |
| Orbitron (Google Fonts) | — | HUD 헤드라인 폰트 |
| Share Tech Mono (Google Fonts) | — | 텔레메트리 모노스페이스 폰트 |
| ESRI ArcGIS Satellite Tiles | — | 위성 지도 타일 |
| OpenStreetMap OSRM | — | 택배 도로 경로 계산 |
| Nominatim | — | 주소 → 좌표 지오코딩 |
| Planespotters.net API | — | 항공기 실제 사진 |
| Airhex CDN | — | 항공사 로고 이미지 |
| tracker.delivery API | — | 한국 택배 추적 |

---

## 10. 성능 최적화

| 기법 | 적용 위치 | 효과 |
|------|----------|------|
| LOD (Level of Detail) | `isAircraftVisibleAtZoom()` | 줌 레벨별 마커 표시 제한 |
| 위성 TLE 1시간 캐시 | `server.js` | CelesTrak API 부하 감소 |
| vessels.json 파일 캐시 | `server.js` | MarineTraffic 의존 제거 |
| 경로 Trail 최대 20포인트 | `d.path.shift()` | 메모리 누수 방지 |
| userInteracting 플래그 | 렌더 루프 | 사용자 조작 중 자동 처리 차단 |
| `requestAnimationFrame` | 렌더 루프 | 브라우저 VSYNC 동기화 |
| `no-store` 캐시 헤더 | `server.js` | 정적 파일 항상 최신 유지 |

---

*문서 생성: 2026-06-09 | 시스템 버전: Tactical HUD v2.0*
