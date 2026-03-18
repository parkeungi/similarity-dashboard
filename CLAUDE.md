# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Source File Map

각 파일의 역할 요약. 코드 수정 전 반드시 해당 파일을 읽고 구조를 파악할 것.

```
similar_dashboard/
├── server.js                  # Express 서버 진입점 (포트 4000, 보안헤더, Rate Limiting)
├── start.bat                  # Windows 실행 스크립트 (자동 재시작 루프)
├── package.json               # 프로젝트 메타 및 의존성
│
├── config/
│   ├── database.js            # Oracle 11g 연결 풀 관리 (Thick mode)
│   ├── settings.json          # 런타임 설정 (섹터, 폴링주기, 임계값)
│   ├── settingsCache.js       # settings.json 메모리 캐시 (파일 I/O 최소화)
│   └── timeUtil.js            # UTC↔KST 변환, 시즌별 조회범위 계산
│
├── routes/
│   ├── api.js                 # 관제사용 API (/api/*) — 호출부호 조회, 보고서 제출, 예측
│   ├── admin.js               # 관리자용 API (/api/admin/*) — 보고서 관리, 통계
│   └── history.js             # 이력 조회 API (/api/history/*)
│
├── public/
│   ├── index.html             # 관제사 화면 (메인)
│   ├── admin.html             # 관리자 화면
│   ├── history.html           # 검출 이력 화면
│   ├── setup.html             # 초기 설정 화면
│   ├── mockup.html            # 사용자 매뉴얼 목업
│   ├── css/style.css          # 전체 스타일 (Dark glassmorphism 테마)
│   ├── js/common.js           # 공통 상수·유틸 (SECTOR_MAP, getSectorName 등)
│   ├── js/main.js             # 관제사 화면 로직 (폴링, 렌더링, 예측, 보고)
│   ├── js/admin.js            # 관리자 화면 로직 (보고서, 통계, Excel 내보내기)
│   ├── js/history.js          # 이력 화면 로직
│   └── js/xlsx.full.min.js    # SheetJS 로컬 번들 (Excel 내보내기)
│
└── database/
    └── 03_indexes.sql         # 성능 최적화 인덱스 DDL
```

## Commands

```bash
npm start          # 서버 시작 (node server.js, 포트 4000)
npm install        # 패키지 설치 (인터넷 환경에서만)
```

테스트/린트 설정 없음. 변경 후 `http://localhost:4000`에서 수동 확인.

---

## Coding Guidelines

### 1. DB 연결 패턴 (필수)

모든 라우트 핸들러는 반드시 이 패턴을 따를 것:
```javascript
let conn;
try {
    conn = await db.getConnection();
    // SQL 실행
} catch (err) {
    // 에러 처리
} finally {
    if (conn) await conn.close();  // 반드시 반환!
}
```
- Oracle 11g Thick mode (`C:\instantclient_11_2`)
- 접속: `cssown/cssadmin@localhost:1521/XE`
- `executeWithTimeout()` 사용 권장 (쿼리 타임아웃)

### 2. Oracle 11g 제약사항

- `FETCH FIRST N ROWS ONLY` 사용 불가 → `WHERE ROWNUM <= N` 또는 서브쿼리 래핑
- `LISTAGG ... WITHIN GROUP` 4000바이트 제한 주의
- `WITH` (CTE) 사용 가능하나 재귀 CTE 불가
- 날짜는 문자열 저장: `'YYYY-MM-DD HH24:MI:SS'` 형식, `TO_DATE()` 변환 필수

### 3. 시간대 처리

- DB 저장: UTC 문자열
- 화면 표시: KST (UTC+9)
- 변환: `config/timeUtil.js`의 `utcToKst()`, `kstToUtc()` 사용
- 프론트엔드에서 직접 시간 변환하지 말 것 — 서버에서 변환 후 전달

### 4. 프론트엔드 수정 규칙

