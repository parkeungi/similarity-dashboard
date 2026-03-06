// ==================== 전역 변수 ====================

let REPORTS_DATA = [];

// ==================== 코드 매핑 (admin.js 전용) ====================

/**
 * 오류 유형 코드 → 텍스트 매핑
 * @type {Object<number, string>}
 */
let TYPE_MAP = {};

/**
 * 세부오류유형 코드 → 텍스트 매핑 (서버 설정에서 동적 로드)
 * @type {Object<number, string>}
 */
let IMPACT_MAP = {};

/**
 * 오류 항공기 코드 → 텍스트 매핑
 * @type {Object<number, string>}
 */
const AO_MAP = {
    1: 'FP1',
    2: 'FP2',
    3: '양쪽 모두'
};

/**
 * 위험도 기준값 정규화
 * @param {Object} thresholds
 * @returns {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }}
 */
function normalizeThresholds(thresholds) {
    const defaults = getRiskThresholds();
    const simCritical = Number(thresholds?.similarity?.critical);
    const simCaution = Number(thresholds?.similarity?.caution);
    const scoreCritical = Number(thresholds?.scorePeak?.critical);
    const scoreCaution = Number(thresholds?.scorePeak?.caution);

    const normalized = {
        similarity: {
            critical: Number.isFinite(simCritical) ? simCritical : defaults.similarity.critical,
            caution: Number.isFinite(simCaution) ? simCaution : defaults.similarity.caution
        },
        scorePeak: {
            critical: Number.isFinite(scoreCritical) ? scoreCritical : defaults.scorePeak.critical,
            caution: Number.isFinite(scoreCaution) ? scoreCaution : defaults.scorePeak.caution
        }
    };

    if (!(normalized.similarity.critical > normalized.similarity.caution)) {
        normalized.similarity = defaults.similarity;
    }
    if (!(normalized.scorePeak.critical > normalized.scorePeak.caution)) {
        normalized.scorePeak = defaults.scorePeak;
    }
    return normalized;
}

/**
 * 기준값 안내 문구/유사도 체크박스 힌트 업데이트
 * @param {{ similarity: { critical: number, caution: number }, scorePeak: { critical: number, caution: number } }} thresholds
 */
function updateThresholdHints(thresholds) {
    const simCriticalEl = document.getElementById('sim-hint-critical');
    const simCautionEl = document.getElementById('sim-hint-caution');
    const simMonitorEl = document.getElementById('sim-hint-monitor');
    const ruleHintEl = document.getElementById('threshold-rule-hint');

    if (simCriticalEl) simCriticalEl.textContent = `(SIMILARITY > ${thresholds.similarity.critical})`;
    if (simCautionEl) simCautionEl.textContent = `(SIMILARITY > ${thresholds.similarity.caution})`;
    if (simMonitorEl) simMonitorEl.textContent = `(SIMILARITY <= ${thresholds.similarity.caution})`;

    if (ruleHintEl) {
        ruleHintEl.textContent = `권고사항: SIMILARITY > ${thresholds.similarity.critical} 또는 SCORE_PEAK >= ${thresholds.scorePeak.critical} 이면 즉시조치, ` +
            `그 외 SIMILARITY > ${thresholds.similarity.caution} 또는 SCORE_PEAK >= ${thresholds.scorePeak.caution} 이면 주의관찰`;
    }
}

// ==================== 데이터 로드 ====================

/**
 * 오류 보고서 목록 조회
 * @description 필터 조건에 맞는 보고서 데이터를 조회하여 테이블 렌더링
 * @returns {Promise<void>}
 */
async function loadReports() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;
    const type = document.getElementById('filter-type').value;
    const sector = document.getElementById('filter-sector').value;
    const detail = document.getElementById('filter-detail').value;

    let url = '/api/admin/reports?';
    const params = [];

    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    if (type) params.push(`type=${encodeURIComponent(type)}`);
    if (sector && sector !== 'ALL') params.push(`sector=${encodeURIComponent(sector)}`);
    if (detail) params.push(`typeDetail=${encodeURIComponent(detail)}`);

    url += params.join('&');

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            REPORTS_DATA = result.data;
            renderReports();
            updateNetworkStatus(true);
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('보고서 로드 실패:', err);
        updateNetworkStatus(false);
    }
}

/**
 * 전역 통계 데이터 (차트 토글 시 재사용)
 * @type {Object|null}
 */
let STATS_DATA = null;

/**
 * 통계 데이터 조회
 * @description 유형별, 섹터별, 일별 통계 조회 및 차트 렌더링
 * @returns {Promise<void>}
 */
async function loadStats() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;

    let url = '/api/admin/stats?';
    const params = [];

    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);

    url += params.join('&');

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            const stats = result.data;
            STATS_DATA = stats;

            document.getElementById('stat-total').textContent = stats.total;

            // 유형별 통계 (TYPE_MAP 기반 동적)
            Object.keys(TYPE_MAP).forEach(typeValue => {
                const cnt = stats.byType.find(t => t.TYPE === Number(typeValue))?.CNT || 0;
                const el = document.getElementById('stat-type' + typeValue);
                if (el) el.textContent = cnt;
            });

            // 오늘 건수 (로컬 시간 기준)
            const nowLocal = new Date();
            const today = `${nowLocal.getFullYear()}-${String(nowLocal.getMonth()+1).padStart(2,'0')}-${String(nowLocal.getDate()).padStart(2,'0')}`;
            const todayCount = stats.byDate.find(d => d.REPORT_DATE === today)?.CNT || 0;
            document.getElementById('stat-today').textContent = todayCount;

            // 차트 렌더링
            renderCharts(stats);
        }
    } catch (err) {
        console.error('통계 로드 실패:', err);
    }
}

/**
 * 섹터 필터 드롭다운 로드
 * @description 고정 섹터 목록(FIXED_SECTORS)을 사용하여 필터 드롭다운 구성
 */
function loadSectors() {
    const select = document.getElementById('filter-sector');
    select.innerHTML = '<option value="ALL">전체</option>';

    FIXED_SECTORS.forEach(ccp => {
        const option = document.createElement('option');
        option.value = ccp;
        option.textContent = getSectorName(ccp);
        select.appendChild(option);
    });
}

// ==================== UI 렌더링 ====================

/**
 * 보고서 테이블 렌더링
 * @description REPORTS_DATA를 테이블 형태로 화면에 표시
 */
