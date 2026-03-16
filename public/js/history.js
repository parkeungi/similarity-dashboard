/**
 * ==================== 검출 이력 화면 (history.js) ====================
 *
 * @description 유사호출부호 검출 이력 조회 및 통계 화면 전용 JavaScript.
 *              Oracle DB의 T_SIMILAR_CALLSIGN_PAIR 테이블에서 기간/섹터/위험도/상태별
 *              이력 데이터를 페이지네이션으로 조회하고, 일별 추이 차트와 통계 카드를 렌더링.
 *
 * @requires common.js - SECTOR_MAP, FIXED_SECTORS, getSectorName, escapeHtml,
 *                       updateClock, updateNetworkStatus 전역 함수/상수
 * @requires xlsx.full.min.js - Excel 내보내기 (SheetJS 로컬 번들)
 *
 * @author 한국공항공사 시스템정보부
 * @version 1.0
 */

// ==================== 전역 상태 ====================

/**
 * 현재 페이지에 표시 중인 검출 이력 데이터
 * @type {Array<Object>}
 */
let HISTORY_DATA = [];

/**
 * 요약 통계 데이터 (통계 카드 및 차트에 사용)
 * @type {Object|null}
 */
let SUMMARY_DATA = null;

/**
 * 페이지네이션 메타 정보 (API 응답에서 분리 저장)
 * @type {{ page: number, pageSize: number, totalCount: number, totalPages: number }|null}
 */
let PAGINATION_META = null;

/**
 * 현재 페이지 번호 (1-based)
 * @type {number}
 */
let currentPage = 1;

/**
 * 페이지당 표시 건수
 * @constant {number}
 */
const PAGE_SIZE = 50;

/**
 * 차트가 이미 렌더링되었는지 여부 (중복 렌더링 방지)
 * @type {boolean}
 */
let chartRendered = false;

// ==================== 초기화 ====================

/**
 * 페이지 초기화 함수 - window.onload 시 호출
 *
 * @description 날짜 필터를 오늘로 설정하고, 섹터 드롭다운을 구성한 뒤
 *              이력 데이터와 요약 통계를 병렬로 조회.
 *              로더 오버레이는 두 요청이 모두 완료된 후 숨김 처리.
 * @returns {Promise<void>}
 */
async function init() {
    try {
        // 설정값(섹터맵/위험도 기준) 선반영
        await loadViewConfig();

        setDatePreset('today');

        // 섹터 드롭다운 구성 (고정 섹터 목록 기반)
        loadSectorOptions();

        // 데이터 로드 (병렬 실행으로 초기 로딩 시간 단축)
        await Promise.all([
            loadData(),
            loadSummary()
        ]);

        // 테이블 행 클릭 이벤트 위임 (tbody에 1회만 등록)
        document.getElementById('history-tbody').addEventListener('click', function(e) {
            const tr = e.target.closest('tr[data-index]');
            if (!tr) return;
            showDetail(parseInt(tr.dataset.index, 10));
        });

        // Enter 키로 필터 적용 (검색 UX 개선)
        document.querySelectorAll('#filter-from, #filter-to, #filter-sector, #filter-risk, #filter-status')
            .forEach(el => {
                el.addEventListener('keydown', (e) => {
                    if (e.key === 'Enter') applyFilter();
                });
            });

    } catch (err) {
        console.error('초기화 실패:', err);
        updateNetworkStatus(false);
    } finally {
        // 성공/실패 여부와 무관하게 로더 숨김
        const loader = document.getElementById('loader');
        if (loader) loader.style.display = 'none';
    }
}

/**
 * 화면 설정 로드 (섹터맵/위험도 기준)
 * @returns {Promise<void>}
 */
async function loadViewConfig() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) return;
        const result = await response.json();
        if (!result.success || !result.data) return;

        if (result.data.sectorMap && Object.keys(result.data.sectorMap).length > 0) {
            updateSectorConfig(result.data.sectorMap, result.data.fixedSectors || []);
        }
        updateRiskThresholds(result.data.thresholds || getRiskThresholds());
    } catch (err) {
        console.error('화면 설정 로드 실패:', err);
    }
}

/**
 * 섹터 필터 드롭다운 옵션 생성
 *
 * @description FIXED_SECTORS 배열 기반으로 섹터 선택 옵션 구성.
 *              '전체' 옵션이 기본값으로 포함됨.
 */
function loadSectorOptions() {
    const select = document.getElementById('filter-sector');
    select.innerHTML = '<option value="ALL">전체</option>';

    FIXED_SECTORS.forEach(ccp => {
        const option = document.createElement('option');
        option.value = ccp;
        option.textContent = getSectorName(ccp);
        select.appendChild(option);
    });
}