- **섹터 추가/변경**: `public/js/common.js`의 `SECTOR_MAP`, `FIXED_SECTORS`만 수정
- **항공사 추가**: `public/js/main.js`의 `AIRLINE_MAP`만 수정
- **공통 유틸**: `common.js`에 추가 (양쪽 화면에서 자동 반영)
- HTML에서 JS 로드 순서: `common.js` → 화면별 JS (의존성 주의)

### 5. 설정 변경 흐름

```
관리자 POST /api/config → settings.json 저장 + settingsCache 갱신
    → 관제사 화면 다음 폴링 시 GET /api/config로 자동 반영
```
- `config/settingsCache.js`를 통해 메모리 캐시 사용
- settings.json 직접 수정하지 말 것 — API를 통해 변경

### 6. 보안 고려사항

- 인증/인가 없음 (폐쇄망 단일 서버 전제)
- SQL 바인드 변수 필수 (문자열 연결 금지)
- `escapeHtml()` 사용하여 XSS 방지
- Rate Limiting: `/api/*` 분당 100회, `/api/admin/*` 분당 60회
- 보안 헤더 (CSP, X-Frame-Options)는 `server.js` 미들웨어에서 설정

### 7. CSS 디자인 시스템

Dark glassmorphism 테마 — 새 UI 요소 추가 시 기존 변수 사용:
```css
--accent-primary: #0ea5e9    /* Sky blue (기본 강조) */
--accent-secondary: #10b981  /* Green (성공/정상) */
--accent-danger: #ef4444     /* Red (위험/에러) */
--accent-warning: #f59e0b    /* Amber (경고) */
--text-muted                 /* 보조 텍스트 */
```
- 배경: `#0b1120`, 카드: `rgba(30, 41, 59, 0.7)` + `backdrop-filter: blur()`

### 8. 새 API 엔드포인트 추가 시

1. `routes/api.js` 또는 `routes/admin.js`에 라우트 추가
2. DB 연결 패턴 준수 (위 #1 참고)
3. 바인드 변수 사용, `safeErrorMessage(err)` 로 에러 응답
4. 응답 형식: `{ success: true/false, data: [...], error: "..." }`

### 9. 폐쇄망 배포 주의

- `npm install`은 인터넷 환경에서만 가능 → `node_modules` 포함 전체 복사
- 외부 CDN/URL 참조 금지 — 모든 라이브러리는 로컬 번들
- 폰트: `public/fonts/`에 Orbitron, Pretendard 포함

---

## Key Reference

### DB 테이블

| 테이블 | 용도 | 핵심 |
|--------|------|------|
| T_SIMILAR_CALLSIGN_PAIR | 유사호출부호 쌍 | 활성: `CLEARED = '9999-12-31 23:59:59'` |
| T_SIMILAR_CALLSIGN_PAIR_REPORT | 오류 보고서 | 복합키: `(IDX, REPORTED)` |
| A_REALTIME_LOGIN | 로그인 사용자 | 외부 테이블, 보고자 선택용 |

### 위험도 판정 (3단계)

| 등급 | 유사도 (SIMILARITY) | 오류가능성 (SCORE_PEAK) | 권고사항 |
|------|---------------------|------------------------|----------|
| 매우높음 (danger) | > 2 | ≥ 40 | 즉시조치 |
| 높음 (warning) | > 1 | ≥ 20 | 주의관찰 |
| 보통 (info) | ≤ 1 | < 20 | 정상감시 |

### 보고서 필드 코드

| 필드 | 값 |
|------|-----|
| AO (오류항공기) | 1=FP1, 2=FP2, 3=양쪽 |
| TYPE (오류유형) | 1=관제사, 2=조종사, 3=복창, 4=무응답, 5=기타 |
| TYPE_DETAIL (안전영향도) | 1=경미, 2=보통, 3=심각 |

### 화면별 URL

| 화면 | URL | 설명 |
|------|-----|------|
| 관제사 | `/` | 실시간 유사호출부호 경고 + 보고 |
| 관리자 | `/admin` | 보고서 조회, 통계, 설정 |
| 이력 | `/history` | 검출 이력 조회 |
