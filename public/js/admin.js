// ==================== 전역 변수 ====================

let REPORTS_DATA = [];

// ==================== 코드 매핑 (admin.js 전용) ====================

/**
 * 오류 유형 코드 → 텍스트 매핑
 * @type {Object<number, string>}
 */
const TYPE_MAP = {
    1: '관제사 오류',
    2: '조종사 오류',
    3: '복창오류',
    4: '무응답/재호출',
    5: '기타'
};

/**
 * 안전 영향도 코드 → 텍스트 매핑
 * @type {Object<number, string>}
 */
const IMPACT_MAP = {
    1: '경미',
    2: '보통',
    3: '심각'
};

/**
 * 오류 항공기 코드 → 텍스트 매핑
 * @type {Object<number, string>}
 */
const AO_MAP = {
    1: 'FP1',
    2: 'FP2',
    3: '양쪽 모두'
};

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

    let url = '/api/admin/reports?';
    const params = [];

    if (from) params.push(`from=${encodeURIComponent(from)}`);
    if (to) params.push(`to=${encodeURIComponent(to + ' 23:59:59')}`);
    if (type) params.push(`type=${encodeURIComponent(type)}`);
    if (sector && sector !== 'ALL') params.push(`sector=${encodeURIComponent(sector)}`);

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

            // 유형별 통계 (TYPE: 1~5)
            for (let i = 1; i <= 5; i++) {
                const cnt = stats.byType.find(t => t.TYPE === i)?.CNT || 0;
                document.getElementById('stat-type' + i).textContent = cnt;
            }

            // 오늘 건수
            const today = new Date().toISOString().split('T')[0];
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
        const impactClass = r.TYPE_DETAIL === 3 ? 'tag-danger' : r.TYPE_DETAIL === 2 ? 'tag-warning' : 'tag-info';

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

    // 행 클릭 이벤트 바인딩 (체크박스 제외)
    tbody.querySelectorAll('tr[data-index]').forEach(row => {
        row.addEventListener('click', (e) => {
            if (e.target.type === 'checkbox') return;
            const index = parseInt(row.dataset.index, 10);
            showReportDetail(index);
        });
    });
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
    const today = new Date().toISOString().split('T')[0];
    document.getElementById('filter-from').value = today;
    document.getElementById('filter-to').value = today;
    document.getElementById('filter-type').value = '';
    document.getElementById('filter-sector').value = 'ALL';
    loadReports();
    loadStats();
    loadCallsignStats();
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
    if (REPORTS_DATA.length === 0) {
        alert('다운로드할 데이터가 없습니다.');
        return;
    }

    // 데이터 가공
    const excelData = REPORTS_DATA.map(r => ({
        '보고일시': r.REPORTED || '',
        '섹터': getSectorName(r.CCP),
        '유사호출부호': `${r.FP1_CALLSIGN || ''} | ${r.FP2_CALLSIGN || ''}`,
        '보고자': r.REPORTER || '',
        '오류유형': TYPE_MAP[r.TYPE] || '',
        '안전영향도': IMPACT_MAP[r.TYPE_DETAIL] || '',
        '오류항공기': AO_MAP[r.AO] || '',
        '비고': r.REMARK || ''
    }));

    // SheetJS로 Excel 생성
    const ws = XLSX.utils.json_to_sheet(excelData);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '오류보고서');

    // 컬럼 너비 설정 (보고일시, 섹터, 유사호출부호, 보고자, 오류유형, 안전영향도, 오류항공기, 비고)
    ws['!cols'] = [
        { wch: 20 }, { wch: 10 }, { wch: 25 }, { wch: 8 },
        { wch: 15 }, { wch: 12 }, { wch: 12 }, { wch: 30 }
    ];

    // 파일명 생성
    const now = new Date();
    const filename = `유사호출부호_오류보고서_${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}.xlsx`;

    // 다운로드
    XLSX.writeFile(wb, filename);
}

// 초기화
async function init() {
    try {
        // 기본 날짜 필터 설정 (오늘 ~ 오늘)
        const today = new Date().toISOString().split('T')[0];

        document.getElementById('filter-to').value = today;
        document.getElementById('filter-from').value = today;

        await loadSectors();
        await loadReports();
        await loadStats();
        await loadCallsignStats(); // 호출부호 데이터 통계 로드

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
        loadSectorCheckboxes();
    } else {
        section.style.display = 'none';
    }
}

