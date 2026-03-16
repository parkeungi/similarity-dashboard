const express = require('express');
const router = express.Router();
const oracledb = require('oracledb');
const fs = require('fs');
const db = require('../config/database');
const { kstToUtc, utcToKst, convertRowsToKst, getKstToday, getKstNow, getSeasonalLookback } = require('../config/timeUtil');
const { getCachedSettings, invalidateCache, normalizeThresholds, SETTINGS_PATH } = require('../config/settingsCache');

// Oracle 쿼리 타임아웃 (30초) - Oracle 11g Thick에서는 callTimeout 미지원
// JS 레벨 Promise.race로 구현
const QUERY_TIMEOUT = 30000;

function executeWithTimeout(conn, sql, binds, options) {
    return Promise.race([
        conn.execute(sql, binds, options),
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error('쿼리 타임아웃 (30초 초과)')), QUERY_TIMEOUT)
        )
    ]);
}

// 에러 메시지 안전하게 처리 (내부 정보 노출 방지)
function safeErrorMessage(err) {
    console.error('Error:', err); // 서버 로그에만 상세 기록
    return '요청 처리 중 오류가 발생했습니다.';
}

function getDefaultSettings() {
    return {
        displaySectors: [],
        displaySimilarity: [],
        refreshRate: 10000,
        maxRows: 100,
        sectorMap: {},
        fixedSectors: [],
        errorTypes: [
            { value: 1, label: '관제사 오류' },
            { value: 2, label: '조종사 오류' }
        ],
        errorDetailTypes: [
            { value: 1, label: '고도이탈' },
            { value: 2, label: '비행경로이탈' },
            { value: 3, label: '복창오류' },
            { value: 4, label: '무응답/재호출' },
            { value: 5, label: '기타' }
        ],
        thresholds: normalizeThresholds()
    };
}

// 설정 읽기 (mtime 기반 캐싱)
function getSettings() {
    const defaults = getDefaultSettings();
    try {
        const parsed = getCachedSettings();
        if (!parsed) return defaults;
        return {
            displaySectors: Array.isArray(parsed.displaySectors) ? parsed.displaySectors : defaults.displaySectors,
            displaySimilarity: Array.isArray(parsed.displaySimilarity) ? parsed.displaySimilarity : defaults.displaySimilarity,
            refreshRate: Number(parsed.refreshRate) > 0 ? Number(parsed.refreshRate) : defaults.refreshRate,
            maxRows: Number(parsed.maxRows) > 0 ? Number(parsed.maxRows) : defaults.maxRows,
            sectorMap: (parsed.sectorMap && typeof parsed.sectorMap === 'object' && !Array.isArray(parsed.sectorMap))
                ? parsed.sectorMap
                : defaults.sectorMap,
            fixedSectors: Array.isArray(parsed.fixedSectors) ? parsed.fixedSectors.map(v => String(v)) : defaults.fixedSectors,
            errorTypes: Array.isArray(parsed.errorTypes) ? parsed.errorTypes : defaults.errorTypes,
            errorDetailTypes: Array.isArray(parsed.errorDetailTypes) ? parsed.errorDetailTypes : defaults.errorDetailTypes,
            thresholds: normalizeThresholds(parsed.thresholds),
            excelGrades: parsed.excelGrades || { scoreGrade: { level4: 60, level3: 45, level2: 30 }, recommendation: { immediate: 70, caution: 40 } },
            updatedAt: parsed.updatedAt,
            updatedBy: parsed.updatedBy || 'admin'
        };
    } catch (err) {
        console.error('설정 파일 읽기 실패:', err);
        return defaults;
    }
}

/**
 * 유사도 필터 SQL 조건 생성 (바인드 변수 사용)
 * @param {string[]} displaySimilarity - ['critical', 'caution', 'monitor']
 * @param {Object} thresholds - 위험도 기준값
 * @param {Object} binds - 바인드 변수 객체 (이 함수가 직접 추가)
 * @param {string} [colPrefix=''] - 컬럼 접두어 (예: 'T.' 또는 'c.')
 * @returns {string} SQL WHERE 조건 (빈 배열이면 빈 문자열)
 */