function renderReports() {
    const tbody = document.getElementById('reports-tbody');
    document.getElementById('report-count').textContent = REPORTS_DATA.length;

    if (REPORTS_DATA.length === 0) {
        tbody.innerHTML = '<tr><td colspan="7" class="empty-state">보고된 항목이 없습니다</td></tr>';
        return;
    }

    const html = REPORTS_DATA.map((r, index) => {
        const typeClass = r.TYPE === 1 ? 'tag-danger' : r.TYPE === 2 ? 'tag-warning' : 'tag-info';
        const impactClass = 'tag-info';

        return `
            <tr data-index="${index}" style="cursor: pointer;">
                <td><input type="checkbox" class="report-check" data-idx="${escapeHtml(r.IDX)}" data-reported="${escapeHtml(r.REPORTED)}"></td>
                <td style="font-size: 12px;">${escapeHtml(r.REPORTED) || '-'}</td>
                <td>${escapeHtml(getSectorName(r.CCP))}</td>
                <td>
                    <div class="callsign-box">
                        <span class="callsign-main">${escapeHtml(r.FP1_CALLSIGN) || '-'}</span>
                        <span class="vs">|</span>
                        <span class="callsign-main">${escapeHtml(r.FP2_CALLSIGN) || '-'}</span>
                    </div>
                </td>
                <td>${escapeHtml(r.REPORTER) || '-'}</td>
                <td><span class="tag ${typeClass}">${TYPE_MAP[r.TYPE] || '-'}</span></td>
                <td><span class="tag ${impactClass}">${IMPACT_MAP[r.TYPE_DETAIL] || '-'}</span></td>
            </tr>
        `;
    }).join('');

    tbody.innerHTML = html;
}

// 전체 선택/해제
function toggleAll(checkbox) {
    const checkboxes = document.querySelectorAll('.report-check');
    checkboxes.forEach(cb => cb.checked = checkbox.checked);
}

// 필터 적용
function applyFilter() {
    loadReports();
    loadStats();
    loadCallsignStats();
}

// 필터 초기화 (오늘 ~ 오늘)
function resetFilter() {
    setDatePreset('today');
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-sector').value = 'ALL';
    document.getElementById('filter-detail').value = '';
    loadReports();
    loadStats();
    loadCallsignStats();
}

/**
 * 날짜 프리셋 설정
 * @param {'today'|'week'|'month'|'3month'|'custom'} period
 */
function setDatePreset(period) {
    // 버튼 활성 상태 업데이트
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
        case 'today':
            break;
        case 'week':
            fromDate.setDate(fromDate.getDate() - 7);
            break;
        case 'month':
            fromDate.setMonth(fromDate.getMonth() - 1);
            break;
        case '3month':
            fromDate.setMonth(fromDate.getMonth() - 3);
            break;
    }

    const fromStr = `${fromDate.getFullYear()}-${String(fromDate.getMonth()+1).padStart(2,'0')}-${String(fromDate.getDate()).padStart(2,'0')}`;
    document.getElementById('filter-from').value = fromStr;
    document.getElementById('filter-to').value = toStr;
}

// 선택 삭제 (병렬 처리 + 개별 에러 핸들링)
async function deleteSelected() {
    const checked = Array.from(document.querySelectorAll('.report-check:checked'));

    if (checked.length === 0) {
        alert('삭제할 항목을 선택해주세요.');
        return;
    }

    if (!confirm(`선택한 ${checked.length}건을 삭제하시겠습니까?`)) {
        return;
    }

    try {
        // 병렬 삭제 요청 생성
        const deletePromises = checked.map(async (cb) => {
            const idx = cb.dataset.idx;
            const reported = encodeURIComponent(cb.dataset.reported);

            const response = await fetch(`/api/admin/reports/${idx}/${reported}`, {
                method: 'DELETE'
            });

            if (!response.ok) {
                throw new Error(`IDX ${idx} 삭제 실패 (HTTP ${response.status})`);
            }

            return idx;
        });

        // 모든 요청 병렬 실행 (실패해도 나머지 계속)
        const results = await Promise.allSettled(deletePromises);

        // 성공/실패 건수 집계
        const succeeded = results.filter(r => r.status === 'fulfilled').length;
        const failed = results.filter(r => r.status === 'rejected');

        if (failed.length > 0) {
            console.error('삭제 실패 항목:', failed.map(f => f.reason.message));
            alert(`${succeeded}건 삭제 완료, ${failed.length}건 실패`);
        } else {
            alert(`${succeeded}건 삭제 완료`);
        }

        loadReports();
        loadStats();
    } catch (err) {
        console.error('삭제 처리 중 오류:', err);
        alert('삭제 처리 중 오류: ' + err.message);
    }
}