// ==================== 데이터 로드 ====================

/**
 * 검출 이력 목록 조회
 *
 * @description 현재 필터 조건과 페이지 정보를 쿼리 파라미터로 조합하여
 *              /api/history 엔드포인트를 호출. 응답 데이터를 HISTORY_DATA에 저장하고
 *              테이블과 페이지네이션을 갱신.
 * @returns {Promise<void>}
 */
async function loadData() {
    try {
        const url = buildDataUrl();
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            HISTORY_DATA = result.data || [];
            PAGINATION_META = result.pagination || null;
            renderTable();
            renderPagination();
            updateNetworkStatus(true);
        } else {
            throw new Error(result.error || '데이터 조회 실패');
        }
    } catch (err) {
        console.error('검출 이력 로드 실패:', err);
        updateNetworkStatus(false);

        // 오류 발생 시 테이블에 안내 메시지 표시
        const tbody = document.getElementById('history-tbody');
        if (tbody) {
            tbody.innerHTML = '<tr><td colspan="8" class="empty-state" style="color: var(--accent-danger);">데이터 로드 실패 - 서버 연결을 확인하세요</td></tr>';
        }
    }
}

/**
 * 요약 통계 조회
 *
 * @description 날짜/섹터 필터 기준의 집계 데이터를 /api/history/summary 에서 조회.
 *              통계 카드와 일별 추이 차트에 사용.
 *              페이지 변경 시에는 호출하지 않음 (필터 변경 시에만 갱신).
 * @returns {Promise<void>}
 */
async function loadSummary() {
    try {
        const url = buildSummaryUrl();
        const response = await fetch(url);

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();

        if (result.success) {
            SUMMARY_DATA = result.data || null;
            renderStats();

            // 차트 섹션이 표시 중이면 즉시 갱신
            const chartSection = document.getElementById('chart-section');
            if (chartSection && chartSection.style.display !== 'none') {
                chartRendered = false; // 강제 재렌더링
                renderChart();
            } else {
                chartRendered = false; // 다음 toggleChart() 시 재렌더링
            }
        } else {
            throw new Error(result.error || '통계 조회 실패');
        }
    } catch (err) {
        console.error('요약 통계 로드 실패:', err);
        updateNetworkStatus(false);
    }
}

/**
 * 이력 데이터 조회 URL 생성
 *
 * @description 필터 입력값과 페이지 정보를 쿼리 파라미터로 조합.
 *              빈 값이나 'ALL' 섹터는 파라미터에서 제외.
 * @returns {string} 완성된 API 요청 URL
 */
function buildDataUrl() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    const sector = document.getElementById('filter-sector').value;
    const risk = document.getElementById('filter-risk').value;
    const status = document.getElementById('filter-status').value;

    const params = [];
    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    if (sector && sector !== 'ALL') params.push(`sector=${encodeURIComponent(sector)}`);
    if (risk) params.push(`risk=${encodeURIComponent(risk)}`);
    if (status) params.push(`status=${encodeURIComponent(status)}`);
    params.push(`page=${currentPage}`);
    params.push(`pageSize=${PAGE_SIZE}`);

    return '/api/history?' + params.join('&');
}

/**
 * 요약 통계 조회 URL 생성
 *
 * @description 날짜/섹터 필터만 포함 (위험도/상태 필터는 미포함 - 전체 통계 기준).
 * @returns {string} 완성된 API 요청 URL
 */
function buildSummaryUrl() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    const sector = document.getElementById('filter-sector').value;

    const params = [];
    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    if (sector && sector !== 'ALL') params.push(`sector=${encodeURIComponent(sector)}`);

    return '/api/history/summary?' + params.join('&');
}

// ==================== 통계 카드 렌더링 ====================

/**
 * 통계 카드 UI 갱신
 *
 * @description SUMMARY_DATA의 집계값을 각 stat 카드 요소에 반영.
 *              숫자는 toLocaleString()으로 천단위 구분자 적용.
 */
function renderStats() {
    if (!SUMMARY_DATA) return;

    const safeNum = (val) => (Number(val) || 0).toLocaleString();

    document.getElementById('stat-total').textContent = safeNum(SUMMARY_DATA.totalCount);
    document.getElementById('stat-danger').textContent = safeNum(SUMMARY_DATA.byRisk?.DANGER_CNT);
    document.getElementById('stat-warning').textContent = safeNum(SUMMARY_DATA.byRisk?.WARNING_CNT);
    document.getElementById('stat-info').textContent = safeNum(SUMMARY_DATA.byRisk?.INFO_CNT);
    document.getElementById('stat-active').textContent = safeNum(SUMMARY_DATA.activeCount);
    document.getElementById('stat-cleared').textContent = safeNum(SUMMARY_DATA.clearedCount);
}

