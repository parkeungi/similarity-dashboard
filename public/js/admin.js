// ==================== 전역 변수 ====================

let REPORTS_DATA = [];
let FILTERED_REPORTS = []; // 유사도 등급 필터 적용된 데이터
let DISPLAY_SIMILARITY = []; // 유사도 등급 필터 (설정에서 로드, 빈 배열 = 전체)

// Excel 반출 등급 기준 (settings.json에서 동적 로드)
let EXCEL_GRADES = {
    scoreGrade: { level4: 60, level3: 45, level2: 30 },
    recommendation: { immediate: 70, caution: 40 }
};

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
    const detail = document.getElementById('filter-detail').value;
    const reported = document.getElementById('filter-reported').value;

    let url = '/api/admin/reports?';
    const params = [];

    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    if (type) params.push(`type=${encodeURIComponent(type)}`);
    if (detail) params.push(`typeDetail=${encodeURIComponent(detail)}`);
    if (reported) params.push(`reported=${encodeURIComponent(reported)}`);

    // 선택된 섹터 필터
    const selectedSectors = getSelectedSectors();
    if (selectedSectors.length > 0) {
        params.push(`sectors=${encodeURIComponent(selectedSectors.join(','))}`);
    }

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
            if (result.truncated) {
                alert('조회 결과가 10,000건을 초과합니다. 날짜 또는 섹터 필터를 좁혀주세요.');
            }
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
// 설정에서 표시 섹터 목록 (기본 체크 대상)
let DISPLAY_SECTORS = [];

function loadSectors() {
    const list = document.getElementById('sector-check-list');
    if (!list) return;
    list.innerHTML = '';

    // 전체 섹터 (FIXED_SECTORS + SECTOR_MAP의 나머지)
    const allCodes = [...new Set([...FIXED_SECTORS, ...Object.keys(SECTOR_MAP)])];

    allCodes.forEach(ccp => {
        const isIncheon = INCHEON_SECTORS.includes(ccp);
        list.innerHTML += `
            <label style="display:flex;align-items:center;gap:6px;padding:5px 8px;cursor:pointer;font-size:13px;color:#e2e8f0;border-radius:4px;" onmouseover="this.style.background='rgba(255,255,255,0.05)'" onmouseout="this.style.background=''">
                <input type="checkbox" class="sector-filter-check" value="${ccp}" ${isIncheon ? 'checked' : ''} onchange="updateSectorLabel()">
                <span>${escapeHtml(getSectorName(ccp))}</span>
            </label>`;
    });
    updateSectorLabel();
}

