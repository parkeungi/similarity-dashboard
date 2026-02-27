// ==================== 전역 변수 ====================

let GLOBAL_DATA = [];
let REPORTER_LIST = []; // DB에서 조회한 보고자 목록
let currentSector = localStorage.getItem('selectedSector') || 'ALL';
let refreshInterval = null;
let currentRefreshRate = 10000; // 현재 적용된 갱신 주기 (interval 재생성 판단용)

// 서버 설정 (관리자가 설정, 모든 브라우저에 동시 적용)
let SERVER_CONFIG = {
    displaySectors: [],     // 표시할 섹터 목록 (비어있으면 전체)
    displaySimilarity: [],  // 표시할 유사도 등급 (비어있으면 전체)
    refreshRate: 10000,     // 갱신 주기 (ms)
    maxRows: 100            // 최대 표시 건수
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
            SERVER_CONFIG = {
                displaySectors: result.data.displaySectors || [],
                displaySimilarity: result.data.displaySimilarity || [],
                refreshRate: result.data.refreshRate || 10000,
                maxRows: result.data.maxRows || 100
            };
        }
    } catch (err) {
        console.error('서버 설정 로드 실패:', err);
    }
}

// ==================== 항공사 매핑 (main.js 전용) ====================

/**
 * 호출부호 접두어 → 항공사명 매핑
 * @description 호출부호의 알파벳 부분을 추출하여 항공사명으로 변환
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
 * @param {string} callsign - 항공기 호출부호 (예: 'KAL123', 'AAR456')
 * @returns {string} 항공사명 또는 접두어 (매핑 없을 시)
 * @example
 * getAirlineName('KAL123') // '대한항공'
 * getAirlineName('ABC999') // 'ABC' (매핑 없는 경우)
 */
function getAirlineName(callsign) {
    if (!callsign) return '-';
    const prefix = callsign.replace(/[0-9]/g, ''); // 숫자 제거하여 접두어 추출
    return AIRLINE_MAP[prefix] || prefix;
}

// ==================== 위험도 평가 로직 ====================

/**
 * 유사도 등급 판정 (SIMILARITY 기준)
 * @param {number} similarity - 유사도 점수
 * @returns {Object} 등급 텍스트 및 CSS 클래스 { text, tag }
 */
function getSimilarityLevel(similarity) {
    if (similarity > 2) return { text: '매우높음', tag: 'tag-danger' };
    if (similarity > 1) return { text: '높음', tag: 'tag-warning' };
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
        if (d.SIMILARITY > 2) return levels.includes('critical');
        if (d.SIMILARITY > 1) return levels.includes('caution');
        return levels.includes('monitor');
    });
}

/**
 * 오류가능성 판정 (SCORE_PEAK 기준)
 * @param {number} scorePeak - 오류 가능성 점수
 * @returns {Object} 등급 텍스트 및 CSS 클래스 { text, tag }
 */
function getRiskLevel(scorePeak) {
    if (scorePeak >= 40) return { text: '매우높음', tag: 'tag-danger' };
    if (scorePeak >= 20) return { text: '높음', tag: 'tag-warning' };
    return { text: '낮음', tag: 'tag-info' };
}

/**
 * 권고사항 판정 (유사도와 오류가능성 종합 평가)
 * @param {number} similarity - 유사도 점수
 * @param {number} scorePeak - 오류가능성 점수
 * @returns {Object} 권고사항 텍스트 및 CSS 클래스 { text, tag }
 */
