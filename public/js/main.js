// ==================== 전역 변수 ====================

let GLOBAL_DATA = [];
let REPORTER_LIST = []; // DB에서 조회한 보고자 목록
let currentSector = localStorage.getItem('selectedSector') || 'ALL';
let refreshInterval = null;
let currentRefreshRate = 10000; // 현재 적용된 갱신 주기 (interval 재생성 판단용)
let editingReport = null; // 수정 모드 시 기존 보고서 정보 { idx, originalReported }
let PREDICTION_DATA_ALL = []; // 예측 데이터 (원본)
let PREDICTION_DATA = []; // 예측 데이터 (필터 적용)
let PREDICTION_META = null; // 예측 메타 정보 (시간대, 요일 등)
let predictionIntervalMinute = null;  // 1분 주기 (시간 변경 감지)
let predictionIntervalFull = null;    // 5분 주기 (전체 갱신)
let lastPredictionHour = -1; // 시간 변경 감지용

// 서버 설정 (관리자가 설정, 모든 브라우저에 동시 적용)
let SERVER_CONFIG = {
    displaySectors: [],     // 표시할 섹터 목록 (비어있으면 전체)
    displaySimilarity: [],  // 표시할 유사도 등급 (비어있으면 전체)
    refreshRate: 10000,     // 갱신 주기 (ms)
    maxRows: 100,           // 최대 표시 건수
    errorTypes: [],         // 오류유형 목록
    errorDetailTypes: [],   // 세부오류유형 목록
    thresholds: getRiskThresholds() // 위험도 기준값
};

// ==================== 서버 설정 관리 ====================

/**
 * 서버 설정 불러오기 (관리자 화면에서 저장한 설정 적용)
 * @description /api/config 엔드포인트에서 config/settings.json 내용 조회
 * @returns {Promise<void>}
 */
async function loadServerConfig() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result.success && result.data) {
            const oldTypes = JSON.stringify(SERVER_CONFIG.errorTypes);
            const oldDetailTypes = JSON.stringify(SERVER_CONFIG.errorDetailTypes);

            SERVER_CONFIG = {
                displaySectors: result.data.displaySectors || [],
                displaySimilarity: result.data.displaySimilarity || [],
                refreshRate: result.data.refreshRate || 10000,
                maxRows: result.data.maxRows || 100,
                errorTypes: result.data.errorTypes || [],
                errorDetailTypes: result.data.errorDetailTypes || [],
                thresholds: result.data.thresholds || getRiskThresholds()
            };

            // 섹터 맵핑 적용 (서버 설정이 common.js 기본값을 덮어씀)
            if (result.data.sectorMap && Object.keys(result.data.sectorMap).length > 0) {
                updateSectorConfig(result.data.sectorMap, result.data.fixedSectors || []);
            }

            // 위험도 기준값 적용
            updateRiskThresholds(SERVER_CONFIG.thresholds);

            // 설정이 변경된 경우에만 드롭다운 재생성 (선택값 유지)
            if (oldTypes !== JSON.stringify(SERVER_CONFIG.errorTypes)) {
                populateErrorTypes();
            }
            if (oldDetailTypes !== JSON.stringify(SERVER_CONFIG.errorDetailTypes)) {
                populateErrorDetailTypes();
            }
        }
    } catch (err) {
        console.error('서버 설정 로드 실패:', err);
    }
}

/**
 * 오류유형/세부오류유형 드롭다운 동적 생성 (서버 설정 기반)
 * 오류유형 변경 시 세부오류유형이 연동 필터링됨
 */
