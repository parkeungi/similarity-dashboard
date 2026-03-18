/**
 * ==================== 공통 코드 ====================
 * 관제사 화면(main.js)과 관리자 화면(admin.js)에서 공유하는 코드
 * 수정 시 양쪽 화면 모두에 영향을 주므로 주의 필요
 */

// ==================== 섹터 관련 상수 및 함수 ====================

/**
 * 섹터 코드 → 섹터 이름 매핑
 * @description Oracle DB의 CCP 컬럼 값을 사람이 읽을 수 있는 섹터명으로 변환
 * @type {Object<string, string>}
 */
let SECTOR_MAP = {
    '1': 'WH', '2': 'GH', '3': 'GL', '4': 'WL', '5': 'ES',
    '7': 'PH', '8': 'EL', '9': 'KH', '10': 'KL',
    '11': 'JN', '12': 'JH', '13': 'JL', '14': 'DG', '15': 'AF',
    '17': 'WS1', '18': 'WS2', '19': 'WS3', '20': 'WS4', '21': 'WS5',
    '22': 'SUP', '252': 'FIS', '253': 'Spare'
};

/**
 * 고정 표시 섹터 목록 (항상 왼쪽 목록에 표시되는 섹터들)
 * @description 데이터가 0건이어도 UI에 항상 표시할 섹터 목록 (순서 유지)
 * @type {string[]}
 */
let FIXED_SECTORS = ['3', '2', '10', '9', '11', '13', '12']; // GL, GH, KL, KH, JN, JL, JH

/**
 * 인천섹터 코드 목록 (기본 체크 대상, 서버 설정과 무관하게 고정)
 * @type {string[]}
 */
const INCHEON_SECTORS = ['3', '2', '10', '9', '11', '13', '12']; // GL, GH, KL, KH, JN, JL, JH

/**
 * 섹터 이름 → 섹터 코드 역방향 매핑 (ATFM 연동용)
 * @type {Object<string, string>}
 */
let SECTOR_NAME_TO_CODE = {};
Object.keys(SECTOR_MAP).forEach(code => { SECTOR_NAME_TO_CODE[SECTOR_MAP[code]] = code; });

/**
 * 서버 설정에서 불러온 섹터 맵핑으로 전역 변수를 업데이트
 * @param {Object<string,string>} newMap  - { '코드': '이름' } 형태
 * @param {string[]}             newFixed - 고정 표시 섹터 코드 목록
 */
function updateSectorConfig(newMap, newFixed) {
    if (newMap && Object.keys(newMap).length > 0) {
        SECTOR_MAP = newMap;
        // 역방향 매핑 재구성
        Object.keys(SECTOR_NAME_TO_CODE).forEach(k => delete SECTOR_NAME_TO_CODE[k]);
        Object.keys(SECTOR_MAP).forEach(code => { SECTOR_NAME_TO_CODE[SECTOR_MAP[code]] = code; });
    }
    if (newFixed && newFixed.length > 0) {
        FIXED_SECTORS = newFixed;
    }
}

// ==================== 위험도 기준값(환경설정) ====================

// ==================== 항공사 매핑 ====================

/**
 * 호출부호 접두어 → 항공사명 매핑
 * @type {Object<string, string>}
 */
const AIRLINE_MAP = {
    'KAL': '대한항공', 'AAR': '아시아나', 'JJA': '제주항공', 'TWB': '티웨이',
    'JNA': '진에어', 'ABL': '에어부산', 'ASV': '에어서울', 'EOK': '에어로케이',
    'FGW': '플라이강원', 'HGG': '하이에어', 'ESR': '이스타',
    'CSN': '중국남방', 'CCA': '중국국제', 'CES': '중국동방', 'CDG': '산동항공',
    'CHH': '해남항공', 'CSZ': '심천항공', 'CXA': '하문항공', 'CSC': '사천항공',
    'JAL': '일본항공', 'ANA': '전일본공수', 'APJ': '피치항공', 'JJP': '제트스타JP',
    'SIA': '싱가포르항공', 'THA': '타이항공', 'VJC': '비엣젯', 'HVN': '베트남항공',
    'CPA': '캐세이퍼시픽', 'EVA': '에바항공', 'CAL': '중화항공', 'MAS': '말레이시아',
    'UAL': '유나이티드', 'DAL': '델타항공', 'AAL': '아메리칸', 'FDX': '페덱스',
    'UPS': 'UPS', 'GTI': '아틀라스', 'PAC': '폴라에어', 'HYT': '중국화유'
};

/**
 * 호출부호에서 항공사명 추출
 * @param {string} callsign - 항공기 호출부호
 * @returns {string} 항공사명 또는 접두어
 */
function getAirlineName(callsign) {
    if (!callsign) return '-';
    const prefix = callsign.replace(/[0-9]/g, '');
    return AIRLINE_MAP[prefix] || prefix;
}