function buildSimilarityFilter(displaySimilarity, thresholds, binds = {}, colPrefix = '') {
    if (!displaySimilarity || displaySimilarity.length === 0) {
        return ''; // 필터 없음 = 전체 표시
    }

    const simThresholds = normalizeThresholds(thresholds).similarity;
    const conditions = [];
    const col = colPrefix + 'SIMILARITY';
    let needCritical = false, needCaution = false;

    if (displaySimilarity.includes('critical')) {
        conditions.push(`${col} > :simCritical`);
        needCritical = true;
    }
    if (displaySimilarity.includes('caution')) {
        conditions.push(`(${col} > :simCaution AND ${col} <= :simCritical)`);
        needCritical = true;
        needCaution = true;
    }
    if (displaySimilarity.includes('monitor')) {
        conditions.push(`${col} <= :simCaution`);
        needCaution = true;
    }

    // SQL에서 실제 참조되는 바인드만 추가 (미사용 바인드 → ORA-01036)
    if (needCritical) binds.simCritical = simThresholds.critical;
    if (needCaution) binds.simCaution = simThresholds.caution;

    if (conditions.length === 0) {
        return '';
    }

    return ' AND (' + conditions.join(' OR ') + ')';
}

// 설정 저장 (캐시 무효화 포함)
function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
    invalidateCache();
}

// 환경설정 조회
router.get('/config', (req, res) => {
    try {
        const settings = getSettings();
        res.json({ success: true, data: settings });
    } catch (err) {
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    }
});

// 환경설정 저장
router.post('/config', (req, res) => {
    try {
        const { displaySectors, displaySimilarity, refreshRate, maxRows, updatedBy,
                sectorMap, fixedSectors, errorTypes, errorDetailTypes, thresholds } = req.body;
        const currentSettings = getSettings();

        // --- 입력 유효성 검사 ---
        // sectorMap: { "코드(숫자)": "이름" }
        if (sectorMap) {
            if (typeof sectorMap !== 'object' || Array.isArray(sectorMap))
                return res.status(400).json({ success: false, error: '잘못된 섹터맵 형식' });
            for (const [code, name] of Object.entries(sectorMap)) {
                if (!/^\d{1,5}$/.test(code))
                    return res.status(400).json({ success: false, error: `잘못된 섹터 코드: ${code}` });
                if (typeof name !== 'string' || name.trim().length === 0 || name.length > 20)
                    return res.status(400).json({ success: false, error: `잘못된 섹터 이름: ${name}` });
            }
        }
        // fixedSectors: 숫자 문자열 배열
        if (fixedSectors) {
            if (!Array.isArray(fixedSectors))
                return res.status(400).json({ success: false, error: '잘못된 fixedSectors 형식' });
            for (const code of fixedSectors) {
                if (!/^\d{1,5}$/.test(String(code)))
                    return res.status(400).json({ success: false, error: `잘못된 섹터 코드: ${code}` });
            }
        }
        // errorTypes: [{ value: 양의정수, label: 문자열 }]
        if (errorTypes) {
            if (!Array.isArray(errorTypes))
                return res.status(400).json({ success: false, error: '잘못된 errorTypes 형식' });
            for (const t of errorTypes) {
                if (!Number.isInteger(t.value) || t.value < 1 || t.value > 99)
                    return res.status(400).json({ success: false, error: `잘못된 오류유형 코드: ${t.value}` });
                if (typeof t.label !== 'string' || t.label.trim().length === 0 || t.label.length > 50)
                    return res.status(400).json({ success: false, error: `잘못된 오류유형 이름: ${t.label}` });
            }
        }
        // errorDetailTypes: [{ value, label, parentType }]
        if (errorDetailTypes) {
            if (!Array.isArray(errorDetailTypes))
                return res.status(400).json({ success: false, error: '잘못된 errorDetailTypes 형식' });
            for (const t of errorDetailTypes) {
                if (!Number.isInteger(t.value) || t.value < 1 || t.value > 999)
                    return res.status(400).json({ success: false, error: `잘못된 세부오류유형 코드: ${t.value}` });
                if (typeof t.label !== 'string' || t.label.trim().length === 0 || t.label.length > 50)
                    return res.status(400).json({ success: false, error: `잘못된 세부오류유형 이름: ${t.label}` });
                if (!Number.isInteger(t.parentType) || t.parentType < 0)
                    return res.status(400).json({ success: false, error: `잘못된 상위유형 코드: ${t.parentType}` });
            }
        }

        if (thresholds !== undefined) {
            if (typeof thresholds !== 'object' || Array.isArray(thresholds)) {
                return res.status(400).json({ success: false, error: '잘못된 thresholds 형식' });
            }
            const simCritical = Number(thresholds?.similarity?.critical);
            const simCaution = Number(thresholds?.similarity?.caution);
            const scoreCritical = Number(thresholds?.scorePeak?.critical);
            const scoreCaution = Number(thresholds?.scorePeak?.caution);
            if (!Number.isFinite(simCritical) || !Number.isFinite(simCaution) || simCaution < 0 || simCritical <= simCaution) {
                return res.status(400).json({ success: false, error: '유사도 기준값이 올바르지 않습니다.' });
            }
            if (!Number.isFinite(scoreCritical) || !Number.isFinite(scoreCaution) || scoreCaution < 0 || scoreCritical <= scoreCaution) {
                return res.status(400).json({ success: false, error: '오류가능성 기준값이 올바르지 않습니다.' });
            }
        }

        const settings = {
            displaySectors: displaySectors !== undefined ? displaySectors : (currentSettings.displaySectors || []),
            displaySimilarity: displaySimilarity !== undefined ? displaySimilarity : (currentSettings.displaySimilarity || []),
            refreshRate: refreshRate || 10000,
            maxRows: maxRows || 100,
            sectorMap: sectorMap !== undefined ? sectorMap : (currentSettings.sectorMap || {}),
            fixedSectors: fixedSectors !== undefined ? fixedSectors : (currentSettings.fixedSectors || []),
            errorTypes: errorTypes !== undefined ? errorTypes : (currentSettings.errorTypes || []),
            errorDetailTypes: errorDetailTypes !== undefined ? errorDetailTypes : (currentSettings.errorDetailTypes || []),
            thresholds: thresholds !== undefined ? normalizeThresholds(thresholds) : normalizeThresholds(currentSettings.thresholds),
            excelGrades: currentSettings.excelGrades || { scoreGrade: { level4: 60, level3: 45, level2: 30 }, recommendation: { immediate: 70, caution: 40 } },
            updatedAt: new Date().toISOString(),
            updatedBy: updatedBy || 'admin'
        };
        saveSettings(settings);
        res.json({ success: true, message: '설정 저장 완료', data: settings });
    } catch (err) {
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    }
});