// ==================== 테이블 렌더링 ====================

/**
 * 유사도 값에 대한 표시 정보
 * @param {number} similarity
 * @returns {{rowClass: string, tagHtml: string}}
 */
function getSimilarityDisplay(similarity) {
    const band = getSimilarityBand(similarity);
    if (band === 'critical') {
        return { rowClass: 'high-risk', tagHtml: '<span class="tag tag-danger">매우높음</span>' };
    }
    if (band === 'caution') {
        return { rowClass: 'med-risk', tagHtml: '<span class="tag tag-warning">높음</span>' };
    }
    return { rowClass: '', tagHtml: '<span class="tag tag-info">보통</span>' };
}

/**
 * 오류가능성 값에 대한 표시 태그
 * @param {number} scoreVal
 * @returns {string}
 */
function getScoreTag(scoreVal) {
    const band = getScoreBand(scoreVal);
    if (band === 'critical') return `<span class="tag tag-danger">${scoreVal}%</span>`;
    if (band === 'caution') return `<span class="tag tag-warning">${scoreVal}%</span>`;
    return `<span class="tag tag-info">${scoreVal}%</span>`;
}

/**
 * 권고사항 HTML 생성
 * @param {number} similarity
 * @param {number} scoreVal
 * @returns {string}
 */
function getRecommendationHtml(similarity, scoreVal) {
    const band = getRecommendationBand(similarity, scoreVal);
    if (band === 'critical') {
        return '<span style="color: var(--accent-danger); font-weight:700;">즉시조치</span>';
    }
    if (band === 'caution') {
        return '<span style="color: var(--accent-warning);">주의관찰</span>';
    }
    return '<span style="color: var(--text-muted);">정상감시</span>';
}

/**
 * 검출 이력 테이블 렌더링
 *
 * @description HISTORY_DATA를 HTML 테이블 행으로 변환.
 *              위험도(SIMILARITY)와 오류가능성(SCORE_PEAK) 기준으로 태그를 생성하고
 *              권고사항을 3단계로 표시. 행 클릭 시 showDetail() 호출.
 *              데이터가 없으면 빈 상태 안내 메시지 표시.
 */
