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
const SECTOR_MAP = {
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
const FIXED_SECTORS = ['3', '2', '10', '9', '11', '13', '12']; // GL, GH, KL, KH, JN, JL, JH

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
 * UTC 시계 업데이트 함수
 * @description 화면 우측 상단의 UTC 시간 표시를 매초 갱신
 * @requires HTML 요소: <span id="realtime-clock">
 */
function updateClock() {
    const now = new Date();
    const timeStr = now.toISOString().split('T')[1].split('.')[0]; // HH:MM:SS 형식 추출
    const clockElement = document.getElementById('realtime-clock');
    if (clockElement) {
        clockElement.textContent = timeStr;
    }
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

// ==================== 초기화 실행 ====================

/**
 * 시계 자동 갱신 시작 (페이지 로드 시 자동 실행)
 * @description 1초마다 updateClock() 호출하여 UTC 시간 업데이트
 */
if (document.getElementById('realtime-clock')) {
    updateClock(); // 즉시 1회 실행
    setInterval(updateClock, 1000); // 1초마다 갱신
}