// 유사호출부호 목록 조회 (실시간)
router.get('/callsigns', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settings = getSettings();
        const sector = req.query.sector;
        const sectors = req.query.sectors; // 다중 섹터 (쉼표 구분)

        const binds = {};

        // 유사도 필터 조건 생성 (바인드 변수 방식)
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity, settings.thresholds, binds, 'T.');

        // 활성 데이터만 조회 (CLEARED = 9999) + LEFT JOIN으로 보고 건수
        let sql = `
            SELECT T.IDX, T.DETECTED, T.CLEARED, T.CCP,
                   T.FP1_CALLSIGN, T.FP1_DEPT, T.FP1_DEST, T.FP1_EOBT, T.FP1_FID, T.FP1_ALT,
                   T.FP2_CALLSIGN, T.FP2_DEPT, T.FP2_DEST, T.FP2_EOBT, T.FP2_FID, T.FP2_ALT,
                   T.AOD_MATCH, T.FID_LEN_MATCH, T.MATCH_POS, T.MATCH_LEN,
                   T.COMP_RAT, T.SIMILARITY, T.CTRL_PEAK, T.SCORE_PEAK, T.MARK,
                   NVL(R.RCNT, 0) AS REPORT_COUNT
            FROM T_SIMILAR_CALLSIGN_PAIR T
            LEFT JOIN (
                SELECT IDX, COUNT(*) AS RCNT FROM T_SIMILAR_CALLSIGN_PAIR_REPORT GROUP BY IDX
            ) R ON R.IDX = T.IDX
            WHERE T.CLEARED = '9999-12-31 23:59:59'
            ${similarityFilter}
        `;

        if (sector && sector !== 'ALL') {
            sql += ' AND T.CCP = :sector';
            binds.sector = sector;
        } else if (sectors) {
            const sectorList = sectors.split(',').map(s => s.trim());
            const placeholders = sectorList.map((_, i) => `:s${i}`).join(',');
            sql += ` AND T.CCP IN (${placeholders})`;
            sectorList.forEach((s, i) => { binds[`s${i}`] = s; });
        }

        sql += ' ORDER BY T.DETECTED DESC';

        const maxRows = settings.maxRows || 100;
        const result = await executeWithTimeout(conn, sql, binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            maxRows: maxRows
        });

        res.json({
            success: true,
            data: convertRowsToKst(result.rows),
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('callsigns 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 섹터 목록 조회
router.get('/sectors', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settings = getSettings();

        // 유사도 필터 조건 생성 (바인드 변수)
        const sectorBinds = {};
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity, settings.thresholds, sectorBinds);

        const result = await conn.execute(`
            SELECT CCP, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR
            WHERE CLEARED = '9999-12-31 23:59:59'
            ${similarityFilter}
            GROUP BY CCP
            ORDER BY CCP
        `, sectorBinds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('sectors 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 현재 로그인 사용자 목록 조회 (보고자 선택용)
// T_ARTCNT_LOG_HISTORY에서 로그인 - 로그아웃 MINUS로 현재 접속 중인 관제사 조회
// ATFM_LOGIN에서 ARTCNT_ID → USER_NAME 매핑
router.get('/reporters', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        const result = await conn.execute(`
            SELECT
                (SELECT USER_NAME FROM ATFM_LOGIN B WHERE A.ARTCNT_ID = B.COLNAME) AS USER_NM
            FROM (
                SELECT ARTCNT_ID, HIST_CN
                FROM T_ARTCNT_LOG_HISTORY
                WHERE CREAT_DT BETWEEN TO_CHAR(SYSDATE + 8/24 - 5/24/60, 'YYYY-MM-DD HH24:MI:SS')
                                       AND TO_CHAR(SYSDATE + 9/24, 'YYYY-MM-DD HH24:MI:SS')
                AND ARTCNT_ID NOT LIKE 'UK' AND OCCURRENCE < 40
                AND HIST_CN = 'Logged in'
                MINUS
                SELECT ARTCNT_ID, HIST_CN
                FROM T_ARTCNT_LOG_HISTORY
                WHERE CREAT_DT BETWEEN TO_CHAR(SYSDATE + 8/24 - 5/24/60, 'YYYY-MM-DD HH24:MI:SS')
                                       AND TO_CHAR(SYSDATE + 9/24, 'YYYY-MM-DD HH24:MI:SS')
                AND ARTCNT_ID NOT LIKE 'UK' AND OCCURRENCE < 40
                AND HIST_CN = 'Logged out'
            ) A
            WHERE LENGTH(ARTCNT_ID) = 2
            ORDER BY USER_NM
        `, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        /* 기존 쿼리 (A_REALTIME_LOGIN 테이블 사용)
        const result = await conn.execute(`
            SELECT USER_NM FROM A_REALTIME_LOGIN
            WHERE CREAT_DT BETWEEN TO_CHAR(TRUNC(SYSDATE) + 6/24, 'YYYY-MM-DD HH24:MI:SS')
                                   AND TO_CHAR(TRUNC(SYSDATE) + 22/24, 'YYYY-MM-DD HH24:MI:SS')
            AND ISTERM IS NULL
            ORDER BY USER_NM
        `, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        */

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('reporters 조회 오류:', err);
        res.json({ success: false, data: [], error: '보고자 목록 조회 실패' });
    } finally {
        if (conn) await conn.close();
    }
});

// 오늘 시간대별 검출 건수 조회 (KST 기준)
router.get('/hourly-stats', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settings = getSettings();
        const todayKst = getKstToday();
        // KST 오늘 00:00~23:59 → UTC 변환
        const utcStart = kstToUtc(todayKst + ' 00:00:00');
        const utcEnd = kstToUtc(todayKst + ' 23:59:59');

        // 섹터 필터 조건 생성
        const binds = { utcStart, utcEnd };

        // 유사도 필터 조건 생성 (바인드 변수)
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity, settings.thresholds, binds);
        let sectorFilter = '';
        const displaySectors = settings.displaySectors || [];
        if (displaySectors.length > 0) {
            const placeholders = displaySectors.map((_, i) => `:s${i}`).join(',');
            sectorFilter = ` AND CCP IN (${placeholders})`;
            displaySectors.forEach((s, i) => { binds[`s${i}`] = s; });
        }

        // DETECTED(UTC)를 KST 시간으로 변환하여 그룹핑
        const result = await conn.execute(`
            SELECT
                TO_NUMBER(TO_CHAR(TO_DATE(DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'HH24')) AS HOUR,
                COUNT(*) AS CNT
            FROM T_SIMILAR_CALLSIGN_PAIR
            WHERE DETECTED >= :utcStart AND DETECTED <= :utcEnd
            ${similarityFilter}
            ${sectorFilter}
            GROUP BY TO_CHAR(TO_DATE(DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'HH24')
            ORDER BY HOUR
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // 0~23시 전체 시간대 데이터 생성 (없는 시간대는 0)
        const hourlyData = Array(24).fill(0);
        result.rows.forEach(row => {
            if (row.HOUR >= 0 && row.HOUR < 24) {
                hourlyData[row.HOUR] = row.CNT;
            }
        });

        res.json({
            success: true,
            data: {
                date: todayKst,
                hourly: hourlyData,
                total: hourlyData.reduce((a, b) => a + b, 0)
            }
        });
    } catch (err) {
        console.error('시간대별 통계 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 섹터별 현재 관제 건수 조회 (ATFM_FLIGHTPLAN)
router.get('/control-counts', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const result = await conn.execute(`
            SELECT CURRENT_CONTROL_POSITION AS CCP, COUNT(1) AS CNT
            FROM ATFM_FLIGHTPLAN
            WHERE ISOLD = 'F' AND CURRENT_CONTROL_POSITION IS NOT NULL
            GROUP BY CURRENT_CONTROL_POSITION
        `, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('관제 건수 조회 오류:', err);
        res.json({ success: false, data: [], error: '관제 건수 조회 실패' });
    } finally {
        if (conn) await conn.close();
    }
});

// 특정 IDX의 최신 보고서 조회 (수정 모드용)
router.get('/reports/:idx', async (req, res) => {
    let conn;
    try {
        const idx = Number(req.params.idx);
        if (!Number.isInteger(idx) || idx <= 0) {
            return res.status(400).json({ success: false, error: '유효하지 않은 IDX입니다.' });
        }

        conn = await db.getConnection();
        const result = await conn.execute(`
            SELECT IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
            WHERE IDX = :idx
            ORDER BY REPORTED DESC
        `, { idx }, { outFormat: oracledb.OUT_FORMAT_OBJECT, maxRows: 1 });

        if (result.rows.length === 0) {
            return res.json({ success: true, data: null });
        }

        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        console.error('보고서 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 보고서 수정 (기존 보고서 업데이트)
router.put('/reports', async (req, res) => {
    let conn;
    try {
        const { idx, originalReported, reporter, ao, type, typeDetail, remark } = req.body;

        // 입력값 검증
        if (!idx || !Number.isInteger(Number(idx)) || Number(idx) <= 0) {
            return res.status(400).json({ success: false, error: '유효하지 않은 IDX 값입니다.' });
        }
        if (!originalReported) {
            return res.status(400).json({ success: false, error: '원본 보고 일시가 필요합니다.' });
        }
        if (!reporter || typeof reporter !== 'string' || reporter.length > 50) {
            return res.status(400).json({ success: false, error: '보고자 정보가 유효하지 않습니다.' });
        }
        if (!ao || ![1, 2, 3].includes(Number(ao))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 오류항공기 값입니다.' });
        }
        const settings = getSettings();
        const validTypeValues = (settings.errorTypes || []).map(t => t.value);
        if (!type || !validTypeValues.includes(Number(type))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 오류유형 값입니다.' });
        }
        const validDetailValues = (settings.errorDetailTypes || []).map(t => t.value);
        if (!typeDetail || !validDetailValues.includes(Number(typeDetail))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 세부오류유형 값입니다.' });
        }

        const safeRemark = (remark || '-').substring(0, 500);

        conn = await db.getConnection();
        const result = await conn.execute(`
            UPDATE T_SIMILAR_CALLSIGN_PAIR_REPORT
            SET REPORTER = :reporter,
                AO = :ao,
                TYPE = :type,
                TYPE_DETAIL = :typeDetail,
                REMARK = :remark
            WHERE IDX = :idx AND REPORTED = :originalReported
        `, {
            idx: Number(idx),
            originalReported: originalReported,
            reporter: reporter.substring(0, 50),
            ao: Number(ao),
            type: Number(type),
            typeDetail: Number(typeDetail),
            remark: safeRemark
        }, { autoCommit: true });

        if (result.rowsAffected === 0) {
            return res.status(404).json({ success: false, error: '수정할 보고서를 찾을 수 없습니다.' });
        }

        res.json({ success: true, message: '보고서 수정 완료' });
    } catch (err) {
        console.error('보고서 수정 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 오류 보고서 저장
router.post('/reports', async (req, res) => {
    let conn;
    try {
        const { idx, reported, reporter, ao, type, typeDetail, remark } = req.body;

        // 입력값 검증
        if (!idx || !Number.isInteger(Number(idx)) || Number(idx) <= 0) {
            return res.status(400).json({ success: false, error: '유효하지 않은 IDX 값입니다.' });
        }
        if (!reported || !/^\d{4}-\d{2}-\d{2}/.test(reported)) {
            return res.status(400).json({ success: false, error: '유효하지 않은 날짜 형식입니다.' });
        }
        if (!reporter || typeof reporter !== 'string' || reporter.length > 50) {
            return res.status(400).json({ success: false, error: '보고자 정보가 유효하지 않습니다.' });
        }
        if (!ao || ![1, 2, 3].includes(Number(ao))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 오류항공기 값입니다.' });
        }
        const settings = getSettings();
        const validTypeValues = (settings.errorTypes || []).map(t => t.value);
        if (!type || !validTypeValues.includes(Number(type))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 오류유형 값입니다.' });
        }
        const validDetailValues = (settings.errorDetailTypes || []).map(t => t.value);
        if (!typeDetail || !validDetailValues.includes(Number(typeDetail))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 세부오류유형 값입니다.' });
        }

        // 비고는 500자 제한
        const safeRemark = (remark || '-').substring(0, 500);

        conn = await db.getConnection();
        await conn.execute(`
            INSERT INTO T_SIMILAR_CALLSIGN_PAIR_REPORT
            (IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK)
            VALUES (:idx, :reported, :reporter, :ao, :type, :typeDetail, :remark)
        `, {
            idx: Number(idx),
            reported: reported,
            reporter: reporter.substring(0, 50),
            ao: Number(ao),
            type: Number(type),
            typeDetail: Number(typeDetail),
            remark: safeRemark
        }, { autoCommit: true });

        res.json({ success: true, message: '보고서 저장 완료' });
    } catch (err) {
        console.error('보고서 저장 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 예측 데이터 조회 (과거 동일요일 + 다음시간대 이력 기반)
router.get('/callsigns/predictions', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settings = getSettings();
        const thresholds = normalizeThresholds(settings.thresholds);

        // 현재 KST 시각 계산
        const kstNow = getKstNow();
        const kstHour = kstNow.getUTCHours();
        const kstMonth = kstNow.getUTCMonth() + 1;
        const kstYear = kstNow.getUTCFullYear();
        const nextHour = (kstHour + 1) % 24;

        // 자정 경계: nextHour가 0이면 "내일"의 요일을 사용
        const dayDate = nextHour === 0
            ? new Date(kstNow.getTime() + 86400000)
            : kstNow;

        // 요일: Julian day MOD 7 (NLS 무관, 0=월 1=화 ... 6=일)
        const kstJulianBase = Math.floor(dayDate.getTime() / 86400000) + 2440588;
        const dayOfWeekMod = kstJulianBase % 7; // 0=월 ... 6=일

        // 시즌별 조회 범위 계산
        const lookback = getSeasonalLookback(kstMonth, kstYear);
        if (lookback.length === 0) {
            return res.json({ success: true, data: [], meta: { nextHour, dayOfWeek: dayOfWeekMod, lookback: [] } });
        }

        // 조회 범위를 날짜 범위로 변환 (UTC 기준)
        // 각 (year, month)의 1일 00:00 KST ~ 말일 23:59 KST → UTC
        const dateRanges = lookback.map(lb => {
            const startKst = `${lb.year}-${String(lb.month).padStart(2, '0')}-01 00:00:00`;
            const lastDay = new Date(lb.year, lb.month, 0).getDate();
            const endKst = `${lb.year}-${String(lb.month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')} 23:59:59`;
            return { start: kstToUtc(startKst), end: kstToUtc(endKst) };
        });

        // 날짜 범위 OR 조건 생성
        const dateConditions = dateRanges.map((_, i) =>
            `(T.DETECTED >= :rangeStart${i} AND T.DETECTED <= :rangeEnd${i})`
        ).join(' OR ');

        const binds = {};
        dateRanges.forEach((dr, i) => {
            binds[`rangeStart${i}`] = dr.start;
            binds[`rangeEnd${i}`] = dr.end;
        });
        binds.nextHour = nextHour;
        binds.dayMod = dayOfWeekMod;
        binds.cautionThreshold = thresholds.similarity.caution;

        // 섹터 필터 (숫자만 허용)
        let sectorFilter = '';
        const sectors = req.query.sectors;
        if (sectors) {
            const sectorList = sectors.split(',').filter(s => /^\d+$/.test(s.trim()));
            if (sectorList.length > 0) {
                const placeholders = sectorList.map((_, i) => `:sec${i}`).join(',');
                sectorFilter = ` AND T.CCP IN (${placeholders})`;
                sectorList.forEach((s, i) => { binds[`sec${i}`] = s.trim(); });
            }
        }

        // Oracle 11g: KEEP DENSE_RANK LAST로 가장 최근 레코드의 값 추출
        // 요일 판정: Julian day MOD 7 (NLS 무관)
        const sql = `
            SELECT * FROM (
                SELECT
                    T.FP1_CALLSIGN,
                    T.FP2_CALLSIGN,
                    MAX(T.CCP) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS CCP,
                    MAX(T.SIMILARITY) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS SIMILARITY,
                    MAX(T.SCORE_PEAK) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS SCORE_PEAK,
                    MAX(T.FP1_DEPT) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS FP1_DEPT,
                    MAX(T.FP1_DEST) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS FP1_DEST,
                    MAX(T.FP2_DEPT) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS FP2_DEPT,
                    MAX(T.FP2_DEST) KEEP (DENSE_RANK LAST ORDER BY T.DETECTED) AS FP2_DEST,
                    MAX(T.DETECTED) AS LATEST_DETECTED,
                    COUNT(*) AS HIST_COUNT
                FROM T_SIMILAR_CALLSIGN_PAIR T
                WHERE T.CLEARED <> '9999-12-31 23:59:59'
                  AND T.SIMILARITY > :cautionThreshold
                  AND (${dateConditions})
                  AND TO_NUMBER(TO_CHAR(
                      TO_DATE(T.DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'HH24'
                  )) = :nextHour
                  AND MOD(
                      TO_NUMBER(TO_CHAR(TO_DATE(T.DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'J')),
                      7
                  ) = :dayMod
                  AND NOT EXISTS (
                      SELECT 1 FROM T_SIMILAR_CALLSIGN_PAIR A
                      WHERE A.CLEARED = '9999-12-31 23:59:59'
                        AND A.FP1_CALLSIGN = T.FP1_CALLSIGN
                        AND A.FP2_CALLSIGN = T.FP2_CALLSIGN
                  )
                  ${sectorFilter}
                GROUP BY T.FP1_CALLSIGN, T.FP2_CALLSIGN
                ORDER BY COUNT(*) DESC
            )
            WHERE ROWNUM <= 50
        `;

        const result = await executeWithTimeout(conn, sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // LATEST_DETECTED UTC→KST 변환 (기존 유틸리티 함수 재사용)
        const data = result.rows.map(row => {
            if (row.LATEST_DETECTED) {
                row.LATEST_DETECTED = utcToKst(row.LATEST_DETECTED);
            }
            return row;
        });

        // 요일명 매핑 (0=월 ... 6=일)
        const dayNames = ['월', '화', '수', '목', '금', '토', '일'];

        res.json({
            success: true,
            data: data,
            meta: {
                nextHour: nextHour,
                endHour: (nextHour + 1) % 24,
                dayOfWeek: dayOfWeekMod,
                dayName: dayNames[dayOfWeekMod],
                lookbackMonths: lookback
            },
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error('예측 데이터 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

module.exports = router;
