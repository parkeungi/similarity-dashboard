================================================================================
  유사호출부호 경고 시스템 - 설정 가이드
================================================================================

1. 시스템 요구사항
--------------------------------------------------------------------------------
  - Node.js v18 이상
  - Oracle 11g Database
  - Oracle Instant Client 11.2
  - Windows OS

2. 폴더 구조
--------------------------------------------------------------------------------
  similar_dashboard/
  ├── config/
  │   ├── database.js      # DB 연결 설정
  │   └── settings.json    # 환경설정 (섹터 표시 등)
  ├── routes/
  │   ├── api.js           # 관제사용 API
  │   └── admin.js         # 관리자용 API
  ├── public/
  │   ├── index.html       # 관제사 화면
  │   ├── admin.html       # 관리자 화면
  │   ├── css/style.css    # 스타일
  │   └── js/              # JavaScript 파일
  ├── docs/                # 문서
  ├── node_modules/        # 라이브러리 (npm install 결과)
  ├── server.js            # 서버 메인
  ├── package.json         # 패키지 정보
  └── start.bat            # 서버 시작 배치파일

3. 데이터베이스 설정
--------------------------------------------------------------------------------
  설정 파일: config/database.js

  [Oracle Instant Client 경로]
  oracledb.initOracleClient({ libDir: 'C:\\instantclient_11_2' });

  → 실제 설치 경로로 변경 필요
  → 예: 'D:\\oracle\\instantclient_11_2'

  [DB 접속 정보]
  const dbConfig = {
      user: 'cssown',           // DB 사용자명
      password: 'cssadmin',     // DB 비밀번호
      connectString: 'localhost:1521/XE'  // DB 주소:포트/서비스명
  };

  → 실제 DB 정보로 변경 필요
  → 예: '192.168.1.100:1521/ORCL'

4. 테이블 생성
--------------------------------------------------------------------------------
  setup_db.js 파일을 실행하거나 아래 SQL을 직접 실행:

  -- 유사호출부호 데이터 테이블
  CREATE TABLE T_SIMILAR_CALLSIGN_PAIR (
      IDX NUMBER PRIMARY KEY,
      DETECTED VARCHAR2(30),
      CLEARED VARCHAR2(30),
      CCP VARCHAR2(10),
      FP1_CALLSIGN VARCHAR2(20),
      FP1_DEPT VARCHAR2(10),
      FP1_DEST VARCHAR2(10),
      FP1_EOBT VARCHAR2(10),
      FP1_FID VARCHAR2(20),
      FP1_ALT VARCHAR2(10),
      FP2_CALLSIGN VARCHAR2(20),
      FP2_DEPT VARCHAR2(10),
      FP2_DEST VARCHAR2(10),
      FP2_EOBT VARCHAR2(10),
      FP2_FID VARCHAR2(20),
      FP2_ALT VARCHAR2(10),
      AOD_MATCH NUMBER,
      FID_LEN_MATCH NUMBER,
      MATCH_POS NUMBER,
      MATCH_LEN NUMBER,
      COMP_RAT NUMBER,
      SIMILARITY NUMBER,
      CTRL_PEAK NUMBER,
      SCORE_PEAK NUMBER,
      MARK NUMBER
  );

  -- 오류 보고서 테이블
  CREATE TABLE T_SIMILAR_CALLSIGN_PAIR_REPORT (
      IDX NUMBER NOT NULL,
      REPORTED VARCHAR2(20) NOT NULL,
      REPORTER VARCHAR2(2) NOT NULL,
      AO NUMBER(1) NOT NULL,
      TYPE NUMBER(1) NOT NULL,
      TYPE_DETAIL NUMBER(1) NOT NULL,
      REMARK VARCHAR2(400) DEFAULT '-' NOT NULL,
      PRIMARY KEY (IDX, REPORTED)
  );

5. 환경설정 파일
--------------------------------------------------------------------------------
  설정 파일: config/settings.json

  {
    "displaySectors": [],     // 표시할 섹터 (빈 배열 = 전체)
    "refreshRate": 10000,     // 자동 갱신 주기 (밀리초)
    "maxRows": 100,           // 최대 표시 건수
    "updatedAt": null,        // 마지막 수정 시각
    "updatedBy": null         // 마지막 수정자
  }

  → 관리자 화면에서 설정 가능 (http://localhost:4000/admin)
  → 모든 관제사 화면에 동시 적용됨

6. 서버 시작
--------------------------------------------------------------------------------
  방법 1: 배치파일 실행
    start.bat 더블클릭

  방법 2: 명령어 실행
    cd similar_dashboard
    npm start

  → 서버 시작 후 접속:
    관제사 화면: http://localhost:4000
    관리자 화면: http://localhost:4000/admin

7. 포트 변경
--------------------------------------------------------------------------------
  설정 파일: server.js (6번째 줄)

  const PORT = 4000;  → 원하는 포트 번호로 변경

8. 폐쇄망 배포
--------------------------------------------------------------------------------
  1) 인터넷 환경에서 npm install 실행
  2) 전체 폴더 복사 (node_modules 포함)
  3) 대상 PC에 Node.js, Oracle Instant Client 설치
  4) config/database.js에서 DB 정보 수정
  5) start.bat 실행

9. 문제 해결
--------------------------------------------------------------------------------
  [Oracle 연결 오류]
  - Oracle Instant Client 경로 확인
  - DB 서비스 실행 여부 확인
  - 방화벽 1521 포트 확인

  [포트 사용 중 오류]
  - 기존 node 프로세스 종료 후 재시작
  - 또는 server.js에서 포트 변경

  [화면이 안 보임]
  - 브라우저 캐시 삭제 (Ctrl+F5)
  - 개발자 도구(F12)에서 콘솔 오류 확인

================================================================================
  문의: 관제시스템 담당자
================================================================================