function renderTable() {
    const tbody = document.getElementById('history-tbody');
    const countEl = document.getElementById('data-count');

    // 총 건수는 페이지네이션 메타의 totalCount 우선, 없으면 현재 페이지 건수
    const totalCount = PAGINATION_META ? PAGINATION_META.totalCount : HISTORY_DATA.length;
    if (countEl) countEl.textContent = totalCount.toLocaleString();

    if (HISTORY_DATA.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">검출 이력이 없습니다</td></tr>';
        return;
    }

    const rows = HISTORY_DATA.map((d, index) => {
        // 활성/해제 상태 판단 (CLEARED가 최대값이면 아직 활성 중)
        const isActive = d.CLEARED === '9999-12-31 23:59:59';

        // 위험도 등급 (SIMILARITY 기준) - 행 배경색 적용용
        const similarityDisplay = getSimilarityDisplay(d.SIMILARITY);
        const riskClass = similarityDisplay.rowClass;
        const riskTag = similarityDisplay.tagHtml;

        // 권고사항 (유사도와 오류가능성 종합 판단)
        const scoreVal = d.SCORE_PEAK || 0;
        const recommendation = getRecommendationHtml(d.SIMILARITY, scoreVal);

        // 시각 표시: DETECTED/CLEARED를 'MM-DD HH:MM' 형태로 단축
        const detectedStr = formatDateShort(d.DETECTED);
        const clearedStr = isActive
            ? '<span style="color: var(--accent-secondary); font-size: 11px;">활성</span>'
            : formatDateShort(d.CLEARED);

        // 항공사명
        const airline1 = getAirlineName(d.FP1_CALLSIGN);
        const airline2 = getAirlineName(d.FP2_CALLSIGN);
        const airlineText = airline1 === airline2 ? airline1 : airline1 + ' / ' + airline2;

        // 동시관제량
        const ctrlPeak = d.CTRL_PEAK != null ? d.CTRL_PEAK : '-';

        // 공존시간(분)
        let coexistMin = '-';
        if (!isActive && d.DETECTED && d.CLEARED) {
            const dt = new Date(d.DETECTED.replace(' ', 'T'));
            const ct = new Date(d.CLEARED.replace(' ', 'T'));
            if (!isNaN(dt) && !isNaN(ct)) coexistMin = Math.round((ct - dt) / 60000);
        }

        // 경로 (FP1 출발→도착)
        const route = (d.FP1_DEPT && d.FP1_DEST) ? d.FP1_DEPT + '→' + d.FP1_DEST : '-';

        // 보고 여부
        const reportBadge = d.HAS_REPORT === 1
            ? '<span style="color: var(--accent-secondary);">O</span>'
            : '<span style="color: var(--text-muted);">-</span>';

        return `
            <tr class="${riskClass}" style="cursor: pointer;" data-index="${index}">
                <td style="font-size: 12px; white-space: nowrap;">${detectedStr}</td>
                <td style="font-size: 12px; white-space: nowrap;">${clearedStr}</td>
                <td style="color: var(--accent-primary);">${escapeHtml(getSectorName(d.CCP))}</td>
                <td>
                    <div class="callsign-box">
                        <span class="callsign-main">${escapeHtml(d.FP1_CALLSIGN) || '-'}</span>
                        <span class="vs">vs</span>
                        <span class="callsign-main">${escapeHtml(d.FP2_CALLSIGN) || '-'}</span>
                    </div>
                </td>
                <td style="font-size: 12px;">${escapeHtml(airlineText)}</td>
                <td>${riskTag}</td>
                <td style="text-align: center;">${ctrlPeak}</td>
                <td style="text-align: center;">${coexistMin}${coexistMin !== '-' ? '분' : ''}</td>
                <td style="font-size: 11px; white-space: nowrap;">${escapeHtml(route)}</td>
                <td>${recommendation}</td>
                <td style="text-align: center;">${reportBadge}</td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = rows;
}

/**
 * 날짜 문자열을 'MM-DD HH:MM' 형식으로 단축
 *
 * @description Oracle TIMESTAMP 또는 ISO 형식 문자열에서
 *              'MM-DD HH:MM' 형태의 간략 표현을 추출.
 *              형식이 맞지 않으면 원본 문자열 반환.
 * @param {string|null} dateStr - Oracle DB에서 반환된 날짜 문자열
 * @returns {string} 단축 날짜 문자열 또는 '-'
 * @example
 * formatDateShort('2025-03-15 14:30:00') // '03-15 14:30'
 */
function formatDateShort(dateStr) {
    if (!dateStr) return '-';
    const str = String(dateStr);
    // 'YYYY-MM-DD HH:MM:SS' 형식에서 'MM-DD HH:MM' 추출
    // ISO 형식('YYYY-MM-DDTHH:MM:SS') 포함 처리
    const normalized = str.replace('T', ' ');
    if (normalized.length >= 16) {
        return normalized.slice(5, 16); // 'MM-DD HH:MM'
    }
    return escapeHtml(str);
}

// ==================== 페이지네이션 ====================

/**
 * 페이지네이션 UI 렌더링
 *
 * @description PAGINATION_META를 기반으로 이전/다음 버튼과 페이지 번호 버튼 생성.
 *              현재 페이지 주변 최대 7개의 버튼을 표시하고, 범위를 벗어나면 말줄임(...) 사용.
 *              총 페이지가 1이하면 페이지네이션을 숨김.
 */
function renderPagination() {
    const container = document.getElementById('pagination');
    if (!container) return;

    // 페이지 메타가 없거나 단일 페이지면 숨김
    if (!PAGINATION_META || PAGINATION_META.totalPages <= 1) {
        container.innerHTML = '';
        return;
    }

    const { page, totalPages, totalCount } = PAGINATION_META;
    const parts = [];

    // 이전 버튼
    parts.push(
        `<button class="btn btn-ghost btn-sm" onclick="goToPage(${page - 1})" ${page === 1 ? 'disabled' : ''}>&laquo; 이전</button>`
    );

    // 페이지 번호 버튼 (최대 7개, 말줄임 포함)
    const pageButtons = buildPageButtons(page, totalPages);
    parts.push(...pageButtons);

    // 다음 버튼
    parts.push(
        `<button class="btn btn-ghost btn-sm" onclick="goToPage(${page + 1})" ${page === totalPages ? 'disabled' : ''}>다음 &raquo;</button>`
    );

    // 페이지 정보 텍스트
    parts.push(
        `<span style="color: var(--text-muted); font-size: 12px; margin-left: 8px;">${page.toLocaleString()} / ${totalPages.toLocaleString()} 페이지 &nbsp;(전체 ${totalCount.toLocaleString()}건)</span>`
    );

    container.innerHTML = parts.join('');
}

/**
 * 페이지 번호 버튼 HTML 배열 생성
 *
 * @description 현재 페이지를 중심으로 앞뒤 2개씩 최대 5개 버튼 표시.
 *              처음/끝 페이지와 간격이 있으면 말줄임(...) 삽입.
 * @param {number} current - 현재 페이지 번호
 * @param {number} total - 전체 페이지 수
 * @returns {string[]} 버튼 HTML 문자열 배열
 */
function buildPageButtons(current, total) {
    const buttons = [];

    // 표시할 페이지 번호 범위 계산 (현재 ±2, 최대 5개)
    let startPage = Math.max(1, current - 2);
    let endPage = Math.min(total, current + 2);

    // 5개 미만이면 범위 확장
    if (endPage - startPage < 4) {
        if (startPage === 1) {
            endPage = Math.min(total, startPage + 4);
        } else {
            startPage = Math.max(1, endPage - 4);
        }
    }

    // 첫 페이지와 간격이 있으면 "1 ..." 추가
    if (startPage > 1) {
        buttons.push(`<button class="btn btn-ghost btn-sm" onclick="goToPage(1)">1</button>`);
        if (startPage > 2) {
            buttons.push(`<span style="color: var(--text-muted); align-self: center;">...</span>`);
        }
    }

    // 핵심 페이지 번호 버튼들
    for (let p = startPage; p <= endPage; p++) {
        const isActive = p === current;
        buttons.push(
            `<button class="btn ${isActive ? 'btn-primary' : 'btn-ghost'} btn-sm" onclick="goToPage(${p})">${p}</button>`
        );
    }

    // 마지막 페이지와 간격이 있으면 "... N" 추가
    if (endPage < total) {
        if (endPage < total - 1) {
            buttons.push(`<span style="color: var(--text-muted); align-self: center;">...</span>`);
        }
        buttons.push(`<button class="btn btn-ghost btn-sm" onclick="goToPage(${total})">${total}</button>`);
    }

    return buttons;
}

/**
 * 특정 페이지로 이동
 *
 * @description currentPage를 갱신하고 이력 데이터만 새로 조회.
 *              요약 통계(loadSummary)는 페이지 이동 시 재조회하지 않음 - 필터 변경 시에만 갱신.
 * @param {number} page - 이동할 페이지 번호
 */
function goToPage(page) {
    if (!PAGINATION_META) return;
    if (page < 1 || page > PAGINATION_META.totalPages) return;
    if (page === currentPage) return;

    currentPage = page;
    loadData();

    // 테이블 최상단으로 스크롤
    const tableEl = document.getElementById('history-table');
    if (tableEl) {
        tableEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
}

// ==================== 일별 추이 차트 ====================

/**
 * 일별 검출 추이 차트 토글
 *
 * @description chart-section의 표시/숨김을 전환.
 *              처음 표시할 때(chartRendered === false)만 renderChart() 호출.
 */
function toggleChart() {
    const section = document.getElementById('chart-section');
    if (!section) return;

    if (section.style.display === 'none') {
        section.style.display = 'block';
        if (!chartRendered) {
            renderChart();
        }
    } else {
        section.style.display = 'none';
    }
}

/**
 * 일별 검출 추이 차트 렌더링 (div 기반 막대 차트)
 *
 * @description SUMMARY_DATA.byDate 배열을 사용하여 날짜별 검출 건수를 막대로 표시.
 *              최근 31일 데이터만 사용. 관리자 화면의 월별 차트와 동일한 CSS 클래스 활용.
 *              각 막대에 data-tooltip 속성으로 호버 정보 제공.
 */
function renderChart() {
    const chartContainer = document.getElementById('daily-chart');
    const labelsContainer = document.getElementById('daily-labels');

    if (!chartContainer || !labelsContainer) return;

    // 데이터 없음 처리
    if (!SUMMARY_DATA || !SUMMARY_DATA.byDate || SUMMARY_DATA.byDate.length === 0) {
        chartContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; width: 100%;">데이터 없음</div>';
        labelsContainer.innerHTML = '';
        chartRendered = true;
        return;
    }

    // 최근 31일 데이터로 제한 (오래된 데이터는 차트에서 제외)
    const byDate = SUMMARY_DATA.byDate.slice(-31);

    // 최대 건수 계산 (막대 높이 비율 기준, 최소 1 보장)
    const maxCnt = Math.max(...byDate.map(d => Number(d.CNT) || 0), 1);

    // 오늘 날짜 (강조 표시용, 로컬 시간 기준)
    const nowLocal = new Date();
    const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}`;

    // 막대 HTML 생성
    const barsHtml = byDate.map(d => {
        const cnt = Number(d.CNT) || 0;
        const dateStr = String(d.DETECT_DATE || '');
        // 최소 높이 3% (0건이면 0%, 1건 이상이면 최소 3%)
        const heightPct = cnt === 0 ? 0 : Math.max((cnt / maxCnt) * 100, 3);
        const isToday = dateStr === today;
        const tooltip = `${dateStr}: ${cnt}건`;

        return `
            <div class="monthly-bar ${isToday ? 'highlight' : ''}"
                 style="height: ${heightPct}%;"
                 data-tooltip="${escapeHtml(tooltip)}">
                ${cnt > 0 ? `<span class="monthly-bar-value">${cnt}</span>` : ''}
            </div>
        `;
    }).join('');

    // 날짜 라벨 HTML 생성 ('MM-DD' 형식)
    const labelsHtml = byDate.map(d => {
        const dateStr = String(d.DETECT_DATE || '');
        // 'YYYY-MM-DD' → 'MM-DD'
        const label = dateStr.length >= 10 ? dateStr.slice(5, 10) : escapeHtml(dateStr);
        return `<span>${label}</span>`;
    }).join('');

    chartContainer.innerHTML = barsHtml;
    labelsContainer.innerHTML = labelsHtml;
    chartRendered = true;
}

// ==================== 상세 보기 모달 ====================

/**
 * 검출 이력 상세 정보 모달 표시
 *
 * @description HISTORY_DATA[index]의 전체 필드를 2열 그리드 레이아웃으로 표시.
 *              FP1/FP2 항공편 정보를 나란히 비교 표시하고,
 *              위험도 태그와 권고사항을 색상으로 구분.
 * @param {number} index - HISTORY_DATA 배열 내 인덱스
 */
function showDetail(index) {
    const d = HISTORY_DATA[index];
    if (!d) return;

    const content = document.getElementById('detail-content');
    if (!content) return;

    // 활성/해제 상태
    const isActive = d.CLEARED === '9999-12-31 23:59:59';
    const clearedDisplay = isActive
        ? '<span style="color: var(--accent-secondary); font-weight: 600;">활성 (미해제)</span>'
        : escapeHtml(d.CLEARED || '-');

    // 위험도 태그 (상세 모달에서도 동일 로직 적용)
    const scoreVal = d.SCORE_PEAK || 0;
    const riskTag = getSimilarityDisplay(d.SIMILARITY).tagHtml;

    const scoreTag = getScoreTag(scoreVal);

    const recommendation = getRecommendationHtml(d.SIMILARITY, scoreVal);

    // 보고 여부
    const reportDisplay = d.HAS_REPORT === 1
        ? '<span style="color: var(--accent-secondary); font-weight: 600;">보고됨</span>'
        : '<span style="color: var(--text-muted);">미보고</span>';

    content.innerHTML = `
        <div style="display: grid; gap: 16px;">

            <!-- FP1 vs FP2 항공편 비교 -->
            <div style="display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: stretch;">

                <!-- FP1 -->
                <div style="background: rgba(15,23,42,0.5); padding: 15px; border-radius: 10px; text-align: center; border: 1px solid rgba(14,165,233,0.2);">
                    <div style="font-size: 10px; color: var(--accent-primary); margin-bottom: 6px; font-weight: 600; letter-spacing: 1px;">FP1</div>
                    <div style="font-size: 22px; font-weight: 700; color: #fff; font-family: var(--font-mono); margin-bottom: 10px;">
                        ${escapeHtml(d.FP1_CALLSIGN) || '-'}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">
                        <span style="color: var(--accent-secondary);">${escapeHtml(d.FP1_DEPT) || '-'}</span>
                        <span style="margin: 0 4px; color: var(--text-muted);">&#8594;</span>
                        <span style="color: var(--accent-warning);">${escapeHtml(d.FP1_DEST) || '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted);">
                        EOBT: <span style="color: var(--text-main);">${escapeHtml(d.FP1_EOBT) || '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">
                        고도: <span style="color: var(--text-main);">${escapeHtml(String(d.FP1_ALT || '-'))}</span>
                    </div>
                </div>

                <!-- VS 구분자 -->
                <div style="display: flex; align-items: center; color: var(--text-muted); font-size: 11px; font-weight: 600; padding: 0 4px;">vs</div>

                <!-- FP2 -->
                <div style="background: rgba(15,23,42,0.5); padding: 15px; border-radius: 10px; text-align: center; border: 1px solid rgba(14,165,233,0.2);">
                    <div style="font-size: 10px; color: var(--accent-primary); margin-bottom: 6px; font-weight: 600; letter-spacing: 1px;">FP2</div>
                    <div style="font-size: 22px; font-weight: 700; color: #fff; font-family: var(--font-mono); margin-bottom: 10px;">
                        ${escapeHtml(d.FP2_CALLSIGN) || '-'}
                    </div>
                    <div style="font-size: 12px; color: var(--text-muted); margin-bottom: 6px;">
                        <span style="color: var(--accent-secondary);">${escapeHtml(d.FP2_DEPT) || '-'}</span>
                        <span style="margin: 0 4px; color: var(--text-muted);">&#8594;</span>
                        <span style="color: var(--accent-warning);">${escapeHtml(d.FP2_DEST) || '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted);">
                        EOBT: <span style="color: var(--text-main);">${escapeHtml(d.FP2_EOBT) || '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 3px;">
                        고도: <span style="color: var(--text-main);">${escapeHtml(String(d.FP2_ALT || '-'))}</span>
                    </div>
                </div>
            </div>

            <!-- 검출/해제 시각 및 섹터 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="detail-field">
                    <div class="detail-label">검출시각</div>
                    <div class="detail-value">${escapeHtml(d.DETECTED) || '-'}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">해제시각</div>
                    <div class="detail-value">${clearedDisplay}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">섹터</div>
                    <div class="detail-value" style="color: var(--accent-primary);">${escapeHtml(getSectorName(d.CCP))}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">보고 여부</div>
                    <div class="detail-value">${reportDisplay}</div>
                </div>
            </div>

            <!-- 위험도 지표 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="detail-field">
                    <div class="detail-label">유사도 (SIMILARITY)</div>
                    <div class="detail-value">
                        ${riskTag}
                        <span style="color: var(--text-muted); font-size: 12px; margin-left: 6px;">(${escapeHtml(String(d.SIMILARITY ?? '-'))})</span>
                    </div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">오류가능성 (SCORE_PEAK)</div>
                    <div class="detail-value">${scoreTag}</div>
                </div>
                <div class="detail-field" style="grid-column: 1 / -1;">
                    <div class="detail-label">권고사항</div>
                    <div class="detail-value">${recommendation}</div>
                </div>
            </div>

        </div>
    `;

    document.getElementById('detail-modal').classList.add('active');
}

/**
 * 검출 상세 모달 닫기
 *
 * @description detail-modal에서 'active' 클래스를 제거하여 숨김 처리.
 */
function closeDetailModal() {
    const modal = document.getElementById('detail-modal');
    if (modal) modal.classList.remove('active');
}

// ==================== 필터 조작 ====================

/**
 * 필터 적용 및 데이터 재조회
 *
 * @description 페이지를 1로 초기화하고 이력 데이터와 요약 통계를 동시 재조회.
 *              검색 버튼 클릭 또는 Enter 키 입력 시 호출.
 * @returns {Promise<void>}
 */
async function applyFilter() {
    await loadViewConfig();
    currentPage = 1;
    await Promise.all([loadData(), loadSummary()]);
}

/**
 * 필터 초기화 및 재조회
 *
 * @description 모든 필터를 기본값으로 복원 (날짜: 오늘, 섹터/위험도/상태: 전체).
 *              페이지를 1로 초기화하고 재조회.
 * @returns {Promise<void>}
 */
async function resetFilter() {
    await loadViewConfig();
    setDatePreset('today');
    document.getElementById('filter-sector').value = 'ALL';
    document.getElementById('filter-risk').value = '';
    document.getElementById('filter-status').value = '';

    currentPage = 1;
    await Promise.all([loadData(), loadSummary()]);
}

/**
 * 날짜 프리셋 설정
 * @param {'today'|'week'|'month'|'3month'|'custom'} period
 */
function setDatePreset(period) {
    document.querySelectorAll('.btn-preset').forEach(btn => btn.classList.remove('active'));
    const activeBtn = document.querySelector(`.btn-preset[data-period="${period}"]`);
    if (activeBtn) activeBtn.classList.add('active');

    const dateGroup = document.getElementById('date-range-group');
    const today = new Date();
    const toStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

    if (period === 'custom') {
        dateGroup.style.display = 'flex';
        return;
    }

    dateGroup.style.display = 'none';
    let fromDate = new Date(today);

    switch (period) {
        case 'today': break;
        case 'week': fromDate.setDate(fromDate.getDate() - 7); break;
        case 'month': fromDate.setMonth(fromDate.getMonth() - 1); break;
        case '3month': fromDate.setMonth(fromDate.getMonth() - 3); break;
    }

    const fromStr = `${fromDate.getFullYear()}-${String(fromDate.getMonth()+1).padStart(2,'0')}-${String(fromDate.getDate()).padStart(2,'0')}`;
    document.getElementById('filter-from').value = fromStr;
    document.getElementById('filter-to').value = toStr;
}

// ==================== Excel 내보내기 ====================

/**
 * 현재 페이지의 이력 데이터를 Excel 파일로 저장
 *
 * @description SheetJS(XLSX 전역 객체)를 사용하여 HISTORY_DATA를 .xlsx 파일로 내보냄.
 *              파일명에 현재 날짜를 포함. 폐쇄망 환경이므로 로컬 번들 사용.
 *              데이터가 없으면 알림 후 중단.
 */
function downloadExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
        return;
    }
    if (!HISTORY_DATA || HISTORY_DATA.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 전체 건수보다 현재 페이지 건수가 적으면 사용자에게 안내
    const totalCount = PAGINATION_META ? PAGINATION_META.totalCount : HISTORY_DATA.length;
    if (totalCount > HISTORY_DATA.length) {
        if (!confirm(`현재 페이지의 ${HISTORY_DATA.length}건만 저장됩니다. (전체 ${totalCount.toLocaleString()}건)\n계속하시겠습니까?`)) {
            return;
        }
    }

    // 엑셀 행 데이터 구성 (DB 컬럼 → 한글 헤더 매핑)
    const excelData = HISTORY_DATA.map(d => {
        const isActive = d.CLEARED === '9999-12-31 23:59:59';
        let coexistMin = '';
        if (!isActive && d.DETECTED && d.CLEARED) {
            const dt = new Date(d.DETECTED.replace(' ', 'T'));
            const ct = new Date(d.CLEARED.replace(' ', 'T'));
            if (!isNaN(dt) && !isNaN(ct)) coexistMin = Math.round((ct - dt) / 60000);
        }
        return {
            '검출시각': d.DETECTED || '',
            '해제시각': isActive ? '활성' : (d.CLEARED || ''),
            '섹터': getSectorName(d.CCP),
            '호출부호1': d.FP1_CALLSIGN || '',
            '호출부호2': d.FP2_CALLSIGN || '',
            '항공사': (() => {
                const a1 = getAirlineName(d.FP1_CALLSIGN);
                const a2 = getAirlineName(d.FP2_CALLSIGN);
                return a1 === a2 ? a1 : a1 + ' / ' + a2;
            })(),
            'FP1 출발': d.FP1_DEPT || '',
            'FP1 도착': d.FP1_DEST || '',
            'FP1 EOBT': d.FP1_EOBT || '',
            'FP1 고도': d.FP1_ALT || '',
            'FP2 출발': d.FP2_DEPT || '',
            'FP2 도착': d.FP2_DEST || '',
            'FP2 EOBT': d.FP2_EOBT || '',
            'FP2 고도': d.FP2_ALT || '',
            '유사도': d.SIMILARITY != null ? d.SIMILARITY : '',
            '동시관제량': d.CTRL_PEAK != null ? d.CTRL_PEAK : '',
            '공존시간(분)': coexistMin,
            '권고사항': (() => {
                const band = getRecommendationBand(d.SIMILARITY, d.SCORE_PEAK || 0);
                if (band === 'critical') return '즉시조치';
                if (band === 'caution') return '주의관찰';
                return '정상감시';
            })(),
            '보고여부': d.HAS_REPORT === 1 ? 'O' : '-'
        };
    });

    // SheetJS 시트 및 워크북 생성
    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '검출이력');

    // 컬럼 너비 설정 (헤더 순서와 일치)
    ws['!cols'] = [
        { wch: 20 }, // 검출시각
        { wch: 20 }, // 해제시각
        { wch: 8  }, // 섹터
        { wch: 12 }, // 호출부호1
        { wch: 12 }, // 호출부호2
        { wch: 20 }, // 항공사
        { wch: 8  }, // FP1 출발
        { wch: 8  }, // FP1 도착
        { wch: 10 }, // FP1 EOBT
        { wch: 8  }, // FP1 고도
        { wch: 8  }, // FP2 출발
        { wch: 8  }, // FP2 도착
        { wch: 10 }, // FP2 EOBT
        { wch: 8  }, // FP2 고도
        { wch: 8  }, // 유사도
        { wch: 12 }, // 동시관제량
        { wch: 12 }, // 공존시간(분)
        { wch: 10 }, // 권고사항
        { wch: 8  }  // 보고여부
    ];

    // 파일명: 유사호출부호_검출이력_YYYYMMDD.xlsx
    const now = new Date();
    const dateSuffix = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const filename = `유사호출부호_검출이력_${dateSuffix}.xlsx`;

    XLSX.writeFile(wb, filename);
}

// ==================== 이벤트 리스너 ====================

/**
 * 모달 외부 클릭 시 닫기
 *
 * @description 모달 배경(오버레이) 영역 클릭 시 자동으로 닫힘.
 *              모달 콘텐츠 내부 클릭은 무시.
 */
document.addEventListener('click', (e) => {
    const modal = document.getElementById('detail-modal');
    if (modal && e.target === modal) {
        closeDetailModal();
    }
});

/**
 * ESC 키로 모달 닫기
 *
 * @description 키보드 접근성 향상을 위한 ESC 키 단축키.
 */
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        closeDetailModal();
    }
});

// ==================== 페이지 로드 시 초기화 ====================

window.onload = init;