// Excel 다운로드
function downloadExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
        return;
    }
    if (REPORTS_DATA.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 데이터 가공 (T_SIMILAR_CALLSIGN_PAIR + T_SIMILAR_CALLSIGN_PAIR_REPORT JOIN 전체)
    const excelData = REPORTS_DATA.map(r => ({
        '검출시각': r.DETECTED || '',
        '해제시각': r.CLEARED === '9999-12-31 23:59:59' ? '활성' : (r.CLEARED || ''),
        'FP1_호출부호': r.FP1_CALLSIGN || '',
        'FP1_출발': r.FP1_DEPT || '',
        'FP1_도착': r.FP1_DEST || '',
        'FP1_EOBT': r.FP1_EOBT || '',
        'FP1_FID': r.FP1_FID || '',
        'FP1_고도': r.FP1_ALT || '',
        'FP2_호출부호': r.FP2_CALLSIGN || '',
        'FP2_출발': r.FP2_DEPT || '',
        'FP2_도착': r.FP2_DEST || '',
        'FP2_EOBT': r.FP2_EOBT || '',
        'FP2_FID': r.FP2_FID || '',
        'FP2_고도': r.FP2_ALT || '',
        '유사도': r.SIMILARITY ?? '',
        '오류가능성': r.SCORE_PEAK ?? '',
        '관제피크': r.CTRL_PEAK ?? '',
        '비교율': r.COMP_RAT ?? '',
        '섹터': getSectorName(r.CCP),
        '보고일시': r.REPORTED || '',
        '보고자': r.REPORTER || '',
        '오류유형': TYPE_MAP[r.TYPE] || String(r.TYPE || ''),
        '세부오류유형': IMPACT_MAP[r.TYPE_DETAIL] || String(r.TYPE_DETAIL || ''),
        '오류항공기': AO_MAP[r.AO] || '',
        '비고': r.REMARK || ''
    }));

    // SheetJS로 Excel 생성
    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '오류보고서');

    // 컬럼 너비 설정
    ws['!cols'] = [
        { wch: 20 }, { wch: 12 },
        { wch: 12 }, { wch: 6 }, { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 6 },
        { wch: 12 }, { wch: 6 }, { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 6 },
        { wch: 8 }, { wch: 10 }, { wch: 10 }, { wch: 8 },
        { wch: 8 }, { wch: 20 }, { wch: 8 }, { wch: 12 }, { wch: 14 }, { wch: 10 }, { wch: 30 }
    ];

    // 파일명 생성
    const now = new Date();
    const filename = `유사호출부호_오류보고서_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;

    // 다운로드
    XLSX.writeFile(wb, filename);
}

// 오류유형/세부오류유형 설정 로드
async function loadErrorDetailTypes() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) return;
        const result = await res.json();

        // 섹터 맵핑 적용 (서버 설정이 common.js 기본값을 덮어씀)
        if (result.data?.sectorMap && Object.keys(result.data.sectorMap).length > 0) {
            updateSectorConfig(result.data.sectorMap, result.data.fixedSectors || []);
        }

        // 위험도 기준값 적용
        updateRiskThresholds(result.data?.thresholds || getRiskThresholds());

        // 오류유형 매핑 + 필터 드롭다운
        const errorTypes = result.data?.errorTypes || [];
        TYPE_MAP = {};
        errorTypes.forEach(t => { TYPE_MAP[t.value] = t.label; });
        const typeSelect = document.getElementById('filter-type');
        if (typeSelect) {
            typeSelect.innerHTML = '<option value="">전체</option>' +
                errorTypes.map(t => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');
        }

        // 세부오류유형 매핑 + 필터 드롭다운
        const detailTypes = result.data?.errorDetailTypes || [];
        IMPACT_MAP = {};
        detailTypes.forEach(t => { IMPACT_MAP[t.value] = t.label; });
        const detailSelect = document.getElementById('filter-detail');
        if (detailSelect) {
            detailSelect.innerHTML = '<option value="">전체</option>' +
                detailTypes.map(t => `<option value="${t.value}">${escapeHtml(t.label)}</option>`).join('');
        }

        // 오류유형별 통계 카드 동적 생성
        const typeColors = ['var(--accent-danger)', 'var(--accent-warning)', '#f97316', '#a78bfa', 'var(--text-muted)'];
        const cardContainer = document.getElementById('stat-type-cards');
        if (cardContainer) {
            cardContainer.innerHTML = errorTypes.map((t, i) =>
                `<div class="stat-card">
                    <div class="stat-value" id="stat-type${t.value}" style="color: ${typeColors[i % typeColors.length]};">0</div>
                    <div class="stat-label">${escapeHtml(t.label)}</div>
                </div>`
            ).join('');
        }
    } catch (err) {
        console.error('오류유형 설정 로드 실패:', err);
    }
}

// 초기화
async function init() {
    try {
        // 보고서 행 클릭 이벤트 위임 (한 번만 바인딩)
        document.getElementById('reports-tbody').addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            const tr = e.target.closest('tr[data-index]');
            if (!tr) return;
            showReportDetail(parseInt(tr.dataset.index, 10));
        });

        setDatePreset('today');
        await loadErrorDetailTypes();
        await loadSectors();
        await loadReports();
        await loadStats();
        await loadCallsignStats(); // 호출부호 데이터 통계 로드

        // 사이드바 데이터 로드 (병렬)
        loadHourlyStats();
        loadTodayDetection();

        document.getElementById('loader').style.display = 'none';
    } catch (err) {
        console.error('초기화 실패:', err);
        document.getElementById('loader').innerHTML = `
            <div style="color: var(--accent-danger);">연결 실패</div>
            <div style="margin-top: 10px; font-size: 14px;">서버 연결에 실패했습니다.</div>
        `;
    }
}

// 호출부호 데이터 통계 조회 (검색 날짜 필터 연동)
async function loadCallsignStats() {
    const from = document.getElementById('filter-from').value;
    const to = document.getElementById('filter-to').value;

    let url = '/api/admin/callsign-stats?';
    const params = [];
    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    url += params.join('&');

    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            const fromDisplay = from || '-';
            const toDisplay = to || '-';
            const infoText = `조회기간: ${fromDisplay} ~ ${toDisplay} | 호출부호 데이터: ${result.data.totalCount.toLocaleString()}건`;
            document.getElementById('callsign-stats-info').textContent = infoText;
        }
    } catch (err) {
        console.error('호출부호 통계 조회 실패:', err);
    }
}

// ==================== 환경설정 기능 ====================

// 환경설정 섹션 토글
function toggleSettings() {
    const section = document.getElementById('settings-section');
    if (section.style.display === 'none') {
        section.style.display = 'block';
        loadSettings();
    } else {
        section.style.display = 'none';
    }
}

// 탭 전환
function switchCfgTab(tab) {
    document.querySelectorAll('.cfg-tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.cfg-tab-content').forEach(c => c.style.display = 'none');
    const activeTab = document.querySelector(`.cfg-tab[data-tab="${tab}"]`);
    if (activeTab) activeTab.classList.add('active');
    const content = document.getElementById(`cfg-tab-${tab}`);
    if (content) content.style.display = 'block';
}

// 환경설정 전체 불러오기 (모든 탭 채우기)
async function loadSettings() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();
        if (!result.success) throw new Error(result.error);
        const data = result.data;

        // 섹터맵 전역 변수 업데이트
        if (data.sectorMap && Object.keys(data.sectorMap).length > 0) {
            updateSectorConfig(data.sectorMap, data.fixedSectors || []);
        }

        // ── 탭1: 기본 설정 ──
        const el_refresh = document.getElementById('setting-refresh');
        const el_maxrows = document.getElementById('setting-maxrows');
        if (el_refresh) el_refresh.value = data.refreshRate || 10000;
        if (el_maxrows) el_maxrows.value = data.maxRows || 100;

        // 섹터 체크박스 (업데이트된 FIXED_SECTORS 기준)
        const container = document.getElementById('sector-checkboxes');
        if (container) {
            const selectedSectors = data.displaySectors || [];
            container.innerHTML = FIXED_SECTORS.map(ccp => `
                <label style="display:flex;align-items:center;gap:5px;padding:8px 12px;background:rgba(30,41,59,0.5);border-radius:6px;cursor:pointer;">
                    <input type="checkbox" class="sector-checkbox" value="${ccp}" ${selectedSectors.includes(String(ccp)) ? 'checked' : ''}>
                    <span>${getSectorName(ccp)}</span>
                </label>`).join('');
        }

        // 유사도 체크박스
        const simLevels = data.displaySimilarity || [];
        document.querySelectorAll('.similarity-checkbox').forEach(cb => {
            cb.checked = simLevels.includes(cb.value);
        });

        // 위험도 기준값 입력칸
        const thresholds = normalizeThresholds(data.thresholds);
        updateRiskThresholds(thresholds);
        const simCriticalInput = document.getElementById('setting-sim-critical');
        const simCautionInput = document.getElementById('setting-sim-caution');
        const scoreCriticalInput = document.getElementById('setting-score-critical');
        const scoreCautionInput = document.getElementById('setting-score-caution');
        if (simCriticalInput) simCriticalInput.value = thresholds.similarity.critical;
        if (simCautionInput) simCautionInput.value = thresholds.similarity.caution;
        if (scoreCriticalInput) scoreCriticalInput.value = thresholds.scorePeak.critical;
        if (scoreCautionInput) scoreCautionInput.value = thresholds.scorePeak.caution;
        updateThresholdHints(thresholds);

        // ── 탭2: 섹터 맵핑 ──
        const sectorMapToShow = (data.sectorMap && Object.keys(data.sectorMap).length > 0) ? data.sectorMap : SECTOR_MAP;
        const fixedToShow    = (data.fixedSectors && data.fixedSectors.length > 0) ? data.fixedSectors : FIXED_SECTORS;
        renderSectorMapRows(sectorMapToShow, fixedToShow);

        // ── 탭3: 오류유형 ──
        renderErrorTypeRows(data.errorTypes || []);
        renderDetailTypeRows(data.errorDetailTypes || [], data.errorTypes || []);

        // 마지막 수정 정보
        if (data.updatedAt) {
            const infoEl = document.getElementById('settings-info');
            const updEl  = document.getElementById('settings-updated');
            if (infoEl) infoEl.style.display = 'block';
            if (updEl)  updEl.textContent = `${data.updatedAt.replace('T', ' ').slice(0, 19)} (${data.updatedBy || 'admin'})`;
        }
    } catch (err) {
        console.error('설정 로드 실패:', err);
    }
}

// 환경설정 전체 저장
async function saveSettings() {
    try {
        // 탭1: 기본 설정
        const selectedSectors   = Array.from(document.querySelectorAll('.sector-checkbox:checked')).map(cb => cb.value);
        const selectedSimilarity = Array.from(document.querySelectorAll('.similarity-checkbox:checked')).map(cb => cb.value);

        // 탭2: 섹터 맵핑
        const sectorMapData = {};
        const fixedSectorsList = [];
        document.querySelectorAll('.sector-map-row').forEach(row => {
            const code  = row.querySelector('.smap-code').value.trim();
            const name  = row.querySelector('.smap-name').value.trim();
            const fixed = row.querySelector('.smap-fixed').checked;
            if (code && name) {
                sectorMapData[code] = name;
                if (fixed) fixedSectorsList.push(code);
            }
        });

        // 탭3: 오류유형
        const errorTypes = [];
        document.querySelectorAll('.error-type-row').forEach(row => {
            const value = parseInt(row.querySelector('.etype-value').value, 10);
            const label = row.querySelector('.etype-label').value.trim();
            if (value > 0 && label) errorTypes.push({ value, label });
        });

        const errorDetailTypes = [];
        document.querySelectorAll('.detail-type-row').forEach(row => {
            const value      = parseInt(row.querySelector('.dtype-value').value, 10);
            const label      = row.querySelector('.dtype-label').value.trim();
            const parentType = parseInt(row.querySelector('.dtype-parent').value, 10) || 0;
            if (value > 0 && label) errorDetailTypes.push({ value, label, parentType });
        });

        // 탭1: 위험도 기준값
        const thresholds = {
            similarity: {
                critical: Number(document.getElementById('setting-sim-critical').value),
                caution: Number(document.getElementById('setting-sim-caution').value)
            },
            scorePeak: {
                critical: Number(document.getElementById('setting-score-critical').value),
                caution: Number(document.getElementById('setting-score-caution').value)
            }
        };

        if (!Number.isFinite(thresholds.similarity.critical) || !Number.isFinite(thresholds.similarity.caution) ||
            thresholds.similarity.caution < 0 || thresholds.similarity.critical <= thresholds.similarity.caution) {
            alert('유사도 기준값이 올바르지 않습니다. 매우높음 기준은 높음 기준보다 커야 합니다.');
            return;
        }
        if (!Number.isFinite(thresholds.scorePeak.critical) || !Number.isFinite(thresholds.scorePeak.caution) ||
            thresholds.scorePeak.caution < 0 || thresholds.scorePeak.critical <= thresholds.scorePeak.caution) {
            alert('오류가능성 기준값이 올바르지 않습니다. 매우높음 기준은 높음 기준보다 커야 합니다.');
            return;
        }

        const settings = {
            displaySectors:   selectedSectors,
            displaySimilarity: selectedSimilarity,
            refreshRate: parseInt(document.getElementById('setting-refresh').value, 10),
            maxRows:     parseInt(document.getElementById('setting-maxrows').value, 10),
            thresholds,
            sectorMap:        sectorMapData,
            fixedSectors:     fixedSectorsList,
            errorTypes,
            errorDetailTypes,
            updatedBy: 'admin'
        };

        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success) {
            // 저장 성공 후 전역 변수 즉시 반영
            if (Object.keys(sectorMapData).length > 0) {
                updateSectorConfig(sectorMapData, fixedSectorsList);
                loadSectors(); // 섹터 필터 드롭다운 갱신
            }
            // TYPE_MAP / IMPACT_MAP 갱신
            TYPE_MAP = {}; errorTypes.forEach(t => { TYPE_MAP[t.value] = t.label; });
            IMPACT_MAP = {}; errorDetailTypes.forEach(t => { IMPACT_MAP[t.value] = t.label; });
            updateRiskThresholds(thresholds);
            updateThresholdHints(normalizeThresholds(thresholds));

            alert('설정이 저장되었습니다.\n모든 관제사 화면에 즉시 적용됩니다.\n필요 시 start.bat 재시작으로도 적용됩니다.');
            loadSettings();
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('설정 저장 실패:', err);
        alert('설정 저장 실패: ' + err.message);
    }
}

// ==================== 섹터 맵핑 에디터 ====================

function renderSectorMapRows(sectorMap, fixedSectors) {
    const container = document.getElementById('sector-map-rows');
    if (!container) return;
    const entries = Object.entries(sectorMap || {});
    if (entries.length === 0) {
        container.innerHTML = '<div style="padding:12px;color:var(--text-muted);font-size:12px;text-align:center;">섹터가 없습니다. + 행 추가를 클릭하세요.</div>';
        return;
    }
    container.innerHTML = entries.map(([code, name]) =>
        buildSectorMapRowHTML(code, name, (fixedSectors || []).includes(String(code)))
    ).join('');
}

function buildSectorMapRowHTML(code, name, fixed) {
    return `<div class="sector-map-row" style="display:grid;grid-template-columns:80px 110px 70px auto;gap:6px;align-items:center;padding:3px 2px;">
        <input class="smap-code" type="text" value="${escapeHtml(String(code))}" placeholder="코드" maxlength="5"
            style="padding:5px 7px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:var(--accent-primary);font-family:var(--font-mono);font-size:12px;width:100%;text-align:center;">
        <input class="smap-name" type="text" value="${escapeHtml(String(name))}" placeholder="섹터명" maxlength="20"
            style="padding:5px 7px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:#fff;font-family:var(--font-mono);font-size:12px;width:100%;">
        <div style="text-align:center;"><input type="checkbox" class="smap-fixed" ${fixed ? 'checked' : ''} title="고정표시 여부" style="width:16px;height:16px;"></div>
        <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:11px;color:var(--accent-danger);border-color:rgba(239,68,68,0.3);"
            onclick="this.closest('.sector-map-row').remove()">삭제</button>
    </div>`;
}

function addSectorMapRow() {
    const container = document.getElementById('sector-map-rows');
    if (!container) return;
    // 빈 상태 메시지가 있으면 제거
    const emptyMsg = container.querySelector('div:not(.sector-map-row)');
    if (emptyMsg) emptyMsg.remove();
    const div = document.createElement('div');
    div.innerHTML = buildSectorMapRowHTML('', '', false);
    container.appendChild(div.firstElementChild);
    container.lastElementChild.querySelector('.smap-code').focus();
}

// ==================== 오류유형 에디터 ====================

function renderErrorTypeRows(errorTypes) {
    const container = document.getElementById('error-type-rows');
    if (!container) return;
    if (!errorTypes || errorTypes.length === 0) {
        container.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;text-align:center;">유형이 없습니다.</div>';
        return;
    }
    container.innerHTML = errorTypes.map(t => buildErrorTypeRowHTML(t.value, t.label)).join('');
}

function buildErrorTypeRowHTML(value, label) {
    return `<div class="error-type-row" style="display:grid;grid-template-columns:52px 1fr auto;gap:6px;align-items:center;padding:3px 2px;">
        <input class="etype-value" type="number" value="${value}" min="1" max="99"
            style="padding:5px 4px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:var(--accent-primary);font-family:var(--font-mono);font-size:12px;text-align:center;width:100%;">
        <input class="etype-label" type="text" value="${escapeHtml(label)}" placeholder="유형 이름" maxlength="30"
            style="padding:5px 7px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:#fff;font-size:12px;width:100%;">
        <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:11px;color:var(--accent-danger);border-color:rgba(239,68,68,0.3);"
            onclick="this.closest('.error-type-row').remove(); refreshDetailTypeParentOptions()">삭제</button>
    </div>`;
}

function addErrorTypeRow() {
    const container = document.getElementById('error-type-rows');
    if (!container) return;
    const empMsg = container.querySelector('div:not(.error-type-row)');
    if (empMsg) empMsg.remove();
    const vals = Array.from(container.querySelectorAll('.etype-value')).map(el => parseInt(el.value) || 0);
    const nextVal = vals.length > 0 ? Math.max(...vals) + 1 : 1;
    const div = document.createElement('div');
    div.innerHTML = buildErrorTypeRowHTML(nextVal, '');
    container.appendChild(div.firstElementChild);
    container.lastElementChild.querySelector('.etype-label').focus();
    refreshDetailTypeParentOptions();
}

// ==================== 세부오류유형 에디터 ====================

function getErrorTypesFromEditor() {
    return Array.from(document.querySelectorAll('.error-type-row')).map(row => ({
        value: parseInt(row.querySelector('.etype-value').value, 10) || 0,
        label: row.querySelector('.etype-label').value.trim()
    })).filter(t => t.value > 0 && t.label);
}

function renderDetailTypeRows(detailTypes, errorTypes) {
    const container = document.getElementById('detail-type-rows');
    if (!container) return;
    if (!detailTypes || detailTypes.length === 0) {
        container.innerHTML = '<div style="padding:10px;color:var(--text-muted);font-size:12px;text-align:center;">세부유형이 없습니다.</div>';
        return;
    }
    container.innerHTML = detailTypes.map(t => buildDetailTypeRowHTML(t.value, t.label, t.parentType, errorTypes)).join('');
}

function buildDetailTypeRowHTML(value, label, parentType, errorTypes) {
    const et = errorTypes || getErrorTypesFromEditor();
    const opts = et.map(t =>
        `<option value="${t.value}" ${t.value === parentType ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
    ).join('');
    return `<div class="detail-type-row" style="display:grid;grid-template-columns:52px 1fr 100px auto;gap:6px;align-items:center;padding:3px 2px;">
        <input class="dtype-value" type="number" value="${value}" min="1" max="999"
            style="padding:5px 4px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:var(--accent-primary);font-family:var(--font-mono);font-size:12px;text-align:center;width:100%;">
        <input class="dtype-label" type="text" value="${escapeHtml(label)}" placeholder="세부유형 이름" maxlength="30"
            style="padding:5px 7px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:#fff;font-size:12px;width:100%;">
        <select class="dtype-parent"
            style="padding:5px 4px;background:rgba(15,23,42,0.8);border:1px solid var(--glass-border);border-radius:5px;color:#fff;font-size:11px;width:100%;">${opts}</select>
        <button class="btn btn-ghost btn-sm" style="padding:4px 8px;font-size:11px;color:var(--accent-danger);border-color:rgba(239,68,68,0.3);"
            onclick="this.closest('.detail-type-row').remove()">삭제</button>
    </div>`;
}