function toggleSectorDropdown() {
    const dd = document.getElementById('sector-filter-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

function toggleAllSectors(master) {
    document.querySelectorAll('.sector-filter-check').forEach(cb => cb.checked = master.checked);
    updateSectorLabel();
    filterTableBySector();
}

function updateSectorLabel() {
    const all = document.querySelectorAll('.sector-filter-check');
    const checked = document.querySelectorAll('.sector-filter-check:checked');
    const btn = document.getElementById('sector-filter-btn');
    const master = document.getElementById('sector-check-all');
    if (master) master.checked = (checked.length === all.length);

    // select의 option 텍스트를 변경하여 표시
    const opt = btn.querySelector('option');
    if (checked.length === 0 || checked.length === all.length) {
        opt.textContent = '전체';
    } else if (checked.length <= 2) {
        opt.textContent = Array.from(checked).map(cb => getSectorName(cb.value)).join(', ');
    } else {
        opt.textContent = checked.length + '개 선택됨';
    }
}

function getSelectedSectors() {
    const all = document.querySelectorAll('.sector-filter-check');
    const checked = document.querySelectorAll('.sector-filter-check:checked');
    if (checked.length === 0 || checked.length === all.length) return [];
    return Array.from(checked).map(cb => cb.value);
}

// 드롭다운 외부 클릭 시 닫기
document.addEventListener('click', function(e) {
    const dd = document.getElementById('sector-filter-dropdown');
    const btn = document.getElementById('sector-filter-btn');
    if (dd && btn && !dd.contains(e.target) && !btn.contains(e.target)) {
        dd.style.display = 'none';
    }
});

// ==================== UI 렌더링 ====================

/**
 * 유사도 등급 필터 적용
 * @param {Array} data - 원본 데이터
 * @returns {Array} 필터링된 데이터 (DISPLAY_SIMILARITY가 비어있으면 전체 반환)
 */
function filterReportsBySimilarity(data) {
    if (!DISPLAY_SIMILARITY || DISPLAY_SIMILARITY.length === 0) return data;
    return data.filter(d => {
        const band = getSimilarityBand(d.SIMILARITY);
        return DISPLAY_SIMILARITY.includes(band);
    });
}

/**
 * 보고서 테이블 렌더링
 * @description REPORTS_DATA를 테이블 형태로 화면에 표시
 */
function renderReports() {
    const tbody = document.getElementById('reports-tbody');

    // 유사도 등급 필터 적용
    FILTERED_REPORTS = filterReportsBySimilarity(REPORTS_DATA);

    // 보고자 입력된 것만 필터 — FILTERED_REPORTS 자체를 갱신하여 data-index 기반 참조 일관성 유지
    const onlyReported = document.getElementById('filter-reported-only')?.checked ?? true;
    if (onlyReported) {
        FILTERED_REPORTS = FILTERED_REPORTS.filter(r => r.REPORTER && r.REPORTER.trim() !== '');
    }
    const filtered = FILTERED_REPORTS;

    document.getElementById('report-count').textContent = filtered.length;

    if (filtered.length === 0) {
        tbody.innerHTML = '<tr><td colspan="11" class="empty-state">조회된 항목이 없습니다</td></tr>';
        return;
    }

    const html = filtered.map((r, index) => {
        const hasReport = r.REPORTED ? true : false;
        const simBand = getSimilarityBand(r.SIMILARITY);
        const simTag = simBand === 'critical' ? 'tag-danger' : simBand === 'caution' ? 'tag-warning' : 'tag-info';
        const simText = simBand === 'critical' ? '매우높음' : simBand === 'caution' ? '높음' : '보통';
        const recBand = getRecommendationBand(r.SIMILARITY, r.SCORE_PEAK);
        const recTag = recBand === 'critical' ? 'tag-danger' : recBand === 'caution' ? 'tag-warning' : 'tag-info';
        const recText = recBand === 'critical' ? '즉시조치' : recBand === 'caution' ? '주의관찰' : '정상감시';
        const reportTag = hasReport ? '<span class="tag tag-danger" style="font-size:11px;">보고완료</span>' : '<span style="color:var(--text-muted);font-size:11px;">-</span>';
        const typeClass = r.TYPE === 1 ? 'tag-danger' : r.TYPE === 2 ? 'tag-warning' : 'tag-info';

        // 검출시각: MM-DD HH:MM 형태로 축약 표시
        const detected = r.DETECTED ? r.DETECTED.substring(5, 16) : '-';

        const reporterCell = r.REPORTER
            ? escapeHtml(r.REPORTER)
            : '<span style="color:var(--text-muted);">-</span>';
        const remarkCell = (r.REMARK && r.REMARK !== '-')
            ? `<span title="${escapeHtml(r.REMARK)}" style="max-width:120px; display:inline-block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; vertical-align:middle;">${escapeHtml(r.REMARK)}</span>`
            : '<span style="color:var(--text-muted);">-</span>';

        return `
            <tr data-index="${index}" style="cursor: pointer;">
                <td><input type="checkbox" class="report-check" data-idx="${escapeHtml(r.IDX)}" data-reported="${escapeHtml(r.REPORTED || '')}"></td>
                <td style="font-size: 12px;">${escapeHtml(detected)}</td>
                <td>${escapeHtml(getSectorName(r.CCP))}</td>
                <td>
                    <div class="callsign-box">
                        <span class="callsign-main">${escapeHtml(r.FP1_CALLSIGN) || '-'}</span>
                        <span class="vs">|</span>
                        <span class="callsign-main">${escapeHtml(r.FP2_CALLSIGN) || '-'}</span>
                    </div>
                </td>
                <td><span class="tag ${simTag}">${simText}</span></td>
                <td><span class="tag ${recTag}">${recText}</span></td>
                <td>${reportTag}</td>
                <td>${hasReport ? '<span class="tag ' + typeClass + '">' + escapeHtml(TYPE_MAP[r.TYPE] || '-') + '</span>' : '<span style="color:var(--text-muted);">-</span>'}</td>
                <td>${hasReport ? '<span class="tag tag-info">' + escapeHtml(IMPACT_MAP[r.TYPE_DETAIL] || '-') + '</span>' : '<span style="color:var(--text-muted);">-</span>'}</td>
                <td style="font-size: 12px;">${reporterCell}</td>
                <td style="font-size: 12px; max-width: 120px;">${remarkCell}</td>
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
    document.getElementById('filter-detail').value = '';
    document.getElementById('filter-reported').value = '';
    const reportedOnly = document.getElementById('filter-reported-only');
    if (reportedOnly) reportedOnly.checked = true;
    // 섹터를 설정 기본값으로 복원
    loadSectors();
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

// 선택 삭제 (일괄 삭제 API 사용)
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
        const items = checked.map(cb => ({
            idx: cb.dataset.idx,
            reported: cb.dataset.reported
        }));

        const response = await fetch('/api/admin/reports/batch-delete', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items })
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const result = await response.json();
        alert(result.message);

        loadReports();
        loadStats();
    } catch (err) {
        console.error('삭제 처리 중 오류:', err);
        alert('삭제 처리 중 오류: ' + err.message);
    }
}

// 편명유사도 등급 변환 (common.js의 동적 설정 기반)
function getSimilarityGrade(val) {
    if (val == null || val === '') return '정의되지 않음';
    const band = getSimilarityBand(val);
    if (band === 'critical') return '매우높음';
    if (band === 'caution') return '높음';
    return '낮음';
}

// 오류발생가능성 등급 변환 (SCORE_PEAK 기준, 동적 설정)
function getScoreGrade(val) {
    if (val == null || val === '') return '';
    const n = Number(val);
    const g = EXCEL_GRADES.scoreGrade;
    if (n > g.level4) return '매우높음';
    if (n > g.level3) return '높음';
    if (n > g.level2) return '낮음';
    return '매우낮음';
}

// 관제사권고사항 (common.js의 동적 설정 기반, SIMILARITY+SCORE_PEAK 종합 판정)
function getRecommendation(similarity, scorePeak) {
    const band = getRecommendationBand(similarity, scorePeak);
    if (band === 'critical') return '즉시조치';
    if (band === 'caution') return '주의관찰';
    return '정상감시';
}

// 검출 목록 섹터 필터 (테이블만 필터링, API 재호출 없음)
function filterTableBySector() {
    const selected = getSelectedSectors();
    const tbody = document.getElementById('reports-tbody');
    const rows = tbody.querySelectorAll('tr[data-index]');
    let visibleCount = 0;

    rows.forEach(tr => {
        const idx = parseInt(tr.dataset.index);
        const r = FILTERED_REPORTS[idx];
        if (!r) return;
        if (selected.length === 0 || selected.includes(r.CCP)) {
            tr.style.display = '';
            visibleCount++;
        } else {
            tr.style.display = 'none';
        }
    });
    document.getElementById('report-count').textContent = visibleCount;
}

// 등급 기준표 토글
function toggleExcelGradeInfo() {
    const el = document.getElementById('excel-grade-info');
    el.style.display = el.style.display === 'none' ? 'block' : 'none';
}

// 등급 기준표 UI 업데이트
function updateExcelGradeInfoUI() {
    const g = EXCEL_GRADES.scoreGrade;
    const r = EXCEL_GRADES.recommendation;
    const el = (id) => document.getElementById(id);
    if (el('eg-score-4')) el('eg-score-4').textContent = `SCORE > ${g.level4}`;
    if (el('eg-score-3')) el('eg-score-3').textContent = `${g.level3} < SCORE ≤ ${g.level4}`;
    if (el('eg-score-2')) el('eg-score-2').textContent = `${g.level2} < SCORE ≤ ${g.level3}`;
    if (el('eg-score-1')) el('eg-score-1').textContent = `SCORE ≤ ${g.level2}`;
    if (el('eg-rec-3')) el('eg-rec-3').textContent = `SCORE ≥ ${r.immediate}`;
    if (el('eg-rec-2')) el('eg-rec-2').textContent = `${r.caution} ≤ SCORE < ${r.immediate}`;
    if (el('eg-rec-1')) el('eg-rec-1').textContent = `0 < SCORE < ${r.caution}`;
}

// 공존시간(분) 계산
function calcCoexistMinutes(detected, cleared) {
    if (!detected || !cleared) return '';
    const d = new Date(detected.replace(' ', 'T'));
    const c = new Date(cleared.replace(' ', 'T'));
    if (isNaN(d) || isNaN(c)) return '';
    return Math.round((c - d) / 60000);
}

// 호출부호에서 항공사 접두어 추출
function extractAirlinePrefix(callsign) {
    if (!callsign) return '';
    const match = callsign.match(/^([A-Z]+)/);
    return match ? match[1] : '';
}

// 항공사국문 조합 (DB에서 조회된 AIRLINE_NAME 사용)
function buildAirlineKorean(fp1Airline, fp2Airline, prefix1, prefix2) {
    const name1 = fp1Airline || prefix1 || '';
    const name2 = fp2Airline || prefix2 || '';
    if (!name1 && !name2) return '';
    if (name1 === name2) return name1;
    return name1 + ' | ' + name2;
}

// AOD_MATCH/FID_LEN_MATCH 값 변환
function matchToText(val) {
    if (val === 'Y' || val === 1 || val === '1') return '일치';
    if (val === 'N' || val === 0 || val === '0') return '불일치';
    return '';
}

// MATCH_POS 숫자 → 텍스트 변환
function matchPosToText(val) {
    const map = { 0: '전체', 1: '앞뒤', 2: '앞', 3: '뒤', 4: '가운데' };
    return map[val] ?? '';
}

// Excel 다운로드 (전체 호출부호 데이터, 샘플 형식)
/**
 * 현재 화면에 표시된 목록을 간략 Excel로 저장
 */
function downloadListExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
        return;
    }

    // 섹터 체크박스 필터 적용
    const selectedSectors = getSelectedSectors();
    let rows = FILTERED_REPORTS;
    if (selectedSectors.length > 0) {
        rows = rows.filter(r => selectedSectors.includes(r.CCP));
    }

    if (!rows || rows.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    const excelData = rows.map(r => {
        const hasReport = r.REPORTED ? true : false;
        const simBand = getSimilarityBand(r.SIMILARITY);
        const simText = simBand === 'critical' ? '매우높음' : simBand === 'caution' ? '높음' : '보통';
        const recBand = getRecommendationBand(r.SIMILARITY, r.SCORE_PEAK);
        const recText = recBand === 'critical' ? '즉시조치' : recBand === 'caution' ? '주의관찰' : '정상감시';

        return {
            '검출시각': r.DETECTED || '',
            '해제시각': r.CLEARED || '',
            '섹터': getSectorName(r.CCP),
            '호출부호1': r.FP1_CALLSIGN || '',
            '호출부호2': r.FP2_CALLSIGN || '',
            '유사도': simText,
            '권고사항': recText,
            '보고여부': hasReport ? 'O' : '-',
            '보고일시': r.REPORTED || '',
            '보고자': r.REPORTER || '',
            '오류항공기': hasReport ? (AO_MAP[r.AO] || '') : '',
            '오류유형': hasReport ? (TYPE_MAP[r.TYPE] || '') : '',
            '세부오류유형': hasReport ? (IMPACT_MAP[r.TYPE_DETAIL] || '') : '',
            '비고': r.REMARK || ''
        };
    });

    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '검출목록');

    ws['!cols'] = [
        { wch: 20 }, { wch: 20 }, { wch: 10 },
        { wch: 12 }, { wch: 12 }, { wch: 10 },
        { wch: 10 }, { wch: 8 }, { wch: 20 },
        { wch: 10 }, { wch: 10 }, { wch: 15 },
        { wch: 15 }, { wch: 30 }
    ];

    const now = new Date();
    const filename = `유사호출부호_검출목록_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;
    XLSX.writeFile(wb, filename);
}

async function downloadExcel() {
    if (typeof XLSX === 'undefined') {
        alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
        return;
    }

    // 현재 필터 조건으로 전체 데이터 조회 (섹터는 클라이언트에서 필터링)
    const from = document.getElementById('filter-from')?.value || '';
    const to = document.getElementById('filter-to')?.value || '';

    let url = '/api/admin/export-data?';
    if (from) url += `from=${encodeURIComponent(from)}&`;
    if (to) url += `to=${encodeURIComponent(to)}`;

    try {
        const resp = await fetch(url);
        const result = await resp.json();
        if (!result.success || !result.data || result.data.length === 0) {
            alert('다운로드할 데이터가 없습니다.');
            return;
        }

        // 유사도 등급 필터 적용
        let rows = filterReportsBySimilarity(result.data);

        // 섹터 체크박스 필터 적용
        const selectedSectors = getSelectedSectors();
        if (selectedSectors.length > 0) {
            rows = rows.filter(r => selectedSectors.includes(r.CCP));
        }

        if (rows.length === 0) {
            alert('선택된 조건에 해당하는 데이터가 없습니다.');
            return;
        }

        // 30개 컬럼 데이터 가공
        const excelData = rows.map(r => {
            const fp1 = r.FP1_CALLSIGN || '';
            const fp2 = r.FP2_CALLSIGN || '';
            const prefix1 = extractAirlinePrefix(fp1);
            const prefix2 = extractAirlinePrefix(fp2);
            const hasReport = r.REPORTED ? true : false;

            return {
                '시작일시(KST)': r.DETECTED || '',
                '종료일시(KST)': r.CLEARED || '',
                '관할섹터명': getSectorName(r.CCP),
                '편명1': fp1,
                '출발공항1': r.FP1_DEPT || '',
                '도착공항1': r.FP1_DEST || '',
                '편명2': fp2,
                '출발공항2': r.FP2_DEPT || '',
                '도착공항2': r.FP2_DEST || '',
                '편명1 | 편명2': fp1 && fp2 ? fp1 + ' | ' + fp2 : '',
                '항공사구분': prefix1 === prefix2 ? prefix1 : (prefix1 + ' | ' + prefix2),
                '항공사국문': buildAirlineKorean(r.FP1_AIRLINE, r.FP2_AIRLINE, prefix1, prefix2),
                '항공사코드동일여부': matchToText(r.AOD_MATCH),
                '편명번호길이동일여부': matchToText(r.FID_LEN_MATCH),
                '편명번호동일숫자위치': matchPosToText(r.MATCH_POS),
                '편명번호동일숫자갯수': r.MATCH_LEN ?? '',
                '편명번호동일숫자구성비율(%)': r.COMP_RAT ?? '',
                '편명유사도': getSimilarityGrade(r.SIMILARITY),
                '최대동시관제량': r.CTRL_PEAK ?? '',
                '공존시간(분)': calcCoexistMinutes(r.DETECTED, r.CLEARED),
                '오류발생가능성': r.SCORE_PEAK ?? '',
                '오류발생가능성_등급': getScoreGrade(r.SCORE_PEAK),
                '관제사권고사항': getRecommendation(r.SIMILARITY, r.SCORE_PEAK),
                '보고여부': Number(r.MARK) === 1 ? 'O' : '',
                '보고일시(KST)': r.REPORTED || '',
                '보고자': r.REPORTER || '',
                '혼돈편명': hasReport ? (r.AO === 1 ? fp1 : r.AO === 2 ? fp2 : r.AO === 3 ? fp1 + ', ' + fp2 : '') : '',
                '오류유형': hasReport ? (TYPE_MAP[r.TYPE] || String(r.TYPE || '')) : '',
                '세부오류유형': hasReport ? (IMPACT_MAP[r.TYPE_DETAIL] || String(r.TYPE_DETAIL || '')) : '',
                '비고': r.REMARK || ''
            };
        });

        // SheetJS로 Excel 생성
        const ws = XLSX.utils.json_to_sheet(excelData);
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, '유사호출부호데이터');

        // 컬럼 너비 설정 (30개)
        ws['!cols'] = [
            { wch: 20 }, { wch: 20 }, { wch: 12 },
            { wch: 12 }, { wch: 8 }, { wch: 8 },
            { wch: 12 }, { wch: 8 }, { wch: 8 },
            { wch: 22 }, { wch: 14 }, { wch: 20 },
            { wch: 16 }, { wch: 18 },
            { wch: 18 }, { wch: 18 }, { wch: 24 },
            { wch: 12 }, { wch: 14 }, { wch: 12 },
            { wch: 18 }, { wch: 18 },
            { wch: 8 }, { wch: 14 },
            { wch: 20 }, { wch: 8 }, { wch: 12 },
            { wch: 12 }, { wch: 14 }, { wch: 30 }
        ];

        // 파일명 생성
        const now = new Date();
        const filename = `유사호출부호_데이터_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;

        XLSX.writeFile(wb, filename);
    } catch (err) {
        console.error('Excel 다운로드 오류:', err);
        alert('Excel 다운로드 중 오류가 발생했습니다.');
    }
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

        // 유사도 등급 필터 적용
        DISPLAY_SIMILARITY = result.data?.displaySimilarity || [];

        // 표시 섹터 설정 (섹터 체크박스 기본값)
        DISPLAY_SECTORS = result.data?.displaySectors || [];

        // Excel 반출 등급 기준 적용
        if (result.data?.excelGrades) {
            const eg = result.data.excelGrades;
            if (eg.scoreGrade) EXCEL_GRADES.scoreGrade = { level4: eg.scoreGrade.level4 ?? 60, level3: eg.scoreGrade.level3 ?? 45, level2: eg.scoreGrade.level2 ?? 30 };
            if (eg.recommendation) EXCEL_GRADES.recommendation = { immediate: eg.recommendation.immediate ?? 70, caution: eg.recommendation.caution ?? 40 };
            updateExcelGradeInfoUI();
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
        await Promise.all([loadErrorDetailTypes(), loadSectors()]);
        await Promise.all([loadReports(), loadStats(), loadCallsignStats()]);

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
                    <span>${escapeHtml(getSectorName(ccp))}</span>
                </label>`).join('');
        }

        // 유사도 체크박스
        const simLevels = data.displaySimilarity || [];
        DISPLAY_SIMILARITY = simLevels;
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

            DISPLAY_SIMILARITY = selectedSimilarity;
            alert('설정이 저장되었습니다.\n모든 관제사 화면에 즉시 적용됩니다.\n필요 시 start.bat 재시작으로도 적용됩니다.');
            loadSettings();
            renderReports(); // 유사도 필터 변경 반영
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
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// ==================== 보고서 상세 보기 ====================

// 상세 보기 모달 표시
function showReportDetail(index) {
    const r = FILTERED_REPORTS[index];
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
                <div class="h-bar-label">${escapeHtml(getSectorName(s.CCP))}</div>
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
            <span class="sector-summary-name">${escapeHtml(getSectorName(ccp))}</span>
            <span class="sector-summary-cnt">${cnt}</span>
        </div>`;
    }).join('');
}

// ==================== 항공사 제출 뷰 ====================

let AIRLINE_DATA = [];
let AIRLINE_DATA_RAW = []; // 필터 전 원본
let airlinePage = 1;
let airlinePageSize = 100;
let airlineSelectedSectors = [...INCHEON_SECTORS]; // 기본: 인천 섹터

function switchView(view) {
    const reportsView = document.getElementById('view-reports');
    const airlineView = document.getElementById('view-airline');
    const tabReports = document.getElementById('tab-reports');
    const tabAirline = document.getElementById('tab-airline');

    if (view === 'airline') {
        reportsView.style.display = 'none';
        airlineView.style.display = 'block';
        tabReports.classList.remove('active');
        tabAirline.classList.add('active');
        if (!document.getElementById('airline-from').value) {
            initAirlineSectorCheckboxes();
            setAirlineDatePreset('month');
            loadAirlineData();
        }
    } else {
        reportsView.style.display = '';
        airlineView.style.display = 'none';
        tabReports.classList.add('active');
        tabAirline.classList.remove('active');
    }
}

function setAirlineDatePreset(period) {
    const today = new Date();
    const toStr = today.toISOString().slice(0, 10);
    let fromStr = toStr;

    if (period === 'today') {
        fromStr = toStr;
    } else if (period === 'week') {
        const d = new Date(today);
        d.setDate(d.getDate() - 7);
        fromStr = d.toISOString().slice(0, 10);
    } else if (period === 'month') {
        fromStr = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
    } else if (period === '3month') {
        const d = new Date(today);
        d.setMonth(d.getMonth() - 3);
        fromStr = d.toISOString().slice(0, 10);
    }

    document.getElementById('airline-from').value = fromStr;
    document.getElementById('airline-to').value = toStr;

    // 직접입력이면 날짜 입력 표시
    const rangeGroup = document.getElementById('airline-date-range-group');
    rangeGroup.style.display = period === 'custom' ? 'flex' : 'none';

    // 버튼 active 상태
    document.querySelectorAll('[data-airline-period]').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.airlinePeriod === period);
    });

    if (period !== 'custom') loadAirlineData();
}

// 섹터 체크박스 초기화
function initAirlineSectorCheckboxes() {
    const container = document.getElementById('airline-sector-list');
    if (!container) return;
    const allCodes = Object.keys(SECTOR_MAP);
    container.innerHTML = allCodes.map(code => {
        const checked = airlineSelectedSectors.includes(code) ? 'checked' : '';
        return `<label style="display:flex;align-items:center;gap:6px;padding:4px 8px;cursor:pointer;font-size:13px;">
            <input type="checkbox" value="${code}" ${checked} onchange="onAirlineSectorChange()"> ${escapeHtml(SECTOR_MAP[code])}
        </label>`;
    }).join('');
    updateAirlineSectorBtn();
}

function toggleAirlineSectorDropdown() {
    const dd = document.getElementById('airline-sector-dropdown');
    dd.style.display = dd.style.display === 'none' ? 'block' : 'none';
}

// 드롭다운 외부 클릭 시 닫기
document.addEventListener('click', (e) => {
    const dd = document.getElementById('airline-sector-dropdown');
    if (dd && dd.style.display === 'block' && !e.target.closest('#airline-sector-dropdown') && !e.target.closest('#airline-sector-btn')) {
        dd.style.display = 'none';
    }
});

function toggleAirlineAllSectors(el) {
    const checks = document.querySelectorAll('#airline-sector-list input[type=checkbox]');
    checks.forEach(c => { c.checked = el.checked; });
    onAirlineSectorChange();
}

function onAirlineSectorChange() {
    const checks = document.querySelectorAll('#airline-sector-list input[type=checkbox]:checked');
    airlineSelectedSectors = Array.from(checks).map(c => c.value);
    // 전체 체크박스 동기화
    const allCheck = document.getElementById('airline-sector-all');
    const total = document.querySelectorAll('#airline-sector-list input[type=checkbox]').length;
    if (allCheck) allCheck.checked = airlineSelectedSectors.length === total;
    updateAirlineSectorBtn();
    applyAirlineSectorFilter();
}

function updateAirlineSectorBtn() {
    const btn = document.getElementById('airline-sector-btn');
    if (!btn) return;
    const total = Object.keys(SECTOR_MAP).length;
    if (airlineSelectedSectors.length === 0 || airlineSelectedSectors.length === total) {
        btn.textContent = '전체 섹터';
    } else if (airlineSelectedSectors.length <= 3) {
        btn.textContent = airlineSelectedSectors.map(c => SECTOR_MAP[c] || c).join(', ');
    } else {
        btn.textContent = `${airlineSelectedSectors.length}개 섹터`;
    }
}

function applyAirlineSectorFilter() {
    if (airlineSelectedSectors.length === 0) {
        AIRLINE_DATA = AIRLINE_DATA_RAW;
    } else {
        AIRLINE_DATA = AIRLINE_DATA_RAW.filter(r => airlineSelectedSectors.includes(String(r.CCP)));
    }
    airlinePage = 1;
    renderAirlineTable();
}

/**
 * 항공기 쌍의 FP1/FP2를 알파벳 오름차순으로 정규화
 * - FP1_CALLSIGN > FP2_CALLSIGN 이면 FP1/FP2 관련 필드 전체를 교환
 * - AO(오류항공기) 값도 함께 반전: 1↔2, 3 유지
 * @param {Object} r - export-data 행 원본
 * @returns {Object} 정규화된 행
 */
// 항공사 보고자료 목록·엑셀 반출 전용: 국내 항공사 ICAO 접두어 집합
const DOMESTIC_PREFIXES = new Set(['KAL','AAR','JJA','JNA','TWB','ABL','ASV','APZ','ESR','EOK','AIH','PTA']);

/**
 * 두 호출부호의 정렬 우선순위 비교
 * 국내 항공사(0) < 외항사(1), 같은 그룹 내에서는 알파벳 오름차순
 * @param {string} a
 * @param {string} b
 * @returns {number} 음수=a가 앞, 양수=b가 앞, 0=동일
 */
function compareCallsignOrder(a, b) {
    const pa = extractAirlinePrefix(a);
    const pb = extractAirlinePrefix(b);
    const da = DOMESTIC_PREFIXES.has(pa) ? 0 : 1;
    const db = DOMESTIC_PREFIXES.has(pb) ? 0 : 1;
    if (da !== db) return da - db;
    return a <= b ? -1 : 1;
}

function normalizeAirlineRow(r) {
    const fp1 = r.FP1_CALLSIGN || '';
    const fp2 = r.FP2_CALLSIGN || '';
    if (compareCallsignOrder(fp1, fp2) <= 0) return r;
    const ao = r.AO;
    return {
        ...r,
        FP1_CALLSIGN: fp2, FP1_DEPT: r.FP2_DEPT, FP1_DEST: r.FP2_DEST, FP1_AIRLINE: r.FP2_AIRLINE,
        FP2_CALLSIGN: fp1, FP2_DEPT: r.FP1_DEPT, FP2_DEST: r.FP1_DEST, FP2_AIRLINE: r.FP1_AIRLINE,
        AO: ao === 1 ? 2 : ao === 2 ? 1 : ao
    };
}

async function loadAirlineData() {
    const from = document.getElementById('airline-from').value;
    const to = document.getElementById('airline-to').value;
    if (!from || !to) { alert('기간을 설정해주세요.'); return; }

    let url = `/api/admin/export-data?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    try {
        const resp = await fetch(url);
        const result = await resp.json();
        if (!result.success) { alert('데이터 조회 실패'); return; }
        AIRLINE_DATA_RAW = filterReportsBySimilarity(result.data || []).map(normalizeAirlineRow);
        applyAirlineSectorFilter();
    } catch (err) {
        console.error('항공사 데이터 조회 오류:', err);
        alert('데이터 조회 중 오류가 발생했습니다.');
    }
}

function renderAirlineTable() {
    const tbody = document.getElementById('airline-tbody');
    const totalCount = AIRLINE_DATA.length;
    document.getElementById('airline-count').textContent = totalCount;

    const totalPages = Math.max(1, Math.ceil(totalCount / airlinePageSize));
    if (airlinePage > totalPages) airlinePage = totalPages;

    const start = (airlinePage - 1) * airlinePageSize;
    const pageData = AIRLINE_DATA.slice(start, start + airlinePageSize);

    const COL_COUNT = 30;
    tbody.innerHTML = pageData.length === 0
        ? `<tr><td colspan="${COL_COUNT}" style="text-align:center;color:var(--text-muted);padding:40px;">조회된 항목이 없습니다</td></tr>`
        : pageData.map(r => {
            const fp1 = r.FP1_CALLSIGN || '';
            const fp2 = r.FP2_CALLSIGN || '';
            const prefix1 = extractAirlinePrefix(fp1);
            const prefix2 = extractAirlinePrefix(fp2);
            const hasReport = r.REPORTED ? true : false;
            const reported = Number(r.MARK) === 1;

            return `<tr>
                <td>${escapeHtml(r.DETECTED || '')}</td>
                <td>${escapeHtml(r.CLEARED || '')}</td>
                <td>${escapeHtml(getSectorName(r.CCP))}</td>
                <td><strong>${escapeHtml(fp1)}</strong></td>
                <td>${escapeHtml(r.FP1_DEPT || '')}</td>
                <td>${escapeHtml(r.FP1_DEST || '')}</td>
                <td><strong>${escapeHtml(fp2)}</strong></td>
                <td>${escapeHtml(r.FP2_DEPT || '')}</td>
                <td>${escapeHtml(r.FP2_DEST || '')}</td>
                <td>${escapeHtml(fp1 && fp2 ? fp1 + ' | ' + fp2 : '')}</td>
                <td>${escapeHtml(prefix1 === prefix2 ? prefix1 : prefix1 + ' | ' + prefix2)}</td>
                <td>${escapeHtml(buildAirlineKorean(r.FP1_AIRLINE, r.FP2_AIRLINE, prefix1, prefix2))}</td>
                <td>${escapeHtml(matchToText(r.AOD_MATCH))}</td>
                <td>${escapeHtml(matchToText(r.FID_LEN_MATCH))}</td>
                <td>${escapeHtml(matchPosToText(r.MATCH_POS))}</td>
                <td style="text-align:right;">${r.MATCH_LEN ?? ''}</td>
                <td style="text-align:right;">${r.COMP_RAT ?? ''}</td>
                <td>${escapeHtml(getSimilarityGrade(r.SIMILARITY))}</td>
                <td style="text-align:right;">${r.CTRL_PEAK ?? ''}</td>
                <td style="text-align:right;">${calcCoexistMinutes(r.DETECTED, r.CLEARED)}</td>
                <td style="text-align:right;">${r.SCORE_PEAK ?? ''}</td>
                <td>${escapeHtml(getScoreGrade(r.SCORE_PEAK))}</td>
                <td>${escapeHtml(getRecommendation(r.SIMILARITY, r.SCORE_PEAK))}</td>
                <td style="text-align:center;color:${reported ? 'var(--accent-secondary)' : 'var(--text-muted)'};">${reported ? 'O' : ''}</td>
                <td>${escapeHtml(r.REPORTED || '')}</td>
                <td>${escapeHtml(r.REPORTER || '')}</td>
                <td>${hasReport ? escapeHtml(r.AO === 1 ? fp1 : r.AO === 2 ? fp2 : r.AO === 3 ? fp1 + ', ' + fp2 : '') : ''}</td>
                <td>${hasReport ? escapeHtml(TYPE_MAP[r.TYPE] || '') : ''}</td>
                <td>${hasReport ? escapeHtml(IMPACT_MAP[r.TYPE_DETAIL] || '') : ''}</td>
                <td>${escapeHtml(r.REMARK || '')}</td>
            </tr>`;
        }).join('');

    renderAirlinePagination(totalPages);
}

function renderAirlinePagination(totalPages) {
    const container = document.getElementById('airline-pagination');
    if (totalPages <= 1) { container.innerHTML = ''; return; }

    let html = `<button class="pagination-btn" onclick="goAirlinePage(1)" ${airlinePage === 1 ? 'disabled' : ''}>&laquo;</button>`;
    html += `<button class="pagination-btn" onclick="goAirlinePage(${airlinePage - 1})" ${airlinePage === 1 ? 'disabled' : ''}>&lsaquo;</button>`;

    let startPage = Math.max(1, airlinePage - 2);
    let endPage = Math.min(totalPages, startPage + 4);
    if (endPage - startPage < 4) startPage = Math.max(1, endPage - 4);

    for (let i = startPage; i <= endPage; i++) {
        html += `<button class="pagination-btn ${i === airlinePage ? 'active' : ''}" onclick="goAirlinePage(${i})">${i}</button>`;
    }

    html += `<button class="pagination-btn" onclick="goAirlinePage(${airlinePage + 1})" ${airlinePage === totalPages ? 'disabled' : ''}>&rsaquo;</button>`;
    html += `<button class="pagination-btn" onclick="goAirlinePage(${totalPages})" ${airlinePage === totalPages ? 'disabled' : ''}>&raquo;</button>`;
    html += `<span style="font-size:12px;color:var(--text-muted);margin-left:8px;">${airlinePage} / ${totalPages}</span>`;

    container.innerHTML = html;
}

function goAirlinePage(page) {
    airlinePage = page;
    renderAirlineTable();
    document.getElementById('airline-table').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function changeAirlinePageSize() {
    airlinePageSize = parseInt(document.getElementById('airline-page-size').value);
    airlinePage = 1;
    renderAirlineTable();
}

// 날짜 문자열("YYYY-MM-DD HH:mm:ss")을 Excel 시리얼넘버로 변환
function dateToExcelSerial(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr.replace(' ', 'T'));
    if (isNaN(d.getTime())) return dateStr;
    // Excel epoch: 1899-12-30, 1일 = 86400000ms
    const EXCEL_EPOCH = new Date(1899, 11, 30).getTime();
    return (d.getTime() - EXCEL_EPOCH) / 86400000;
}

async function exportAirlineExcel() {
    if (AIRLINE_DATA.length === 0) {
        alert('먼저 검색을 실행해주세요.');
        return;
    }
    if (typeof XLSX === 'undefined') {
        alert('Excel 내보내기 라이브러리를 불러올 수 없습니다.');
        return;
    }

    // 매우높음/높음만 필터 + 보고자 있는 행은 등급 무관 포함 + 중복 제거 (편명1+편명2 기준)
    const filtered = AIRLINE_DATA.filter(r => {
        const band = getSimilarityBand(r.SIMILARITY);
        return band === 'critical' || band === 'caution' || (r.REPORTER && r.REPORTER.trim() !== '');
    });
    const seen = new Set();
    const rows = filtered.filter(r => {
        const key = (r.FP1_CALLSIGN || '') + '|' + (r.FP2_CALLSIGN || '');
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    if (rows.length === 0) {
        alert('매우높음/높음 등급의 데이터가 없습니다.');
        return;
    }

    const excelData = rows.map(r => {
        const fp1 = r.FP1_CALLSIGN || '';
        const fp2 = r.FP2_CALLSIGN || '';
        const prefix1 = extractAirlinePrefix(fp1);
        const prefix2 = extractAirlinePrefix(fp2);
        const hasReport = r.REPORTED ? true : false;

        return {
            '시작일시(KST)': dateToExcelSerial(r.DETECTED),
            '종료일시(KST)': dateToExcelSerial(r.CLEARED),
            '관할섹터명': getSectorName(r.CCP),
            '편명1': fp1,
            '출발공항1': r.FP1_DEPT || '',
            '도착공항1': r.FP1_DEST || '',
            '편명2': fp2,
            '출발공항2': r.FP2_DEPT || '',
            '도착공항2': r.FP2_DEST || '',
            '편명1 | 편명2': fp1 && fp2 ? fp1 + ' | ' + fp2 : '',
            '항공사구분': prefix1 === prefix2 ? prefix1 : (prefix1 + ' | ' + prefix2),
            '항공사국문': buildAirlineKorean(r.FP1_AIRLINE, r.FP2_AIRLINE, prefix1, prefix2),
            '항공사코드동일여부': matchToText(r.AOD_MATCH),
            '편명번호길이동일여부': matchToText(r.FID_LEN_MATCH),
            '편명번호동일숫자위치': matchPosToText(r.MATCH_POS),
            '편명번호동일숫자갯수': r.MATCH_LEN ?? '',
            '편명번호동일숫자구성비율(%)': r.COMP_RAT ?? '',
            '편명유사도': getSimilarityGrade(r.SIMILARITY),
            '최대동시관제량': r.CTRL_PEAK ?? '',
            '공존시간(분)': calcCoexistMinutes(r.DETECTED, r.CLEARED),
            '오류발생가능성': r.SCORE_PEAK ?? '',
            '오류발생가능성_등급': getScoreGrade(r.SCORE_PEAK),
            '보고여부': Number(r.MARK) === 1 ? 'O' : '',
            '관제사권고사항': getRecommendation(r.SIMILARITY, r.SCORE_PEAK),
            '보고일시(KST)': dateToExcelSerial(r.REPORTED),
            '보고자': r.REPORTER || '',
            '혼돈편명': hasReport ? (r.AO === 1 ? fp1 : r.AO === 2 ? fp2 : r.AO === 3 ? fp1 + ', ' + fp2 : '') : '',
            '오류유형': hasReport ? (TYPE_MAP[r.TYPE] || String(r.TYPE || '')) : '',
            '세부오류유형': hasReport ? (IMPACT_MAP[r.TYPE_DETAIL] || String(r.TYPE_DETAIL || '')) : '',
            '비고': r.REMARK || ''
        };
    });

    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '유사호출부호데이터');

    // 날짜 셀에 서식 적용 (시리얼넘버 → 날짜 표시)
    const dateFormat = 'yyyy-mm-dd hh:mm:ss';
    const range = XLSX.utils.decode_range(ws['!ref']);
    for (let R = range.s.r + 1; R <= range.e.r; R++) {
        // col 0: 시작일시, col 1: 종료일시, col 24: 보고일시
        [0, 1, 24].forEach(C => {
            const addr = XLSX.utils.encode_cell({ r: R, c: C });
            if (ws[addr] && typeof ws[addr].v === 'number') {
                ws[addr].t = 'n';
                ws[addr].z = dateFormat;
            }
        });
    }

    ws['!cols'] = [
        { wch: 20 }, { wch: 20 }, { wch: 12 },
        { wch: 12 }, { wch: 8 }, { wch: 8 },
        { wch: 12 }, { wch: 8 }, { wch: 8 },
        { wch: 22 }, { wch: 14 }, { wch: 20 },
        { wch: 16 }, { wch: 18 },
        { wch: 18 }, { wch: 18 }, { wch: 24 },
        { wch: 12 }, { wch: 14 }, { wch: 12 },
        { wch: 18 }, { wch: 18 },
        { wch: 8 }, { wch: 20 },
        { wch: 20 }, { wch: 8 }, { wch: 12 },
        { wch: 12 }, { wch: 14 }, { wch: 30 }
    ];

    const now = new Date();
    const filename = `유사호출부호_항공사제출_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;
    XLSX.writeFile(wb, filename);
}

// 페이지 로드 시 초기화
window.onload = init;