// ==================== 위험도 기준값 ====================

/**
 * 기본 위험도 기준값
 * @type {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }}
 */
const DEFAULT_RISK_THRESHOLDS = {
    similarity: { critical: 2, caution: 1 },
    scorePeak: { critical: 40, caution: 20 }
};

/**
 * 현재 적용 중인 위험도 기준값
 * @type {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }}
 */
let RISK_THRESHOLDS = JSON.parse(JSON.stringify(DEFAULT_RISK_THRESHOLDS));

/**
 * 위험도 기준값 정규화
 * @param {Object} thresholds - 서버에서 내려온 기준값 객체
 * @returns {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }}
 */
function normalizeRiskThresholds(thresholds) {
    const simCriticalRaw = Number(thresholds?.similarity?.critical);
    const simCautionRaw = Number(thresholds?.similarity?.caution);
    const scoreCriticalRaw = Number(thresholds?.scorePeak?.critical);
    const scoreCautionRaw = Number(thresholds?.scorePeak?.caution);

    const normalized = {
        similarity: {
            critical: Number.isFinite(simCriticalRaw) ? simCriticalRaw : DEFAULT_RISK_THRESHOLDS.similarity.critical,
            caution: Number.isFinite(simCautionRaw) ? simCautionRaw : DEFAULT_RISK_THRESHOLDS.similarity.caution
        },
        scorePeak: {
            critical: Number.isFinite(scoreCriticalRaw) ? scoreCriticalRaw : DEFAULT_RISK_THRESHOLDS.scorePeak.critical,
            caution: Number.isFinite(scoreCautionRaw) ? scoreCautionRaw : DEFAULT_RISK_THRESHOLDS.scorePeak.caution
        }
    };

    // 임계값 순서가 잘못되면 기본값으로 복원
    if (!(normalized.similarity.critical > normalized.similarity.caution)) {
        normalized.similarity.critical = DEFAULT_RISK_THRESHOLDS.similarity.critical;
        normalized.similarity.caution = DEFAULT_RISK_THRESHOLDS.similarity.caution;
    }
    if (!(normalized.scorePeak.critical > normalized.scorePeak.caution)) {
        normalized.scorePeak.critical = DEFAULT_RISK_THRESHOLDS.scorePeak.critical;
        normalized.scorePeak.caution = DEFAULT_RISK_THRESHOLDS.scorePeak.caution;
    }

    return normalized;
}

/**
 * 위험도 기준값 갱신
 * @param {Object} newThresholds - settings.json의 thresholds 객체
 */
function updateRiskThresholds(newThresholds) {
    RISK_THRESHOLDS = normalizeRiskThresholds(newThresholds);
}

/**
 * 현재 위험도 기준값 조회
 * @returns {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }}
 */
function getRiskThresholds() {
    return normalizeRiskThresholds(RISK_THRESHOLDS);
}

/**
 * 유사도 등급(critical/caution/monitor) 계산
 * @param {number} similarity - SIMILARITY 값
 * @returns {'critical'|'caution'|'monitor'}
 */
function getSimilarityBand(similarity) {
    const thresholds = getRiskThresholds().similarity;
    const val = Number(similarity) || 0;
    if (val > thresholds.critical) return 'critical';
    if (val > thresholds.caution) return 'caution';
    return 'monitor';
}

/**
 * 오류가능성 등급(critical/caution/monitor) 계산
 * @param {number} scorePeak - SCORE_PEAK 값
 * @returns {'critical'|'caution'|'monitor'}
 */
function getScoreBand(scorePeak) {
    const thresholds = getRiskThresholds().scorePeak;
    const val = Number(scorePeak) || 0;
    if (val >= thresholds.critical) return 'critical';
    if (val >= thresholds.caution) return 'caution';
    return 'monitor';
}

/**
 * 권고사항 등급(critical/caution/monitor) 계산
 * @param {number} similarity - SIMILARITY 값
 * @param {number} scorePeak - SCORE_PEAK 값
 * @returns {'critical'|'caution'|'monitor'}
 */
function getRecommendationBand(similarity, scorePeak) {
    const simBand = getSimilarityBand(similarity);
    const scoreBand = getScoreBand(scorePeak);
    if (simBand === 'critical' || scoreBand === 'critical') return 'critical';
    if (simBand === 'caution' || scoreBand === 'caution') return 'caution';
    return 'monitor';
}

/**
 * 섹터 코드를 사람이 읽을 수 있는 이름으로 변환
 * @param {string|number} ccp - 섹터 코드 (예: '3', '11', 252)
 * @returns {string} 섹터 이름 (예: 'GL', 'JN', 'FIS') 또는 'SEC {코드}' (매핑 없을 시)
 * @example
 * getSectorName('3')   // 'GL'
 * getSectorName('11')  // 'JN'
 * getSectorName('999') // 'SEC 999'
 */
