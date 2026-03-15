# 유사호출부호 경고 시스템

항공교통관제 유사호출부호 경고 및 오류 보고 시스템

## 시스템 요구사항

- Node.js 16.x 이상
- Oracle 11g Database
- Oracle Instant Client 11.2 (경로: `C:\instantclient_11_2`)

## 설치 방법

### 1. 프로젝트 복사
폐쇄망 환경에 `similar_dashboard` 폴더 전체를 복사합니다.

### 2. Node.js 패키지 설치
인터넷 환경에서 미리 `npm install`을 실행하여 `node_modules` 폴더를 생성한 후,
해당 폴더를 함께 복사합니다.

또는 폐쇄망에서:
```batch
npm install --offline
```

### 3. 폰트 설치 (선택사항)
폰트 파일이 없어도 시스템 기본 폰트로 동작합니다.
더 나은 UI를 위해 아래 폰트를 설치할 수 있습니다:

**Orbitron 폰트:**
- 다운로드: https://fonts.google.com/specimen/Orbitron
- 설치 위치: `public/fonts/Orbitron/`
  - Orbitron-Regular.woff2 (또는 .ttf)
  - Orbitron-Bold.woff2 (또는 .ttf)

**Pretendard 폰트:**
- 다운로드: https://github.com/orioncactus/pretendard/releases
- 설치 위치: `public/fonts/Pretendard/`
  - Pretendard-Regular.woff2 (또는 .otf)
  - Pretendard-SemiBold.woff2 (또는 .otf)
  - Pretendard-Bold.woff2 (또는 .otf)

## 데이터베이스 설정

### 접속 정보 수정
`config/database.js` 파일에서 접속 정보를 수정합니다:

```javascript
const dbConfig = {
    user: 'cssown',
    password: 'cssadmin',
    connectString: 'localhost:1521/XE'  // 호스트:포트/서비스명
};
```

### 필요한 테이블

**T_SIMILAR_CALLSIGN_PAIR** - 유사호출부호 데이터 (기존 테이블)

**T_SIMILAR_CALLSIGN_PAIR_PAIR_REPORT** - 오류 보고서 테이블
```sql
CREATE TABLE T_SIMILAR_CALLSIGN_PAIR_PAIR_REPORT (
    IDX NUMBER NOT NULL,
    REPORTED VARCHAR2(20) NOT NULL,
    REPORTER VARCHAR2(2) NOT NULL,
    AO NUMBER(1) NOT NULL,
    TYPE NUMBER(1) NOT NULL,
    TYPE_DETAIL NUMBER(1) NOT NULL,
    REMARK VARCHAR2(400) DEFAULT '-' NOT NULL
);
```

## 실행 방법

### Windows
```batch
start.bat
```
또는
```batch
npm start
```

### 접속 URL
- 관제사 화면: http://localhost:3000
- 관리자 화면: http://localhost:3000/admin

## 화면 설명

### 관제사 화면 (LIVE DETECTION)
- 실시간 유사호출부호 쌍 모니터링 (10초 자동 갱신)
- 섹터별 필터링
- 위험도 표시 (CRITICAL / CAUTION / MONITOR)
- 행 클릭 시 오류 보고 입력

### 관리자 화면 (ADMIN)
- 오류 보고서 취합 및 조회
- 기간별/유형별/섹터별 필터링
- 통계 현황 (전체/조종사오류/관제사오류/당일)
- Excel 내보내기

## 오류 보고 항목

| 항목 | 값 | 설명 |
|------|-----|------|
| AO | 1 | FP1 (첫번째 항공기) |
| | 2 | FP2 (두번째 항공기) |
| | 3 | Both (양쪽 모두) |
| TYPE | 1 | 조종사오류 |
| | 2 | 관제사오류 |
| TYPE_DETAIL | 1 | 복창청취 오류 |
| | 2 | 복창부정확 |
| | 3 | 미창오류 |
| | 4 | 지시불청/미호출 |
| | 5 | 기타 |

## 포트 변경

`server.js`에서 포트 번호를 수정합니다:
```javascript
const PORT = 3000;  // 원하는 포트로 변경
```

## 문제 해결

### Oracle 연결 오류
1. Oracle Instant Client 경로 확인: `C:\instantclient_11_2`
2. 환경변수 PATH에 Instant Client 경로 추가
3. `config/database.js`의 접속 정보 확인

### 폰트가 표시되지 않음
- 시스템 기본 폰트(Arial, sans-serif)로 대체 표시됩니다
- 폰트 파일을 `public/fonts/` 디렉토리에 복사하면 적용됩니다

### 화면이 로딩 중에서 멈춤
- 브라우저 개발자 도구(F12) > Console에서 오류 확인
- 서버 콘솔에서 Oracle 연결 오류 확인