function populateErrorTypes() {
    const select = document.getElementById('reportType');
    if (!select) return;
    const types = SERVER_CONFIG.errorTypes || [];
    select.innerHTML = '<option value="">선택하기</option>' +
        types.map(t => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');

    // 오류유형 변경 시 세부오류유형 연동
    select.onchange = function() {
        populateErrorDetailTypes(parseInt(this.value) || null);
    };
}

function populateErrorDetailTypes(parentType) {
    const select = document.getElementById('safetyImpact');
    if (!select) return;
    const allTypes = SERVER_CONFIG.errorDetailTypes || [];

    // parentType이 지정되면 해당 유형 + 공통(parentType=0)만 표시
    const filtered = parentType != null
        ? allTypes.filter(t => t.parentType === parentType || t.parentType === 0 || !t.parentType)
        : allTypes;

    select.innerHTML = filtered.map(t => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');

    // 오류유형 선택 시 첫 번째 항목 자동 선택, 미선택 시 placeholder
    if (parentType != null && filtered.length > 0) {
        select.value = filtered[0].value;
    } else {
        select.innerHTML = '<option value="">선택하세요</option>' + select.innerHTML;
        select.value = '';
    }
}

// ==================== 항공사 매핑 (main.js 전용) ====================

// AIRLINE_MAP, getAirlineName()은 common.js에서 로드

// ==================== 위험도 평가 로직 ====================

/**
 * 유사도 등급 판정 (SIMILARITY 기준)
 * @param {number} similarity - 유사도 점수
 * @returns {Object} 등급 텍스트 및 CSS 클래스 { text, tag }
 */
function getSimilarityLevel(similarity) {
    const band = getSimilarityBand(similarity);
    if (band === 'critical') return { text: '매우높음', tag: 'tag-danger' };
    if (band === 'caution') return { text: '높음', tag: 'tag-warning' };
    return { text: '보통', tag: 'tag-info' };
}

/**
 * 유사도 등급 필터링 (환경설정 연동)
 * @param {Array} data - 원본 데이터
 * @returns {Array} 필터링된 데이터 (미설정 시 전체 반환)
 */
function filterBySimilarity(data) {
    const levels = SERVER_CONFIG.displaySimilarity;
    if (!levels || levels.length === 0) return data;

    return data.filter(d => {
        const band = getSimilarityBand(d.SIMILARITY);
        return levels.includes(band);
    });
}

/**
 * 오류가능성 판정 (SCORE_PEAK 기준)
 * @param {number} scorePeak - 오류 가능성 점수
 * @returns {Object} 등급 텍스트 및 CSS 클래스 { text, tag }
 */
function getRiskLevel(scorePeak) {
    const band = getScoreBand(scorePeak);
    if (band === 'critical') return { text: '매우높음', tag: 'tag-danger' };
    if (band === 'caution') return { text: '높음', tag: 'tag-warning' };
    return { text: '낮음', tag: 'tag-info' };
}

/**
 * 권고사항 판정 (유사도와 오류가능성 종합 평가)
 * @param {number} similarity - 유사도 점수
 * @param {number} scorePeak - 오류가능성 점수
 * @returns {Object} 권고사항 텍스트 및 CSS 클래스 { text, tag }
 */
function getAction(similarity, scorePeak) {
    const band = getRecommendationBand(similarity, scorePeak);
    if (band === 'critical') return { text: '즉시조치', tag: 'tag-danger' };
    if (band === 'caution') return { text: '주의관찰', tag: 'tag-warning' };
    return { text: '정상감시', tag: 'tag-info' };
}

/**
 * 위험도 종합 평가 (테이블 렌더링 및 상세 보기에서 공통 사용)
 * @description 유사호출부호 데이터의 위험도 등급, 오류가능성, 권고사항을 일괄 계산
 * @param {Object} data - 유사호출부호 데이터 객체
 * @returns {Object} 평가 결과 { riskClass, similarity, risk, action, airlineText }
 * @example
 * const assessment = calculateRiskAssessment(callsignData);
 * // { riskClass: 'high-risk', similarity: { text: '매우높음', tag: 'tag-danger' }, ... }
 */
function calculateRiskAssessment(data) {
    // TR 행 CSS 클래스 (고위험/중위험 강조)
    let riskClass = '';
    const similarityBand = getSimilarityBand(data.SIMILARITY);
    if (similarityBand === 'critical') {
        riskClass = 'high-risk';
    } else if (similarityBand === 'caution') {
        riskClass = 'med-risk';
    }

    // 유사도 등급
    const similarity = getSimilarityLevel(data.SIMILARITY);

    // 오류가능성 등급
    const risk = getRiskLevel(data.SCORE_PEAK || 0);

    // 권고사항
    const action = getAction(data.SIMILARITY, data.SCORE_PEAK || 0);

    // 항공사명 (두 호출부호의 접두어가 같으면 하나만, 다르면 둘 다 표시)
    const airline1 = getAirlineName(data.FP1_CALLSIGN);
    const airline2 = getAirlineName(data.FP2_CALLSIGN);
    const airlineText = airline1 === airline2 ? airline1 : `${airline1} / ${airline2}`;

    return { riskClass, similarity, risk, action, airlineText };
}

// ==================== 보고자 관리 ====================

/**
 * 보고자 목록 로드 (A_REALTIME_LOGIN 테이블 조회)
 * @description 현재 로그인된 사용자 목록을 조회하여 보고자 드롭다운 구성
 * @returns {Promise<void>}
 */
async function loadReporters() {
    try {
        const response = await fetch('/api/reporters');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();
        if (result.success) {
            REPORTER_LIST = result.data.map(r => r.USER_NM);
        }
    } catch (err) {
        console.error('보고자 목록 로드 실패:', err);
        REPORTER_LIST = [];
    }
    renderReporterSelect();
}

/**
 * 보고자 드롭다운 렌더링
 * @description 로그인 사용자가 있으면 드롭다운, 없으면 직접 입력 모드
 */
function renderReporterSelect() {
    const select = document.getElementById('reporterSelect');
    const input = document.getElementById('reporterInput');

    if (REPORTER_LIST.length > 0) {
        let html = '<option value="">선택하세요</option>';
        REPORTER_LIST.forEach(name => {
            html += `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`;
        });
        html += '<option value="__direct__">직접 입력</option>';
        select.innerHTML = html;
        select.style.display = '';
        input.style.display = 'none';
    } else {
        // 목록 없으면 직접 입력 모드
        select.style.display = 'none';
        input.style.display = '';
        input.placeholder = '이름 입력';
    }
}

/**
 * 보고자 값 가져오기 (드롭다운 또는 직접 입력)
 * @returns {string} 보고자 이름
 */
function getReporterValue() {
    const select = document.getElementById('reporterSelect');
    const input = document.getElementById('reporterInput');

    if (select.style.display !== 'none') {
        if (select.value === '__direct__') {
            return input.value.trim();
        }
        return select.value;
    }
    return input.value.trim();
}

// ==================== 데이터 로드 ====================

/**
 * 재시도가 포함된 fetch 요청
 * @param {string} url - 요청 URL
 * @param {Object} options - fetch 옵션
 * @param {number} maxRetries - 최대 재시도 횟수 (기본 3)
 * @param {number} baseDelay - 기본 대기 시간 ms (기본 1000)
 * @returns {Promise<Response>}
 */
async function fetchWithRetry(url, options = {}, maxRetries = 3, baseDelay = 1000) {
    let lastError;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
            const response = await fetch(url, options);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            return response;
        } catch (err) {
            lastError = err;

            if (attempt < maxRetries) {
                // 지수 백오프: 1초, 2초, 4초...
                const delay = baseDelay * Math.pow(2, attempt);
                console.warn(`네트워크 오류, ${delay}ms 후 재시도 (${attempt + 1}/${maxRetries}):`, err.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

/**
 * 유사호출부호 데이터 로드
 * @description 선택된 섹터의 활성 유사호출부호 쌍 조회 및 테이블 렌더링
 *              네트워크 오류 시 최대 3회 재시도 (지수 백오프)
 * @returns {Promise<void>}
 */
async function loadData() {
    try {
        // 항상 전체 활성 섹터 데이터를 조회 (사이드바 건수 계산용)
        const activeSectors = SERVER_CONFIG.displaySectors.length > 0
            ? SERVER_CONFIG.displaySectors
            : FIXED_SECTORS;
        const url = `/api/callsigns?sectors=${activeSectors.join(',')}`;

        const response = await fetchWithRetry(url);
        const result = await response.json();

        if (result.success) {
            const allData = filterBySimilarity(result.data);
            // 전체 데이터로 사이드바 섹터 건수 계산 (별도 API 호출 불필요)
            recalculateSectorCounts(allData);
            // 현재 섹터로 필터링
            GLOBAL_DATA = currentSector === 'ALL'
                ? allData
                : allData.filter(d => String(d.CCP) === currentSector);
            // 정렬: 즉시조치 우선, 같은 등급 내에서는 최초 검출(오래된 순)
            GLOBAL_DATA.sort((a, b) => {
                const aAction = getAction(a.SIMILARITY, a.SCORE_PEAK || 0).text;
                const bAction = getAction(b.SIMILARITY, b.SCORE_PEAK || 0).text;
                const priority = { '즉시조치': 0, '주의관찰': 1, '정상감시': 2 };
                const diff = (priority[aAction] ?? 9) - (priority[bAction] ?? 9);
                if (diff !== 0) return diff;
                return (a.IDX || 0) - (b.IDX || 0);
            });
            renderTable();
            updateNetworkStatus(true);
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('데이터 로드 실패 (재시도 후):', err);
        updateNetworkStatus(false);
    }
}

/**
 * 예측 데이터 로드
 * @description 과거 동일요일 + 다음시간대 이력 기반 예측 콜사인 쌍 조회
 */
async function loadPredictions() {
    try {
        const activeSectors = SERVER_CONFIG.displaySectors.length > 0
            ? SERVER_CONFIG.displaySectors
            : FIXED_SECTORS;
        const url = `/api/callsigns/predictions?sectors=${activeSectors.join(',')}`;
        const response = await fetch(url);
        if (!response.ok) return;
        const result = await response.json();
        if (result.success) {
            PREDICTION_DATA_ALL = result.data || [];
            PREDICTION_META = result.meta || null;
            // 현재 섹터 필터 적용
            if (currentSector !== 'ALL') {
                PREDICTION_DATA = PREDICTION_DATA_ALL.filter(d => String(d.CCP) === currentSector);
            } else {
                PREDICTION_DATA = PREDICTION_DATA_ALL;
            }
            renderTable(); // 독립 호출 시에만 렌더링 (filterBySector에서는 loadData가 렌더링)
        }
    } catch (err) {
        console.error('예측 데이터 로드 실패:', err);
    }
}

/**
 * 예측 폴링 시작 (5분 주기, 시간 변경 시 즉시 갱신)
 */
function startPredictionPolling() {
    // 기존 interval 정리
    if (predictionIntervalMinute) clearInterval(predictionIntervalMinute);
    if (predictionIntervalFull) clearInterval(predictionIntervalFull);

    loadPredictions();

    // 1분마다 시간 변경 체크 → 정시 넘으면 즉시 갱신
    predictionIntervalMinute = setInterval(() => {
        const currentHour = new Date().getHours();
        if (currentHour !== lastPredictionHour) {
            lastPredictionHour = currentHour;
            loadPredictions();
        }
    }, 60000);

    // 5분마다 전체 갱신
    predictionIntervalFull = setInterval(() => {
        loadPredictions();
    }, 300000);
}

/**
 * 섹터 목록 로드
 * @description 모든 섹터의 유사호출부호 건수 조회 및 사이드바 렌더링
 * @returns {Promise<void>}
 */
function loadSectors() {
    renderSectors();
}

// ==================== UI 렌더링 ====================

/**
 * 섹터 목록 렌더링 (사이드바)
 * 전체 섹터 건수는 ALL_SECTOR_COUNTS에서, 현재 테이블 데이터는 GLOBAL_DATA에서 분리
 */
let ALL_SECTOR_COUNTS = {}; // 전체 섹터별 유사호출부호 건수
let ALL_HIGH_RISK_COUNT = 0;
let CONTROL_COUNTS = {}; // 섹터별 현재 관제 건수 (ATFM)
let ALL_SECTOR_RISK_COUNTS = {}; // 섹터별 즉시조치/주의관찰 건수

/**
 * GLOBAL_DATA에서 섹터별 건수 재계산 (API 호출 없음)
 * 권고사항(즉시조치/주의관찰) 건수도 함께 계산
 */
function recalculateSectorCounts(data) {
    ALL_SECTOR_COUNTS = {};
    ALL_HIGH_RISK_COUNT = 0;
    ALL_SECTOR_RISK_COUNTS = {};
    data.forEach(d => {
        const ccp = String(d.CCP);
        ALL_SECTOR_COUNTS[ccp] = (ALL_SECTOR_COUNTS[ccp] || 0) + 1;
        if (getSimilarityBand(d.SIMILARITY) === 'critical') ALL_HIGH_RISK_COUNT++;

        if (!ALL_SECTOR_RISK_COUNTS[ccp]) {
            ALL_SECTOR_RISK_COUNTS[ccp] = { immediate: 0, caution: 0 };
        }
        const action = getAction(d.SIMILARITY, d.SCORE_PEAK || 0);
        if (action.text === '즉시조치') ALL_SECTOR_RISK_COUNTS[ccp].immediate++;
        else if (action.text === '주의관찰') ALL_SECTOR_RISK_COUNTS[ccp].caution++;
    });
}


async function loadControlCounts() {
    try {
        const response = await fetchWithRetry('/api/control-counts');
        const result = await response.json();
        if (result.success) {
            CONTROL_COUNTS = {};
            result.data.forEach(d => {
                // ATFM은 섹터 이름(GL, KL 등)을 반환 → 숫자 코드로 변환
                const code = SECTOR_NAME_TO_CODE[d.CCP];
                if (code) {
                    CONTROL_COUNTS[code] = d.CNT;
                }
            });
        }
    } catch (err) {
        console.error('관제 건수 로드 실패:', err);
    }
}

function renderSectors() {
    const container = document.getElementById('sector-cards');

    // 환경설정에서 선택한 섹터만 표시 (미설정 시 고정 섹터 전체)
    const activeSectors = SERVER_CONFIG.displaySectors.length > 0
        ? SERVER_CONFIG.displaySectors
        : FIXED_SECTORS;
    const displayList = activeSectors.map(ccp => {
        return { CCP: ccp, CNT: ALL_SECTOR_COUNTS[String(ccp)] || 0 };
    });

    const html = displayList.map(s => {
        const isEmpty = s.CNT === 0;
        const isActive = currentSector == s.CCP;
        const ctrlCnt = CONTROL_COUNTS[String(s.CCP)] || 0;
        const risk = ALL_SECTOR_RISK_COUNTS[String(s.CCP)] || { immediate: 0, caution: 0 };

        return `
            <div class="sector-card ${isActive ? 'active' : ''} ${isEmpty && ctrlCnt === 0 ? 'dimmed' : ''}" onclick="filterBySector('${s.CCP}')">
                <div class="sector-card-name">${getSectorName(s.CCP)}</div>
                <div class="sector-card-counts">
                    <div class="sector-card-stat ctrl">
                        <span class="sector-card-stat-value">${ctrlCnt}</span>
                        <span class="sector-card-stat-label">관제</span>
                    </div>
                    <div class="sector-card-stat detect ${s.CNT > 0 ? 'has-alert' : ''}">
                        <span class="sector-card-stat-value">${s.CNT}</span>
                        <span class="sector-card-stat-label">검출</span>
                    </div>
                </div>
                <div class="sector-card-actions">
                    <span class="sector-card-action danger ${risk.immediate > 0 ? 'has-count' : ''}">즉시조치 ${risk.immediate}</span>
                    <span class="sector-card-action warning ${risk.caution > 0 ? 'has-count' : ''}">주의관찰 ${risk.caution}</span>
                </div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

/**
 * 테이블 렌더링
 * @description GLOBAL_DATA를 기반으로 유사호출부호 목록 테이블 생성
 *              공통 평가 함수(calculateRiskAssessment) 사용으로 중복 로직 제거
 */
function renderTable() {
    const tbody = document.getElementById('callsign-tbody');

    if (GLOBAL_DATA.length === 0 && PREDICTION_DATA.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">데이터 없음</td></tr>';
        return;
    }

    let html = GLOBAL_DATA.slice(0, SERVER_CONFIG.maxRows).map(d => {
        // 위험도 종합 평가 (공통 함수 사용)
        const assessment = calculateRiskAssessment(d);

        const fp1 = escapeHtml(d.FP1_CALLSIGN);
        const fp2 = escapeHtml(d.FP2_CALLSIGN);

        return `
            <tr class="${assessment.riskClass}" data-idx="${d.IDX}">
                <td>
                    <div class="callsign-box">
                        <span class="callsign-main">${fp1 || '-'}</span>
                        <span class="vs">|</span>
                        <span class="callsign-main">${fp2 || '-'}</span>
                    </div>
                </td>
                <td>${escapeHtml(assessment.airlineText)}</td>
                <td><span style="color: var(--accent-primary)">${escapeHtml(getSectorName(d.CCP))}</span></td>
                <td><span class="tag ${assessment.similarity.tag}">${assessment.similarity.text}</span></td>
                <td><span class="tag ${assessment.risk.tag}">${assessment.risk.text}</span></td>
                <td><span class="tag ${assessment.action.tag}">${assessment.action.text}</span></td>
                <td>
                    ${d.REPORT_COUNT > 0
                        ? '<span class="btn btn-sm btn-reported" title="보고 완료됨">보고완료</span>'
                        : '<button class="btn btn-sm btn-primary" style="white-space: nowrap;">보고</button>'}
                </td>
            </tr>
        `;
    }).join('');

    // 예측 데이터 렌더링
    if (PREDICTION_DATA.length > 0 && PREDICTION_META) {
        const nh = String(PREDICTION_META.nextHour).padStart(2, '0');
        const eh = String(PREDICTION_META.endHour).padStart(2, '0');
        const dayName = PREDICTION_META.dayName || '';

        html += `
            <tr class="prediction-separator">
                <td colspan="7">다음 시간대 예측 (${nh}:00~${eh}:00 / ${dayName}요일 이력 기반) ${PREDICTION_DATA.length}건</td>
            </tr>
        `;

        html += PREDICTION_DATA.map(d => {
            const assessment = calculateRiskAssessment(d);
            const fp1 = escapeHtml(d.FP1_CALLSIGN);
            const fp2 = escapeHtml(d.FP2_CALLSIGN);

            return `
                <tr class="prediction-row">
                    <td>
                        <div class="callsign-box">
                            <span class="callsign-main">${fp1 || '-'}</span>
                            <span class="vs">|</span>
                            <span class="callsign-main">${fp2 || '-'}</span>
                        </div>
                    </td>
                    <td>${escapeHtml(assessment.airlineText)}</td>
                    <td><span class="prediction-sector">${escapeHtml(getSectorName(d.CCP))}</span></td>
                    <td><span class="tag prediction-tag ${assessment.similarity.tag}">${assessment.similarity.text}</span></td>
                    <td class="prediction-empty">-</td>
                    <td class="prediction-empty">-</td>
                    <td><span class="prediction-badge">${d.HIST_COUNT}회 검출</span></td>
                </tr>
            `;
        }).join('');
    }

    tbody.innerHTML = html;
}

// 섹터 필터
function filterBySector(sector) {
    currentSector = sector;
    localStorage.setItem('selectedSector', sector);
    loadData();
    loadPredictions();
    renderSectors(); // 건수는 이미 ALL_SECTOR_COUNTS에 있으므로 렌더만
}

/**
 * 보고 모달 열기
 * @param {number} idx - 유사호출부호 IDX
 * @param {string} fp1 - 첫 번째 호출부호 (선택사항, 없으면 GLOBAL_DATA에서 조회)
 * @param {string} fp2 - 두 번째 호출부호 (선택사항, 없으면 GLOBAL_DATA에서 조회)
 */
async function openReportModal(idx, fp1, fp2) {
    // IDX로 데이터 조회 (fp1, fp2가 없는 경우 대비)
    const item = GLOBAL_DATA.find(d => d.IDX === idx);
    if (!item) {
        console.error('해당 IDX의 데이터를 찾을 수 없습니다:', idx);
        return;
    }

    // 수정 모드 초기화
    editingReport = null;

    // 호출부호 설정 (인자가 없으면 item에서 추출)
    const callsign1 = fp1 || item.FP1_CALLSIGN;
    const callsign2 = fp2 || item.FP2_CALLSIGN;

    document.getElementById('reportIdx').value = idx;
    document.getElementById('reportCallsign').value = `${callsign1} | ${callsign2}`;
    // 로컬 시간 기준 보고 일시 (KST)
    const nowLocal = new Date();
    const localDT = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}T${String(nowLocal.getHours()).padStart(2,'0')}:${String(nowLocal.getMinutes()).padStart(2,'0')}`;
    const reportDTInput = document.getElementById('reportDateTime');
    reportDTInput.value = localDT;
    reportDTInput.disabled = false;

    // 오류 항공기 드롭다운에 실제 호출부호 표시
    const aoSelect = document.getElementById('reportAO');
    aoSelect.innerHTML = `
        <option value="">선택하세요</option>
        <option value="1">${escapeHtml(callsign1)}</option>
        <option value="2">${escapeHtml(callsign2)}</option>
        <option value="3">${escapeHtml(callsign1)} | ${escapeHtml(callsign2)} (쌍)</option>
    `;
    aoSelect.value = '';
    document.getElementById('reportType').value = '';
    populateErrorDetailTypes(null); // 세부오류유형 전체 표시로 리셋
    document.getElementById('reportRemark').value = '';

    // 보고자 목록 갱신 후 초기화 (교대 반영)
    await loadReporters();
    renderReporterSelect();
    document.getElementById('reporterInput').value = '';

    // 모달 제목/버튼 초기화
    const modalTitle = document.querySelector('#reportModal .card-title');
    if (modalTitle) modalTitle.textContent = '유사호출부호 오류 보고';
    const submitBtn = document.querySelector('#reportModal .btn-primary[onclick*="submitReport"]');
    if (submitBtn) submitBtn.textContent = '보고 제출';

    // 보고완료 항목이면 기존 데이터 불러오기 (수정 모드)
    if (item.REPORT_COUNT > 0) {
        try {
            const resp = await fetch(`/api/reports/${idx}`);
            const result = await resp.json();
            if (result.success && result.data) {
                const report = result.data;
                editingReport = { idx: idx, originalReported: report.REPORTED };

                // 기존 보고 데이터로 폼 채우기 (발생일시는 PK이므로 수정 불가)
                const dtInput = document.getElementById('reportDateTime');
                if (report.REPORTED) {
                    const dt = report.REPORTED.replace(' ', 'T').substring(0, 16);
                    dtInput.value = dt;
                }
                dtInput.disabled = true;
                aoSelect.value = String(report.AO || '');
                document.getElementById('reportType').value = String(report.TYPE || '');
                populateErrorDetailTypes(report.TYPE ? parseInt(report.TYPE) : null);
                document.getElementById('safetyImpact').value = String(report.TYPE_DETAIL || '');
                document.getElementById('reportRemark').value = report.REMARK === '-' ? '' : (report.REMARK || '');

                // 보고자 설정
                const select = document.getElementById('reporterSelect');
                const input = document.getElementById('reporterInput');
                if (report.REPORTER) {
                    const option = Array.from(select.options).find(o => o.value === report.REPORTER);
                    if (option) {
                        select.value = report.REPORTER;
                        input.style.display = 'none';
                    } else {
                        select.value = '__direct__';
                        input.style.display = '';
                        input.value = report.REPORTER;
                    }
                }

                // 모달 제목/버튼을 수정 모드로 변경
                if (modalTitle) modalTitle.textContent = '오류 보고서 수정';
                if (submitBtn) submitBtn.textContent = '보고 수정';
            }
        } catch (err) {
            console.error('기존 보고서 조회 실패:', err);
        }
    }

    document.getElementById('reportModal').classList.add('active');
}

// 모달 닫기
function closeModal() {
    document.getElementById('reportModal').classList.remove('active');
}

// 보고서 제출
let _submitInProgress = false;
async function submitReport() {
    if (_submitInProgress) return;
    _submitInProgress = true;
    const reporter = getReporterValue();
    const ao = document.getElementById('reportAO').value;
    const errorType = document.getElementById('reportType').value;
    const impact = document.getElementById('safetyImpact').value;

    if (!reporter) {
        alert('보고자를 선택하거나 입력하세요.');
        _submitInProgress = false;
        return;
    }
    if (!ao) { alert('오류 항공기를 선택하세요.'); _submitInProgress = false; return; }
    if (!errorType) { alert('오류 유형을 선택하세요.'); _submitInProgress = false; return; }
    if (!impact) { alert('세부오류유형을 선택하세요.'); _submitInProgress = false; return; }

    const data = {
        idx: parseInt(document.getElementById('reportIdx').value, 10),
        reported: document.getElementById('reportDateTime').value.replace('T', ' ') + ':00',
        reporter: reporter,
        ao: parseInt(ao, 10),
        type: parseInt(errorType, 10),
        typeDetail: parseInt(impact, 10),
        remark: document.getElementById('reportRemark').value.trim() || '-'
    };

    // 수정 모드면 originalReported 추가
    const isEdit = !!editingReport;
    if (isEdit) {
        data.originalReported = editingReport.originalReported;
    }

    try {
        const response = await fetch('/api/reports', {
            method: isEdit ? 'PUT' : 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            // 보고 완료 즉시 반영 (다음 폴링 전 UI 업데이트)
            if (!isEdit) {
                const reportedItem = GLOBAL_DATA.find(d => d.IDX === data.idx);
                if (reportedItem) {
                    reportedItem.REPORT_COUNT = (reportedItem.REPORT_COUNT || 0) + 1;
                }
            }
            renderTable();
            alert(isEdit ? '보고서가 수정되었습니다.' : '보고가 정상적으로 접수되었습니다.');
            editingReport = null;
            closeModal();
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('보고서 저장 실패:', err);
        alert('보고 제출 실패: ' + err.message);
    } finally {
        _submitInProgress = false;
    }
}

// ==================== Excel 내보내기 ====================

/**
 * 전체 데이터 Excel 내보내기
 * @description 현재 화면에 표시된 필터링된 데이터를 Excel 파일로 내보내기
 *              SheetJS 라이브러리 사용 (폐쇄망 환경 대응)
 */
async function exportToExcel() {
    try {
        // SheetJS 라이브러리 확인
        if (typeof XLSX === 'undefined') {
            alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
            return;
        }

        if (GLOBAL_DATA.length === 0) {
            alert('내보낼 데이터가 없습니다.');
            return;
        }

        // 전체 데이터를 서버에서 다시 조회 (화면 표시 제한 없이)
        let fullData = [];

        // 현재 필터 조건으로 전체 데이터 조회
        let url;
        if (currentSector === 'ALL') {
            const activeSectors = SERVER_CONFIG.displaySectors.length > 0
                ? SERVER_CONFIG.displaySectors
                : FIXED_SECTORS;
            url = `/api/callsigns?sectors=${activeSectors.join(',')}`;
        } else {
            url = `/api/callsigns?sector=${currentSector}`;
        }

        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            fullData = filterBySimilarity(result.data);
        } else {
            throw new Error(result.error);
        }

        // Excel 데이터 생성 (한글 헤더 + 사람이 읽기 쉬운 형식)
        const excelData = fullData.map(d => {
            const assessment = calculateRiskAssessment(d);

            return {
                '검출시각': d.DETECTED || '-',
                '섹터': getSectorName(d.CCP),
                '호출부호1': d.FP1_CALLSIGN || '-',
                '호출부호2': d.FP2_CALLSIGN || '-',
                '항공사': assessment.airlineText,
                '출발1': d.FP1_DEPT || '-',
                '도착1': d.FP1_DEST || '-',
                '출발2': d.FP2_DEPT || '-',
                '도착2': d.FP2_DEST || '-',
                '유사도점수': d.SIMILARITY || 0,
                '유사도등급': assessment.similarity.text,
                '오류가능성점수': d.SCORE_PEAK || 0,
                '오류가능성등급': assessment.risk.text,
                '권고사항': assessment.action.text,
                '매칭위치': d.MATCH_POS || '-',
                '매칭길이': d.MATCH_LEN || '-',
                '비고': d.MARK || '-'
            };
        });

        // 워크북 생성
        const wb = XLSX.utils.book_new();
        const ws = XLSX.utils.json_to_sheet(excelData);

        // 컬럼 너비 자동 조정
        const colWidths = [
            { wch: 18 }, // 검출시각
            { wch: 10 }, // 섹터
            { wch: 12 }, // 호출부호1
            { wch: 12 }, // 호출부호2
            { wch: 15 }, // 항공사
            { wch: 8 },  // 출발1
            { wch: 8 },  // 도착1
            { wch: 8 },  // 출발2
            { wch: 8 },  // 도착2
            { wch: 10 }, // 유사도점수
            { wch: 12 }, // 유사도등급
            { wch: 12 }, // 오류가능성점수
            { wch: 12 }, // 오류가능성등급
            { wch: 12 }, // 권고사항
            { wch: 10 }, // 매칭위치
            { wch: 10 }, // 매칭길이
            { wch: 20 }  // 비고
        ];
        ws['!cols'] = colWidths;

        // 워크시트 추가
        XLSX.utils.book_append_sheet(wb, ws, '유사호출부호');

        // 파일명 생성 (날짜 + 시간 + 섹터)
        const now = new Date();
        const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
        const timeStr = now.toTimeString().slice(0, 5).replace(/:/g, '');
        const sectorStr = currentSector === 'ALL' ? '전체섹터' : getSectorName(currentSector);
        const filename = `유사호출부호_${sectorStr}_${dateStr}_${timeStr}.xlsx`;

        // 파일 다운로드
        XLSX.writeFile(wb, filename);

        console.log(`Excel 내보내기 완료: ${fullData.length}건`);
    } catch (err) {
        console.error('Excel 내보내기 실패:', err);
        alert('Excel 내보내기 실패: ' + err.message);
    }
}

// ==================== 자동 갱신 관리 ====================

/**
 * 자동 갱신 시작/재시작
 * @description 설정된 refreshRate로 자동 갱신 interval 생성
 *              refreshRate 변경 시 interval 재생성
 */
function startAutoRefresh() {
    // 기존 interval 정리
    if (refreshInterval) {
        clearInterval(refreshInterval);
        refreshInterval = null;
    }

    currentRefreshRate = SERVER_CONFIG.refreshRate;

    refreshInterval = setInterval(async () => {
        try {
            const oldRate = SERVER_CONFIG.refreshRate;
            await loadServerConfig(); // 설정 변경 감지

            // refreshRate가 변경되면 interval 재생성
            if (SERVER_CONFIG.refreshRate !== oldRate) {
                console.log(`갱신 주기 변경: ${oldRate}ms → ${SERVER_CONFIG.refreshRate}ms`);
                startAutoRefresh();
                return; // 현재 interval 종료, 새 interval이 데이터 로드
            }

            Promise.all([loadControlCounts(), loadData()]).then(() => renderSectors());
        } catch (err) {
            console.warn('자동 갱신 실패 (서버 복구 시 자동 재개):', err.message);
        }
    }, currentRefreshRate);

    console.log(`자동 갱신 시작: ${currentRefreshRate}ms 주기`);
}

/**
 * 초기화
 * @description 페이지 로드 시 실행되는 초기 설정 함수
 *              - 서버 설정 로드, 데이터 로드, 이벤트 리스너 등록
 */
async function init() {
    try {
        // 서버 설정 먼저 로드 (관리자 설정 적용)
        await loadServerConfig();

        await Promise.all([loadData(), loadControlCounts()]);
        renderSectors();
        await loadReporters();

        // ===== 이벤트 위임: 테이블 행 클릭 이벤트 =====
        // 각 행마다 onclick 속성 대신 tbody에 하나의 리스너만 등록 (메모리 효율적)
        document.getElementById('callsign-tbody').addEventListener('click', function(e) {
            // 클릭된 요소에서 가장 가까운 TR 찾기
            const tr = e.target.closest('tr');
            if (!tr || !tr.dataset.idx) return; // data-idx 없으면 무시 (빈 상태 행)

            const idx = parseInt(tr.dataset.idx, 10);
            openReportModal(idx);
        });

        // 보고자 드롭다운 change 이벤트
        document.getElementById('reporterSelect').addEventListener('change', function() {
            const input = document.getElementById('reporterInput');
            if (this.value === '__direct__') {
                input.style.display = '';
                input.focus();
            } else {
                input.style.display = 'none';
                input.value = '';
            }
        });

        document.getElementById('loader').style.display = 'none';

        // 자동 갱신 시작 (서버 설정의 refreshRate 적용)
        startAutoRefresh();

        // 예측 데이터 폴링 시작
        startPredictionPolling();
    } catch (err) {
        console.error('초기화 실패:', err);
        document.getElementById('loader').innerHTML = `
            <div style="color: var(--accent-danger);">연결 실패</div>
            <div style="margin-top: 10px; font-size: 14px;">서버에 연결할 수 없습니다.</div>
        `;
    }
}

// ESC 키로 모달 닫기
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeModal();
    }
});

// 모달 배경 클릭으로 닫기
document.addEventListener('click', (e) => {
    /** @type {HTMLElement|null} */
    const modal = document.getElementById('reportModal');
    if (e.target === modal) {
        closeModal();
    }
});

// 페이지 로드 시 초기화
window.onload = init;