function addDetailTypeRow() {
    const container = document.getElementById('detail-type-rows');
    if (!container) return;
    const empMsg = container.querySelector('div:not(.detail-type-row)');
    if (empMsg) empMsg.remove();
    const vals = Array.from(container.querySelectorAll('.dtype-value')).map(el => parseInt(el.value) || 0);
    const nextVal = vals.length > 0 ? Math.max(...vals) + 1 : 1;
    const et = getErrorTypesFromEditor();
    const defParent = et.length > 0 ? et[0].value : 1;
    const div = document.createElement('div');
    div.innerHTML = buildDetailTypeRowHTML(nextVal, '', defParent, et);
    container.appendChild(div.firstElementChild);
    container.lastElementChild.querySelector('.dtype-label').focus();
}

// 오류유형 변경 시 세부오류유형의 상위유형 드롭다운 갱신
function refreshDetailTypeParentOptions() {
    const et = getErrorTypesFromEditor();
    document.querySelectorAll('.detail-type-row').forEach(row => {
        const sel = row.querySelector('.dtype-parent');
        const cur = parseInt(sel.value, 10);
        sel.innerHTML = et.map(t =>
            `<option value="${t.value}" ${t.value === cur ? 'selected' : ''}>${escapeHtml(t.label)}</option>`
        ).join('');
    });
}