// 섹터 체크박스 로드 (고정 섹터 목록 기반)
async function loadSectorCheckboxes() {
    try {
        const container = document.getElementById('sector-checkboxes');
        const settingsRes = await fetch('/api/config');
        if (!settingsRes.ok) {
            throw new Error(`HTTP ${settingsRes.status}`);
        }
        const settings = await settingsRes.json();
        const selectedSectors = settings.data?.displaySectors || [];

        container.innerHTML = FIXED_SECTORS.map(ccp => `
            <label style="display: flex; align-items: center; gap: 5px; padding: 8px 12px; background: rgba(30,41,59,0.5); border-radius: 6px; cursor: pointer;">
                <input type="checkbox" class="sector-checkbox" value="${ccp}"
                       ${selectedSectors.includes(String(ccp)) ? 'checked' : ''}>
                <span>${getSectorName(ccp)}</span>
            </label>
        `).join('');
    } catch (err) {
        console.error('섹터 목록 로드 실패:', err);
    }
}

// 환경설정 불러오기
async function loadSettings() {
    try {
        const response = await fetch('/api/config');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            const data = result.data;

            // 갱신 주기
            document.getElementById('setting-refresh').value = data.refreshRate || 10000;
            // 최대 표시 건수
            document.getElementById('setting-maxrows').value = data.maxRows || 100;

            // 유사도 등급 체크박스 복원
            const simLevels = data.displaySimilarity || [];
            document.querySelectorAll('.similarity-checkbox').forEach(cb => {
                cb.checked = simLevels.includes(cb.value);
            });

            // 마지막 수정 정보
            if (data.updatedAt) {
                document.getElementById('settings-info').style.display = 'block';
                document.getElementById('settings-updated').textContent =
                    `${data.updatedAt.replace('T', ' ').slice(0, 19)} (${data.updatedBy || 'admin'})`;
            }
        }
    } catch (err) {
        console.error('설정 로드 실패:', err);
    }
}

// 환경설정 저장
async function saveSettings() {
    try {
        // 선택된 섹터 수집
        const checkboxes = document.querySelectorAll('.sector-checkbox:checked');
        const selectedSectors = Array.from(checkboxes).map(cb => cb.value);

        // 선택된 유사도 등급 수집
        const simCheckboxes = document.querySelectorAll('.similarity-checkbox:checked');
        const selectedSimilarity = Array.from(simCheckboxes).map(cb => cb.value);

        const settings = {
            displaySectors: selectedSectors,
            displaySimilarity: selectedSimilarity,
            refreshRate: parseInt(document.getElementById('setting-refresh').value, 10),
            maxRows: parseInt(document.getElementById('setting-maxrows').value, 10),
            updatedBy: 'admin'
        };

        const response = await fetch('/api/config', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(settings)
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }
        const result = await response.json();

        if (result.success) {
            alert('설정이 저장되었습니다.\n모든 관제사 화면에 즉시 적용됩니다.');
            loadSettings();
        } else {
            throw new Error(result.error);
        }
    } catch (err) {
        console.error('설정 저장 실패:', err);
        alert('설정 저장 실패: ' + err.message);
    }
}

// ==================== 보고서 상세 보기 ====================

// 상세 보기 모달 표시
function showReportDetail(index) {
    const r = REPORTS_DATA[index];
    if (!r) return;

    const typeClass = r.TYPE === 1 ? 'tag-danger' : r.TYPE === 2 ? 'tag-warning' : 'tag-info';
    const impactClass = r.TYPE_DETAIL === 3 ? 'tag-danger' : r.TYPE_DETAIL === 2 ? 'tag-warning' : 'tag-info';

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
                    <div class="detail-label">안전영향도</div>
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
    const currentMonth = new Date().toISOString().slice(0, 7);

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

// 오류유형별 가로 막대 차트
function renderTypeChart(byType, total) {
    const container = document.getElementById('type-chart');

    // TYPE 1~5 전체 표시
    const typeData = [];
    for (let i = 1; i <= 5; i++) {
        const found = byType.find(t => t.TYPE === i);
        typeData.push({
            type: i,
            name: TYPE_MAP[i],
            cnt: found ? found.CNT : 0
        });
    }

    const maxCnt = Math.max(...typeData.map(t => t.cnt), 1);

    const html = typeData.map(t => {
        const pct = maxCnt > 0 ? (t.cnt / maxCnt) * 100 : 0;
        const ratio = total > 0 ? ((t.cnt / total) * 100).toFixed(1) : 0;
        return `
            <div class="h-bar-row">
                <div class="h-bar-label" style="width: 80px;">${t.name}</div>
                <div class="h-bar-track">
                    <div class="h-bar-fill type-${t.type}" style="width: ${pct}%;">
                        ${pct > 15 ? `<span class="h-bar-value">${ratio}%</span>` : ''}
                    </div>
                </div>
                <div class="h-bar-count">${t.cnt}건</div>
            </div>
        `;
    }).join('');

    container.innerHTML = html;
}

// 페이지 로드 시 초기화
window.onload = init;