function getSectorName(ccp) {
    return SECTOR_MAP[ccp] || `SEC ${ccp}`;
}

// ==================== 보안 관련 함수 ====================

/**
 * HTML 특수문자 이스케이프 (XSS 공격 방지)
 * @description 사용자 입력이나 DB 데이터를 HTML에 삽입할 때 반드시 이스케이프 처리
 * @param {string|null|undefined} str - 이스케이프할 문자열
 * @returns {string} 이스케이프된 안전한 문자열 (빈 값일 경우 빈 문자열 반환)
 * @example
 * escapeHtml('<script>alert("XSS")</script>')
 * // '&lt;script&gt;alert(&quot;XSS&quot;)&lt;/script&gt;'
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

// ==================== 시계 및 상태 표시 ====================

/**
 * KST 시계 업데이트 함수
 * @description 화면 우측 상단의 KST 시간 표시를 매초 갱신
 * @requires HTML 요소: <span id="realtime-clock">
 */
function updateClock() {
    const now = new Date();
    const timeStr = now.toLocaleTimeString('ko-KR', { timeZone: 'Asia/Seoul', hour12: false });
    const clockElement = document.getElementById('realtime-clock');
    if (clockElement) {
        clockElement.textContent = timeStr;
    }
}

/**
 * UTC 날짜 문자열을 KST로 변환 (프론트엔드 표시용)
 * @param {string} utcStr - UTC 날짜 (예: '2026-03-05 06:30:00')
 * @returns {string} KST 날짜 문자열
 */
function utcToKst(utcStr) {
    if (!utcStr || utcStr === '9999-12-31 23:59:59') return utcStr;
    const d = new Date(utcStr.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return utcStr;
    const kst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
    return kst.getUTCFullYear() + '-' +
        String(kst.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(kst.getUTCDate()).padStart(2, '0') + ' ' +
        String(kst.getUTCHours()).padStart(2, '0') + ':' +
        String(kst.getUTCMinutes()).padStart(2, '0') + ':' +
        String(kst.getUTCSeconds()).padStart(2, '0');
}

/**
 * 네트워크 연결 상태 표시 업데이트
 * @description API 요청 성공/실패에 따라 연결 상태 표시 변경 (깜빡이는 점 + 텍스트)
 * @param {boolean} isConnected - true: 연결됨, false: 연결끊김
 * @requires HTML 요소: <div id="network-dot">, <span id="network-status">
 */
function updateNetworkStatus(isConnected) {
    const dot = document.getElementById('network-dot');
    const status = document.getElementById('network-status');

    if (!dot || !status) return; // 요소가 없으면 중단

    if (isConnected) {
        dot.className = 'blink-dot';
        status.textContent = '연결됨';
    } else {
        dot.className = 'blink-dot error';
        status.textContent = '연결끊김';
    }
}

// ==================== 관리자 인증 ====================

const AUTH_KEY = 'katc_auth';
const AUTH_PASSWORD = 'katcadmin';

function isAuthenticated() {
    return sessionStorage.getItem(AUTH_KEY) === 'true';
}

function applyAuthState() {
    const authenticated = isAuthenticated();
    document.querySelectorAll('.auth-link').forEach(el => {
        el.style.display = authenticated ? '' : 'none';
    });
    const btn = document.querySelector('.header-login-btn');
    if (btn) btn.textContent = authenticated ? '🔓' : '🔒';
}

function handleAuthToggle() {
    if (isAuthenticated()) {
        sessionStorage.removeItem(AUTH_KEY);
        applyAuthState();
        // 관리자 페이지에 있으면 메인으로 이동
        if (location.pathname !== '/') location.href = '/';
    } else {
        const input = prompt('관리자 비밀번호를 입력하세요:');
        if (input === AUTH_PASSWORD) {
            sessionStorage.setItem(AUTH_KEY, 'true');
            applyAuthState();
        } else if (input !== null) {
            alert('비밀번호가 일치하지 않습니다.');
        }
    }
}

// 관리자 페이지 접근 보호 (인증 없이 URL 직접 접근 시 리다이렉트)
function checkAuthRequired() {
    const path = location.pathname;
    if ((path === '/admin' || path === '/history') && !isAuthenticated()) {
        location.href = '/';
    }
}

// ==================== 초기화 실행 ====================

/**
 * 시계 자동 갱신 시작 (페이지 로드 시 자동 실행)
 * @description 1초마다 updateClock() 호출하여 UTC 시간 업데이트
 */
if (document.getElementById('realtime-clock')) {
    updateClock(); // 즉시 1회 실행
    setInterval(updateClock, 1000); // 1초마다 갱신
}

// 인증 상태 적용 및 페이지 보호
applyAuthState();
checkAuthRequired();