function getAction(similarity, scorePeak) {
    if (similarity > 2 || scorePeak >= 40) return { text: '즉시조치', tag: 'tag-danger' };
    if (similarity > 1 || scorePeak >= 20) return { text: '주의관찰', tag: 'tag-warning' };
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
    if (data.SIMILARITY > 2) {
        riskClass = 'high-risk';
    } else if (data.SIMILARITY > 1) {
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
        let url;
        if (currentSector === 'ALL') {
            // 환경설정에서 선택한 섹터만 조회 (미설정 시 고정 섹터 전체)
            const activeSectors = SERVER_CONFIG.displaySectors.length > 0
                ? SERVER_CONFIG.displaySectors
                : FIXED_SECTORS;
            url = `/api/callsigns?sectors=${activeSectors.join(',')}`;
        } else {
            url = `/api/callsigns?sector=${currentSector}`;
        }

        const response = await fetchWithRetry(url);
        const result = await response.json();

        if (result.success) {
            GLOBAL_DATA = filterBySimilarity(result.data);
            renderTable();
            updateNetworkStatus(true);
            document.getElementById('last-update').textContent = new Date().toISOString().split('T')[1].split('.')[0];
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('데이터 로드 실패 (재시도 후):', err);
        updateNetworkStatus(false);
    }
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
 * @param {Array} sectors - 섹터별 건수 데이터 [{ CCP, CNT }, ...]
 */
function renderSectors() {
    const container = document.getElementById('sector-list');
    let totalCount = 0;
    let highRiskCount = 0;

    // GLOBAL_DATA(유사도 필터 적용 완료)에서 섹터별 건수 재계산
    const filteredCounts = {};
    GLOBAL_DATA.forEach(d => {
        const ccp = String(d.CCP);
        filteredCounts[ccp] = (filteredCounts[ccp] || 0) + 1;
        if (d.SIMILARITY > 2) highRiskCount++;
    });

    // 환경설정에서 선택한 섹터만 표시 (미설정 시 고정 섹터 전체)
    const activeSectors = SERVER_CONFIG.displaySectors.length > 0
        ? SERVER_CONFIG.displaySectors
        : FIXED_SECTORS;
    const displayList = activeSectors.map(ccp => {
        return { CCP: ccp, CNT: filteredCounts[String(ccp)] || 0 };
    });

    const html = displayList.map(s => {
        totalCount += s.CNT;
        const isEmpty = s.CNT === 0;
        const isActive = currentSector == s.CCP;
        return `
            <div class="sector-badge ${isActive ? 'active' : ''} ${isEmpty ? 'dimmed' : ''}" onclick="filterBySector('${s.CCP}')">
                <span class="sector-name">${getSectorName(s.CCP)}</span>
                <span class="sector-count">${s.CNT} 건</span>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
    document.getElementById('total-alerts').textContent = totalCount;
    document.getElementById('high-risk-count').textContent = highRiskCount;

    // 섹터별 검출 건수 요약 (세로 리스트)
    const summaryHtml = displayList
        .map(s => {
            const name = getSectorName(s.CCP);
            const cnt = s.CNT;
            const hasData = cnt > 0;
            return `<div class="sector-summary-row${hasData ? ' has-data' : ''}">
                <span class="sector-summary-name">${name}</span>
                <span class="sector-summary-cnt">${cnt}</span>
            </div>`;
        })
        .join('');
    document.getElementById('sector-summary').innerHTML = summaryHtml;
}

/**
 * 테이블 렌더링
 * @description GLOBAL_DATA를 기반으로 유사호출부호 목록 테이블 생성
 *              공통 평가 함수(calculateRiskAssessment) 사용으로 중복 로직 제거
 */
function renderTable() {
    const tbody = document.getElementById('callsign-tbody');

    if (GLOBAL_DATA.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">데이터 없음</td></tr>';
        return;
    }

    const html = GLOBAL_DATA.slice(0, SERVER_CONFIG.maxRows).map(d => {
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
                    <button class="btn btn-sm btn-primary" style="white-space: nowrap;">보고</button>
                </td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = html;
}

// 섹터 필터
function filterBySector(sector) {
    currentSector = sector;
    localStorage.setItem('selectedSector', sector); // 선택한 섹터 저장
    loadData();
    loadSectors();
}

/**
 * 보고 모달 열기
 * @param {number} idx - 유사호출부호 IDX
 * @param {string} fp1 - 첫 번째 호출부호 (선택사항, 없으면 GLOBAL_DATA에서 조회)
 * @param {string} fp2 - 두 번째 호출부호 (선택사항, 없으면 GLOBAL_DATA에서 조회)
 */
function openReportModal(idx, fp1, fp2) {
    // IDX로 데이터 조회 (fp1, fp2가 없는 경우 대비)
    const item = GLOBAL_DATA.find(d => d.IDX === idx);
    if (!item) {
        console.error('해당 IDX의 데이터를 찾을 수 없습니다:', idx);
        return;
    }

    // 호출부호 설정 (인자가 없으면 item에서 추출)
    const callsign1 = fp1 || item.FP1_CALLSIGN;
    const callsign2 = fp2 || item.FP2_CALLSIGN;

    document.getElementById('reportIdx').value = idx;
    document.getElementById('reportCallsign').value = `${callsign1} | ${callsign2}`;
    document.getElementById('reportDateTime').value = new Date().toISOString().slice(0, 16);

    // 오류 항공기 드롭다운에 실제 호출부호 표시
    const aoSelect = document.getElementById('reportAO');
    aoSelect.innerHTML = `
        <option value="">선택하세요</option>
        <option value="1">${escapeHtml(callsign1)}</option>
        <option value="2">${escapeHtml(callsign2)}</option>
        <option value="3">양쪽 모두</option>
    `;
    aoSelect.value = '';
    document.getElementById('reportType').value = '';
    document.getElementById('safetyImpact').value = '';
    document.getElementById('reportRemark').value = '';

    // 보고자 초기화
    renderReporterSelect();
    document.getElementById('reporterInput').value = '';

    // 검출 정보 표시 (공통 평가 함수 사용)
    const detInfo = document.getElementById('detectionInfo');
    const assessment = calculateRiskAssessment(item);

    document.getElementById('det-callsign').textContent = `${item.FP1_CALLSIGN} | ${item.FP2_CALLSIGN}`;
    document.getElementById('det-airline').textContent = assessment.airlineText;
    document.getElementById('det-sector').textContent = getSectorName(item.CCP);
    document.getElementById('det-similarity').innerHTML = `<span class="tag ${assessment.similarity.tag}">${assessment.similarity.text}</span>`;
    document.getElementById('det-risk').innerHTML = `<span class="tag ${assessment.risk.tag}">${assessment.risk.text}</span>`;
    document.getElementById('det-action').innerHTML = `<span class="tag ${assessment.action.tag}">${assessment.action.text}</span>`;
    detInfo.style.display = 'block';

    document.getElementById('reportModal').classList.add('active');
}

// 모달 닫기
function closeModal() {
    document.getElementById('reportModal').classList.remove('active');
}

// 보고서 제출
async function submitReport() {
    const reporter = getReporterValue();
    const ao = document.getElementById('reportAO').value;
    const errorType = document.getElementById('reportType').value;
    const impact = document.getElementById('safetyImpact').value;

    if (!reporter) {
        alert('보고자를 선택하거나 입력하세요.');
        return;
    }
    if (!ao) { alert('오류 항공기를 선택하세요.'); return; }
    if (!errorType) { alert('오류 유형을 선택하세요.'); return; }
    if (!impact) { alert('안전 영향도를 선택하세요.'); return; }

    const data = {
        idx: parseInt(document.getElementById('reportIdx').value, 10),
        reported: document.getElementById('reportDateTime').value.replace('T', ' '),
        reporter: reporter,
        ao: parseInt(ao, 10),
        type: parseInt(errorType, 10),
        typeDetail: parseInt(impact, 10),
        remark: document.getElementById('reportRemark').value.trim() || '-'
    };

    try {
        const response = await fetch('/api/reports', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            alert('보고가 정상적으로 접수되었습니다.');
            closeModal();
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('보고서 저장 실패:', err);
        alert('보고 제출 실패: ' + err.message);
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

// ==================== 시간대별 검출 차트 ====================

// 시간대별 검출 건수 로드 및 차트 렌더링
async function loadHourlyStats() {
    try {
        const response = await fetch('/api/hourly-stats');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            renderHourlyChart(result.data);
        }
    } catch (err) {
        console.error('시간대별 통계 조회 실패:', err);
    }
}

// 바 차트 렌더링
function renderHourlyChart(data) {
    const container = document.getElementById('hourly-chart');
    const totalEl = document.getElementById('hourly-total');
    const peakEl = document.getElementById('hourly-peak');

    // 총 건수 표시
    totalEl.textContent = `${data.total.toLocaleString()}건`;

    // 최대값 찾기 (차트 높이 계산용)
    const maxCount = Math.max(...data.hourly, 1);

    // 피크 시간대 찾기
    let peakHour = 0;
    let peakCount = 0;
    data.hourly.forEach((cnt, hour) => {
        if (cnt > peakCount) {
            peakCount = cnt;
            peakHour = hour;
        }
    });

    // 피크 시간대 표시
    if (peakCount > 0) {
        peakEl.innerHTML = `피크: <span style="color: var(--accent-danger); font-weight: 700;">${String(peakHour).padStart(2, '0')}:00</span> (${peakCount}건)`;
    } else {
        peakEl.textContent = '피크: 데이터 없음';
    }

    // Y축 라벨 생성
    const yaxis = document.getElementById('hourly-yaxis');
    const yMax = maxCount <= 1 ? 4 : Math.ceil(maxCount / 5) * 5;
    const yStep = Math.max(Math.ceil(yMax / 4), 1);
    const yLabels = [];
    for (let i = 4; i >= 0; i--) {
        yLabels.push(yStep * i);
    }
    yaxis.innerHTML = yLabels.map(v => `<span>${v}</span>`).join('');

    // 바 차트 생성 (Y축 최대값 기준)
    const barsHtml = data.hourly.map((cnt, hour) => {
        const heightPercent = yMax > 0 ? (cnt / yMax) * 100 : 0;
        const isPeak = cnt === peakCount && cnt > 0;
        const tooltip = `${String(hour).padStart(2, '0')}:00 - ${cnt}건`;

        const barHeight = cnt === 0 ? 0 : Math.max(heightPercent, 4);
        return `<div class="hourly-bar ${isPeak ? 'peak' : ''}${cnt === 0 ? ' empty' : ''}"
                     style="height: ${barHeight}%;"
                     data-tooltip="${tooltip}"></div>`;
    }).join('');

    container.innerHTML = barsHtml;
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
        const oldRate = SERVER_CONFIG.refreshRate;
        await loadServerConfig(); // 설정 변경 감지

        // refreshRate가 변경되면 interval 재생성
        if (SERVER_CONFIG.refreshRate !== oldRate) {
            console.log(`갱신 주기 변경: ${oldRate}ms → ${SERVER_CONFIG.refreshRate}ms`);
            startAutoRefresh();
            return; // 현재 interval 종료, 새 interval이 데이터 로드
        }

        loadData();
        loadSectors();
        loadHourlyStats();
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

        await loadData();
        await loadSectors();
        await loadReporters();
        await loadHourlyStats();

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

// 페이지 로드 시 초기화
window.onload = init;
