# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

유사호출부호 경고 시스템 — 항공교통관제(ATC) 유사호출부호 감지 및 오류 보고 시스템.
Node.js + Express 서버, Oracle 11g 데이터베이스, Vanilla JS 프론트엔드. 폐쇄망(air-gapped network) 배포 대상.

## Commands

```bash
npm start          # 서버 시작 (node server.js, 포트 4000)
npm install        # 패키지 설치 (인터넷 환경에서만)
```

테스트/린트 설정 없음. 변경 후 수동 확인 필요.

## Architecture

### Two-Screen Design

두 개의 독립 화면이 같은 Express 서버에서 제공됨:

- **관제사 화면** (`/` → `public/index.html` + `public/js/main.js`): 실시간 유사호출부호 경고. 서버 설정(`config/settings.json`)의 `refreshRate`마다 자동 폴링. 행 클릭으로 오류 보고서 제출.
- **관리자 화면** (`/admin` → `public/admin.html` + `public/js/admin.js`): 보고서 조회/삭제, 통계, Excel 내보내기(SheetJS), 환경설정 관리.

### Data Flow

```
Oracle DB (T_SIMILAR_CALLSIGN_PAIR)
    ↓ polling (GET /api/callsigns)
관제사 화면 (실시간 테이블)
    ↓ 오류 보고 (POST /api/reports)
Oracle DB (T_SIMILAR_CALLSIGN_PAIR_REPORT)
    ↓ 조회 (GET /api/admin/reports)
관리자 화면 (보고서 목록 + 통계)
```

### Server Config Propagation

`config/settings.json` 파일이 관제사 화면의 동작을 제어함:
- `displaySectors`: 표시할 섹터 목록 (빈 배열 = 전체)
- `refreshRate`: 폴링 주기 (ms, 기본 10000)
- `maxRows`: 최대 표시 건수 (기본 100)

관리자가 `/api/config` POST로 저장하면, 관제사 화면이 다음 폴링 때 `/api/config` GET으로 자동 반영.

### DB Connection Pattern

`config/database.js`에서 oracledb 연결 풀 관리. 모든 라우트 핸들러는 동일 패턴:
```javascript
let conn;
try {
    conn = await db.getConnection();
    // ... execute SQL
} catch (err) {
    // error handling
} finally {
    if (conn) await conn.close();  // 반드시 반환
}
```

Oracle 11g Thick mode 사용 (Instant Client: `C:\instantclient_11_2`).

## Database

- **접속**: `cssown/cssadmin@localhost:1521/XE` (`config/database.js`)
- **T_SIMILAR_CALLSIGN_PAIR**: 유사호출부호 쌍 데이터. 활성 데이터는 `CLEARED = '9999-12-31 23:59:59'`로 식별.
- **T_SIMILAR_CALLSIGN_PAIR_REPORT**: 오류 보고서. 복합키 `(IDX, REPORTED)`.
- **A_REALTIME_LOGIN**: 현재 로그인 사용자 조회 (보고자 선택용, 외부 테이블).

## API Endpoints

### 관제사용 (`routes/api.js` → `/api`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/config | 서버 설정 조회 |
| POST | /api/config | 서버 설정 저장 |
| GET | /api/callsigns | 유사호출부호 목록 (`?sector=`, `?sectors=` 지원) |
| GET | /api/sectors | 활성 섹터 목록 + 건수 |
| GET | /api/reporters | 현재 로그인 사용자 목록 |
| POST | /api/reports | 오류 보고서 저장 |

### 관리자용 (`routes/admin.js` → `/api/admin`)
| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | /api/admin/reports | 보고서 조회 (`?from=&to=&sector=&type=` 필터) |
| GET | /api/admin/stats | 통계 (유형별, 세부유형별, 섹터별, 일별) |
| DELETE | /api/admin/reports/:idx/:reported | 보고서 삭제 |
| GET | /api/admin/callsign-stats | 호출부호 데이터 전체 건수 |

## Key Business Logic

### Risk Assessment (3-tier)

| Metric | 매우높음 (danger) | 높음 (warning) | 보통/낮음 (info) |
|--------|-------------------|----------------|-------------------|
| 유사도 (SIMILARITY) | > 2 | > 1 | ≤ 1 |
| 오류가능성 (SCORE_PEAK) | ≥ 40 | ≥ 20 | < 20 |
| 권고사항 | 즉시조치 (either trigger) | 주의관찰 | 정상감시 |

### Report Field Codes

| Field | Values |
|-------|--------|
| AO (오류항공기) | 1=FP1, 2=FP2, 3=양쪽 모두 |
| TYPE (오류유형) | 1=관제사오류, 2=조종사오류, 3=복창오류, 4=무응답/재호출, 5=기타 |
| TYPE_DETAIL (안전영향도) | 1=경미, 2=보통, 3=심각 |

## Frontend JavaScript Structure

공통 코드는 `public/js/common.js`에 분리됨 (HTML에서 먼저 로드):
- `SECTOR_MAP`, `FIXED_SECTORS` - 섹터 관련 상수
- `getSectorName()`, `escapeHtml()` - 유틸리티 함수
- `updateClock()`, `updateNetworkStatus()` - UI 상태 함수

섹터 추가/변경 시 **common.js만 수정**하면 양쪽 화면에 자동 반영.

`AIRLINE_MAP` (호출부호 접두어 → 항공사명)은 `public/js/main.js`에만 존재.

## Design System

Dark theme with glassmorphism:
- Background: `#0b1120`
- Cards: `rgba(30, 41, 59, 0.7)` + `backdrop-filter: blur()`
- Accent colors: Sky blue `#0ea5e9`, Green `#10b981`, Red `#ef4444`, Amber `#f59e0b`
- CSS variables: `--accent-primary`, `--accent-secondary`, `--accent-danger`, `--accent-warning`, `--text-muted`

## Deployment (폐쇄망)

1. 인터넷 환경에서 `npm install` → `node_modules` 포함 전체 복사
2. Oracle Instant Client 11.2가 `C:\instantclient_11_2`에 필요
3. `start.bat` 실행 (Node.js, node_modules 존재 여부 자동 확인)
4. 선택: `public/fonts/`에 Orbitron, Pretendard 폰트 추가

## Rate Limiting

`server.js`에서 인메모리 Rate Limiting 구현:
- `/api/*`: 분당 100회
- `/api/admin/*`: 분당 60회 (더 엄격)

## Notes

- 인증/인가 없음 — 폐쇄망 단일 서버 전제
- CORS 미설정 — 같은 서버에서 static + API 제공
- Excel 내보내기는 SheetJS 로컬 번들 (`public/js/xlsx.full.min.js`) 사용
- 보안 헤더 (CSP, X-Frame-Options 등)는 `server.js` 미들웨어에서 설정