// ==================== 바로가기 다운로드 ====================

/**
 * 클라이언트 우클릭 창전환 프로세스 강제 종료
 */
function killSwitchProcess() {
    if (!confirm('서버에서 모든 클라이언트의 우클릭 창전환 프로세스를 종료합니다.\n계속하시겠습니까?')) return;
    fetch('/api/admin/kill-switch', { method: 'POST' })
        .then(r => r.json())
        .then(data => {
            alert(data.message || '처리되었습니다.');
        })
        .catch(() => alert('요청 실패'));
}

/**
 * 바탕화면용 바로가기 파일 다운로드
 * Edge --app 모드 브라우저 실행 + 우클릭 창전환 스크립트 동시 실행
 * @param {string} pagePath - 페이지 경로 ('/')
 */
function downloadShortcut(pagePath) {
    const baseUrl = window.location.origin;
    const url = baseUrl + pagePath;
    const psUrl = baseUrl + '/tools/right_click_switch.ps1';
    const filename = '유사호출부호검출시스템.bat';
    const content = [
        '@echo off',
        'chcp 65001 >nul',
        '',
        ':: 바탕화면에 자동 복사 (최초 실행 시)',
        'set "DESKTOP=%USERPROFILE%\\Desktop\\유사호출부호검출시스템.bat"',
        'if not "%~f0"=="%DESKTOP%" (',
        '    copy /Y "%~f0" "%DESKTOP%" >nul 2>&1',
        ')',
        '',
        ':: 창전환 스크립트 다운로드 (최초 1회)',
        'set "PS_DIR=%USERPROFILE%\\유사호출부호검출시스템"',
        'set "PS_FILE=%PS_DIR%\\right_click_switch.ps1"',
        'if not exist "%PS_DIR%" mkdir "%PS_DIR%"',
        'if not exist "%PS_FILE%" (',
        '    powershell -Command "Invoke-WebRequest -Uri \'' + psUrl + '\' -OutFile \'%PS_FILE%\'"',
        ')',
        '',
        ':: 창전환 스크립트 숨김 실행 (PID 저장)',
        'set "PID_FILE=%PS_DIR%\\switch.pid"',
        'for /f %%i in (\'powershell -ExecutionPolicy Bypass -Command "( Start-Process powershell -ArgumentList \'-WindowStyle Hidden -ExecutionPolicy Bypass -File \\\"%PS_FILE%\\\"\' -WindowStyle Hidden -PassThru ).Id"\') do set SWITCH_PID=%%i',
        'echo %SWITCH_PID%> "%PID_FILE%"',
        '',
        ':: 브라우저 실행',
        'start "" msedge --new-window --app="' + url + '"',
        '',
        ':: Edge --app 창이 닫힐 때까지 대기 (3초마다 체크)',
        ':WAIT_LOOP',
        'timeout /t 3 /nobreak >nul',
        'powershell -Command "if (Get-Process msedge -ErrorAction SilentlyContinue) { exit 0 } else { exit 1 }" >nul 2>&1',
        'if %errorlevel%==0 goto WAIT_LOOP',
        '',
        ':: Edge 종료됨 -> 창전환 스크립트 종료',
        'if defined SWITCH_PID taskkill /f /pid %SWITCH_PID% >nul 2>&1',
        'if exist "%PID_FILE%" del "%PID_FILE%" >nul 2>&1',
        ''
    ].join('\r\n');
    const blob = new Blob([content], { type: 'application/bat' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// ==================== 보고서 상세 보기 ====================

// 상세 보기 모달 표시
function showReportDetail(index) {
    const r = REPORTS_DATA[index];
    if (!r) return;

    const typeClass = r.TYPE === 1 ? 'tag-danger' : r.TYPE === 2 ? 'tag-warning' : 'tag-info';
    const impactClass = 'tag-info';

    const content = document.getElementById('report-detail-content');
    content.innerHTML = `
        <div style="display: grid; gap: 16px;">
            <!-- 유사호출부호 비교 (FP1 vs FP2) -->
            <div style="display: grid; grid-template-columns: 1fr auto 1fr; gap: 10px; align-items: stretch;">
                <!-- FP1 -->
                <div style="background: rgba(15,23,42,0.5); padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 10px; color: var(--accent-primary); margin-bottom: 6px; font-weight: 600;">FP1</div>
                    <div style="font-size: 20px; font-weight: 700; color: #fff; font-family: var(--font-mono); margin-bottom: 10px;">${r.FP1_CALLSIGN ? escapeHtml(r.FP1_CALLSIGN) : '-'}</div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        <span style="color: var(--accent-secondary);">${r.FP1_DEPT ? escapeHtml(r.FP1_DEPT) : '-'}</span>
                        <span style="margin: 0 4px;">→</span>
                        <span style="color: var(--accent-warning);">${r.FP1_DEST ? escapeHtml(r.FP1_DEST) : '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
                        EOBT: <span style="color: var(--text-main);">${r.FP1_EOBT ? escapeHtml(r.FP1_EOBT) : '-'}</span>
                    </div>
                </div>
                <!-- VS -->
                <div style="display: flex; align-items: center; color: var(--text-muted); font-size: 12px; font-weight: 600;">vs</div>
                <!-- FP2 -->
                <div style="background: rgba(15,23,42,0.5); padding: 15px; border-radius: 10px; text-align: center;">
                    <div style="font-size: 10px; color: var(--accent-primary); margin-bottom: 6px; font-weight: 600;">FP2</div>
                    <div style="font-size: 20px; font-weight: 700; color: #fff; font-family: var(--font-mono); margin-bottom: 10px;">${r.FP2_CALLSIGN ? escapeHtml(r.FP2_CALLSIGN) : '-'}</div>
                    <div style="font-size: 12px; color: var(--text-muted);">
                        <span style="color: var(--accent-secondary);">${r.FP2_DEPT ? escapeHtml(r.FP2_DEPT) : '-'}</span>
                        <span style="margin: 0 4px;">→</span>
                        <span style="color: var(--accent-warning);">${r.FP2_DEST ? escapeHtml(r.FP2_DEST) : '-'}</span>
                    </div>
                    <div style="font-size: 11px; color: var(--text-muted); margin-top: 6px;">
                        EOBT: <span style="color: var(--text-main);">${r.FP2_EOBT ? escapeHtml(r.FP2_EOBT) : '-'}</span>
                    </div>
                </div>
            </div>

            <!-- 기본 정보 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="detail-field">
                    <div class="detail-label">보고일시</div>
                    <div class="detail-value">${escapeHtml(r.REPORTED) || '-'}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">섹터</div>
                    <div class="detail-value">${escapeHtml(getSectorName(r.CCP))}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">보고자</div>
                    <div class="detail-value">${escapeHtml(r.REPORTER) || '-'}</div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">오류항공기</div>
                    <div class="detail-value">${AO_MAP[r.AO] || '-'}</div>
                </div>
            </div>

            <!-- 오류 분류 -->
            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
                <div class="detail-field">
                    <div class="detail-label">오류유형</div>
                    <div class="detail-value"><span class="tag ${typeClass}">${TYPE_MAP[r.TYPE] || '-'}</span></div>
                </div>
                <div class="detail-field">
                    <div class="detail-label">세부오류유형</div>
                    <div class="detail-value"><span class="tag ${impactClass}">${IMPACT_MAP[r.TYPE_DETAIL] || '-'}</span></div>
                </div>
            </div>

            <!-- 비고 -->
            <div class="detail-field">
                <div class="detail-label">비고</div>
                <div class="detail-value" style="min-height: 60px; background: rgba(15,23,42,0.5); padding: 12px; border-radius: 6px; white-space: pre-wrap;">${escapeHtml(r.REMARK) || '(없음)'}</div>
            </div>
        </div>
    `;

    document.getElementById('report-detail-modal').classList.add('active');
}

// 상세 보기 모달 닫기
function closeDetailModal() {
    document.getElementById('report-detail-modal').classList.remove('active');
}

// 모달 외부 클릭 시 닫기
document.addEventListener('click', (e) => {
    const modal = document.getElementById('report-detail-modal');
    if (e.target === modal) {
        closeDetailModal();
    }
});

// ==================== 통계 차트 ====================

// 차트 섹션 토글
function toggleCharts() {
    const section = document.getElementById('charts-section');
    if (section.style.display === 'none') {
        section.style.display = 'block';
        if (STATS_DATA) {
            renderCharts(STATS_DATA);
        }
    } else {
        section.style.display = 'none';
    }
}

// 차트 렌더링 (섹터별, 월별, 유형별)
function renderCharts(stats) {
    renderSectorChart(stats.bySector, stats.total);
    renderMonthlyChart(stats.byMonth);
    renderTypeChart(stats.byType, stats.total);
    renderDetailChart(stats.byDetail, stats.total);
}

// 섹터별 가로 막대 차트
function renderSectorChart(bySector, total) {
    const container = document.getElementById('sector-chart');
    if (!bySector || bySector.length === 0) {
        container.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 20px;">데이터 없음</div>';
        return;
    }

    const maxCnt = Math.max(...bySector.map(s => s.CNT));

    const html = bySector.map(s => {
        const pct = maxCnt > 0 ? (s.CNT / maxCnt) * 100 : 0;
        const ratio = total > 0 ? ((s.CNT / total) * 100).toFixed(1) : 0;
        return `
            <div class="h-bar-row">
                <div class="h-bar-label">${getSectorName(s.CCP)}</div>
                <div class="h-bar-track">
                    <div class="h-bar-fill sector" style="width: ${pct}%;">
                        ${pct > 15 ? `<span class="h-bar-value">${ratio}%</span>` : ''}
                    </div>
                </div>
                <div class="h-bar-count">${s.CNT}건</div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

// 월별 바 차트
function renderMonthlyChart(byMonth) {
    const chartContainer = document.getElementById('monthly-chart');
    const labelsContainer = document.getElementById('monthly-labels');

    if (!byMonth || byMonth.length === 0) {
        chartContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 40px; width: 100%;">데이터 없음</div>';
        labelsContainer.innerHTML = '';
        return;
    }

    const maxCnt = Math.max(...byMonth.map(m => m.CNT), 1);
    const nowL = new Date();
    const currentMonth = `${nowL.getFullYear()}-${String(nowL.getMonth()+1).padStart(2,'0')}`;

    const barsHtml = byMonth.map(m => {
        const heightPct = (m.CNT / maxCnt) * 100;
        const isHighlight = m.REPORT_MONTH === currentMonth;
        const monthLabel = m.REPORT_MONTH.slice(5); // "MM" 형태
        const tooltip = `${m.REPORT_MONTH}: ${m.CNT}건`;

        return `
            <div class="monthly-bar ${isHighlight ? 'highlight' : ''}"
                 style="height: ${Math.max(heightPct, 3)}%;"
                 data-tooltip="${tooltip}">
                ${m.CNT > 0 ? `<span class="monthly-bar-value">${m.CNT}</span>` : ''}
            </div>
        `;
    }).join('');

    const labelsHtml = byMonth.map(m => {
        const monthNum = m.REPORT_MONTH.slice(5);
        return `<span>${monthNum}월</span>`;
    }).join('');

    chartContainer.innerHTML = barsHtml;
    labelsContainer.innerHTML = labelsHtml;
}

// 오류유형별 가로 막대 차트 (설정 기반)
function renderTypeChart(byType, total) {
    const container = document.getElementById('type-chart');
    const colors = ['#ef4444', '#f59e0b', '#f97316', '#a78bfa', '#64748b'];

    // TYPE_MAP 키 기준으로 동적 생성
    const keys = Object.keys(TYPE_MAP).map(Number);
    const typeData = keys.map((val, idx) => {
        const found = byType.find(t => t.TYPE === val);
        return { type: val, name: TYPE_MAP[val], cnt: found ? found.CNT : 0, color: colors[idx % colors.length] };
    });

    const maxCnt = Math.max(...typeData.map(t => t.cnt), 1);
    container.innerHTML = typeData.map(t => {
        const pct = maxCnt > 0 ? (t.cnt / maxCnt) * 100 : 0;
        return `
            <div class="h-bar-row">
                <div class="h-bar-label" style="width: 100px;">${t.name}</div>
                <div class="h-bar-track">
                    <div class="h-bar-fill" style="width: ${pct}%; background: ${t.color};">
                        ${pct > 15 ? `<span class="h-bar-value">${t.cnt}건</span>` : ''}
                    </div>
                </div>
                <div class="h-bar-count">${t.cnt}건</div>
            </div>
        `;
    }).join('');
}

// 세부오류유형별 가로 막대 차트 (설정 기반)
function renderDetailChart(byDetail, total) {
    const container = document.getElementById('detail-chart');
    if (!container) return;
    const colors = ['#0ea5e9', '#10b981', '#f59e0b', '#a78bfa', '#64748b', '#f97316'];

    // IMPACT_MAP 키 기준으로 동적 생성
    const keys = Object.keys(IMPACT_MAP).map(Number);
    const detailData = keys.map((val, idx) => {
        const found = (byDetail || []).find(t => t.TYPE_DETAIL === val);
        return { type: val, name: IMPACT_MAP[val], cnt: found ? found.CNT : 0, color: colors[idx % colors.length] };
    });

    const maxCnt = Math.max(...detailData.map(t => t.cnt), 1);
    container.innerHTML = detailData.map(t => {
        const pct = maxCnt > 0 ? (t.cnt / maxCnt) * 100 : 0;
        return `
            <div class="h-bar-row">
                <div class="h-bar-label" style="width: 100px;">${t.name}</div>
                <div class="h-bar-track">
                    <div class="h-bar-fill" style="width: ${pct}%; background: ${t.color};">
                        ${pct > 15 ? `<span class="h-bar-value">${t.cnt}건</span>` : ''}
                    </div>
                </div>
                <div class="h-bar-count">${t.cnt}건</div>
            </div>
        `;
    }).join('');
}

// ==================== 사이드바: 시간대별 + 오늘 검출 현황 ====================

/**
 * 시간대별 검출 현황 로드 (오늘 기준)
 */
async function loadHourlyStats() {
    try {
        const response = await fetch('/api/hourly-stats');
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success) {
            renderHourlyChart(result.data.hourly);
            const totalEl = document.getElementById('hourly-total');
            if (totalEl) totalEl.textContent = result.data.total + '건';
        }
    } catch (err) {
        console.error('시간대별 통계 로드 실패:', err);
    }
}

/**
 * 시간대별 막대 차트 렌더링
 * @param {number[]} hourly - 0~23시 시간대별 건수 배열
 */
function renderHourlyChart(hourly) {
    const chart = document.getElementById('hourly-chart');
    const yaxis = document.getElementById('hourly-yaxis');
    if (!chart || !yaxis) return;

    const maxCnt = Math.max(...hourly, 1);

    // Y축 라벨
    yaxis.innerHTML = `<span>${maxCnt}</span><span>${Math.round(maxCnt / 2)}</span><span>0</span>`;

    // 피크 시간대 찾기
    const peakVal = Math.max(...hourly);

    chart.innerHTML = hourly.map((cnt, h) => {
        const heightPct = maxCnt > 0 ? (cnt / maxCnt) * 100 : 0;
        const isPeak = cnt > 0 && cnt === peakVal;
        const tooltip = `${String(h).padStart(2, '0')}시: ${cnt}건`;
        return `<div class="hourly-bar ${cnt === 0 ? 'empty' : ''} ${isPeak ? 'peak' : ''}"
                     style="height: ${heightPct}%;"
                     data-tooltip="${tooltip}"></div>`;
    }).join('');
}

/**
 * 오늘 검출 현황 로드
 */
async function loadTodayDetection() {
    try {
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth()+1).padStart(2,'0')}-${String(today.getDate()).padStart(2,'0')}`;

        const response = await fetch(`/api/history/summary?from=${todayStr}&to=${todayStr + ' 23:59:59'}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const result = await response.json();

        if (result.success && result.data) {
            const d = result.data;
            document.getElementById('today-detect-total').textContent = (d.totalCount || 0).toLocaleString() + '건';
            document.getElementById('today-danger').textContent = (d.byRisk?.DANGER_CNT || 0).toLocaleString();
            document.getElementById('today-warning').textContent = (d.byRisk?.WARNING_CNT || 0).toLocaleString();
            document.getElementById('today-info').textContent = (d.byRisk?.INFO_CNT || 0).toLocaleString();
            document.getElementById('today-active').textContent = (d.activeCount || 0).toLocaleString();
            document.getElementById('today-cleared').textContent = (d.clearedCount || 0).toLocaleString();

            // 섹터별 현황
            renderTodaySectorList(d.bySector || []);
        }
    } catch (err) {
        console.error('오늘 검출 현황 로드 실패:', err);
    }
}

/**
 * 오늘 검출 섹터별 목록 렌더링
 */
function renderTodaySectorList(bySector) {
    const container = document.getElementById('today-sector-list');
    if (!container) return;

    // FIXED_SECTORS 기반으로 전체 섹터 표시
    const sectorMap = {};
    bySector.forEach(s => { sectorMap[s.CCP] = s.CNT; });

    container.innerHTML = FIXED_SECTORS.map(ccp => {
        const cnt = sectorMap[ccp] || 0;
        const hasData = cnt > 0;
        return `<div class="sector-summary-row ${hasData ? 'has-data' : ''}">
            <span class="sector-summary-name">${getSectorName(ccp)}</span>
            <span class="sector-summary-cnt">${cnt}</span>
        </div>`;
    }).join('');
}

// 페이지 로드 시 초기화
window.onload = init;
