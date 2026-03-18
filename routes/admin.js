const express = require('express');
const router = express.Router();
const oracledb = require('oracledb');
const db = require('../config/database');
const { kstToUtc, convertRowsToKst } = require('../config/timeUtil');

const { getCachedSettings, normalizeThresholds, safeErrorMessage } = require('../config/settingsCache');

// 항공사 호출부호 접두어 → 항공사명 캐시
let airlineCache = null;
let airlineCacheTime = 0;
const AIRLINE_CACHE_TTL = 60 * 60 * 1000; // 1시간

async function getAirlineMap() {
    const now = Date.now();
    if (airlineCache && (now - airlineCacheTime) < AIRLINE_CACHE_TTL) {
        return airlineCache;
    }
    let conn;
    try {
        conn = await db.getConnection();
        const result = await conn.execute(
            'SELECT CALLSIGN, AIRLINE_NAME FROM T_AIRLINE WHERE AIRLINE_NAME IS NOT NULL',
            [], { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        airlineCache = {};
        result.rows.forEach(r => { airlineCache[r.CALLSIGN] = r.AIRLINE_NAME; });
        airlineCacheTime = now;
        return airlineCache;
    } catch (err) {
        console.error('항공사 캐시 로드 실패:', err);
        return airlineCache || {};
    } finally {
        if (conn) await conn.close();
    }
}

function extractCallsignPrefix(callsign) {
    if (!callsign) return '';
    return callsign.replace(/[0-9].*/, '');
}

// 유사도 필터 SQL 조건 생성 (바인드 변수 사용)
function buildSimilarityFilter(binds = {}) {
    try {
        const settings = getCachedSettings();
        if (!settings) return '';
        const displaySimilarity = settings.displaySimilarity || [];
        if (!displaySimilarity.length) return '';

        const sim = normalizeThresholds(settings.thresholds).similarity;
        let needCritical = false, needCaution = false;

        const conditions = [];
        if (displaySimilarity.includes('critical')) {
            conditions.push('c.SIMILARITY > :simCritical');
            needCritical = true;
        }
        if (displaySimilarity.includes('caution')) {
            conditions.push('(c.SIMILARITY > :simCaution AND c.SIMILARITY <= :simCritical)');
            needCritical = true;
            needCaution = true;
        }
        if (displaySimilarity.includes('monitor')) {
            conditions.push('c.SIMILARITY <= :simCaution');
            needCaution = true;
        }
        if (needCritical) binds.simCritical = sim.critical;
        if (needCaution) binds.simCaution = sim.caution;
        return conditions.length ? ' AND (' + conditions.join(' OR ') + ')' : '';
    } catch (e) {
        return '';
    }
}

// 전체 호출부호 데이터 조회 (LEFT JOIN 보고서, 종료 건만, 유사도 설정 적용)
router.get('/reports', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { from, to, sector, sectors, type, typeDetail, reported } = req.query;

        let sql = `
            SELECT c.IDX, c.DETECTED, c.CLEARED, c.CCP,
                   c.FP1_CALLSIGN, c.FP1_DEPT, c.FP1_DEST, c.FP1_EOBT, c.FP1_FID, c.FP1_ALT,
                   c.FP2_CALLSIGN, c.FP2_DEPT, c.FP2_DEST, c.FP2_EOBT, c.FP2_FID, c.FP2_ALT,
                   c.SIMILARITY, c.SCORE_PEAK, c.CTRL_PEAK, c.COMP_RAT,
                   r.REPORTED, r.REPORTER, r.AO, r.TYPE, r.TYPE_DETAIL, r.REMARK
            FROM T_SIMILAR_CALLSIGN_PAIR c
            LEFT JOIN (
                SELECT IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK
                FROM (
                    SELECT IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK,
                           ROW_NUMBER() OVER (PARTITION BY IDX ORDER BY REPORTED DESC) AS RN
                    FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
                )
                WHERE RN = 1
            ) r ON r.IDX = c.IDX
            WHERE c.CLEARED <> '9999-12-31 23:59:59'
        `;

        // 설정된 유사도 등급 필터 적용 (바인드 변수)
        const binds = {};
        sql += buildSimilarityFilter(binds);

        if (from) {
            sql += ' AND c.DETECTED >= :startDt';
            binds.startDt = kstToUtc(from);
        }
        if (to) {
            sql += ' AND c.DETECTED <= :endDt';
            const toFull = to.length === 10 ? to + ' 23:59:59' : to;
            binds.endDt = kstToUtc(toFull);
        }
        // 다중 섹터 지원 (쉼표 구분)
        if (sectors) {
            const sectorList = sectors.split(',').filter(s => /^\d+$/.test(s.trim()));
            if (sectorList.length > 0) {
                const placeholders = sectorList.map((s, i) => `:sec${i}`);
                sql += ` AND c.CCP IN (${placeholders.join(',')})`;
                sectorList.forEach((s, i) => { binds[`sec${i}`] = s.trim(); });
            }
        } else if (sector && sector !== 'ALL') {
            sql += ' AND c.CCP = :sector';
            binds.sector = sector;
        }
        if (type) {
            sql += ' AND r.TYPE = :type';
            binds.type = parseInt(type);
        }
        if (typeDetail) {
            sql += ' AND r.TYPE_DETAIL = :typeDetail';
            binds.typeDetail = parseInt(typeDetail);
        }
        // 보고여부 필터
        if (reported === 'Y') {
            sql += ' AND r.REPORTED IS NOT NULL';
        } else if (reported === 'N') {
            sql += ' AND r.REPORTED IS NULL';
        }

        sql += ' ORDER BY c.DETECTED DESC';

        const MAX_ROWS = 10000;
        const result = await conn.execute(sql, binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            maxRows: MAX_ROWS + 1
        });

        const truncated = result.rows.length > MAX_ROWS;
        const rows = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

        res.json({ success: true, data: convertRowsToKst(rows), truncated });
    } catch (err) {
        console.error('데이터 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 통계 데이터 (Promise.all 병렬 처리)
router.get('/stats', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { from, to } = req.query;

        let whereClause = '1=1';
        const binds = {};

        if (from) {
            whereClause += ' AND r.REPORTED >= :startDt';
            binds.startDt = from.length === 10 ? from + ' 00:00:00' : from;
        }
        if (to) {
            whereClause += ' AND r.REPORTED <= :endDt';
            const toFull = to.length === 10 ? to + ' 23:59:59' : to;
            binds.endDt = toFull;
        }

        // byType + byDetail + total을 단일 쿼리로 합산 (테이블 1회 스캔)
        const combinedResult = await conn.execute(`
            SELECT r.TYPE, r.TYPE_DETAIL, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY r.TYPE, r.TYPE_DETAIL
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // 결과에서 byType, byDetail, total 분리
        const typeMap = {};
        const detailMap = {};
        let total = 0;
        for (const row of combinedResult.rows) {
            const cnt = row.CNT;
            total += cnt;
            typeMap[row.TYPE] = (typeMap[row.TYPE] || 0) + cnt;
            detailMap[row.TYPE_DETAIL] = (detailMap[row.TYPE_DETAIL] || 0) + cnt;
        }
        const byType = Object.entries(typeMap).map(([TYPE, CNT]) => ({ TYPE, CNT }));
        const byDetail = Object.entries(detailMap).map(([TYPE_DETAIL, CNT]) => ({ TYPE_DETAIL, CNT }));

        // 섹터별 (JOIN 필요하므로 별도 쿼리)
        const sectorResult = await conn.execute(`
            SELECT c.CCP, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            LEFT JOIN T_SIMILAR_CALLSIGN_PAIR c ON r.IDX = c.IDX
            WHERE ${whereClause}
            GROUP BY c.CCP
            ORDER BY c.CCP
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // 일별 + 월별을 단일 쿼리로 합산 (일별에서 월별 집계)
        const dailyResult = await conn.execute(`
            SELECT SUBSTR(r.REPORTED, 1, 10) as REPORT_DATE, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY SUBSTR(r.REPORTED, 1, 10)
            ORDER BY REPORT_DATE DESC
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // 일별 결과에서 월별 집계
        const monthMap = {};
        for (const row of dailyResult.rows) {
            const month = row.REPORT_DATE.substring(0, 7);
            monthMap[month] = (monthMap[month] || 0) + row.CNT;
        }
        const byMonth = Object.entries(monthMap)
            .map(([REPORT_MONTH, CNT]) => ({ REPORT_MONTH, CNT }))
            .sort((a, b) => a.REPORT_MONTH.localeCompare(b.REPORT_MONTH));

        res.json({
            success: true,
            data: {
                total,
                byType,
                byDetail,
                bySector: sectorResult.rows,
                byDate: dailyResult.rows,
                byMonth
            }
        });
    } catch (err) {
        console.error('통계 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 보고서 삭제
router.delete('/reports/:idx/:reported', async (req, res) => {
    let conn;
    try {
        const { idx, reported } = req.params;

        // idx 유효성 검증 (양의 정수)
        const idxNum = parseInt(idx);
        if (isNaN(idxNum) || idxNum <= 0) {
            return res.status(400).json({ success: false, error: '유효하지 않은 IDX 값입니다.' });
        }

        // reported 유효성 검증 (YYYY-MM-DD HH:MM 또는 YYYY-MM-DD HH:MM:SS 형식)
        const dateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
        if (!reported || !dateTimeRegex.test(reported)) {
            return res.status(400).json({ success: false, error: '유효하지 않은 보고일시 형식입니다.' });
        }

        // 초가 없는 경우 :00 붙여서 정규화
        const normalizedReported = reported.length === 16 ? reported + ':00' : reported;

        conn = await db.getConnection();

        // 정규화된 값과 원본 값 모두 매칭 시도 (레거시 데이터 호환)
        const result = await conn.execute(`
            DELETE FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
            WHERE IDX = :idx AND (REPORTED = :reported OR REPORTED = :reportedAlt)
        `, { idx: idxNum, reported: normalizedReported, reportedAlt: reported }, { autoCommit: true });

        if (result.rowsAffected === 0) {
            return res.status(404).json({ success: false, error: '삭제할 보고서를 찾을 수 없습니다.' });
        }

        res.json({ success: true, message: '삭제 완료' });
    } catch (err) {
        console.error('삭제 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 보고서 일괄 삭제
router.post('/reports/batch-delete', async (req, res) => {
    let conn;
    try {
        const { items } = req.body;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: '삭제할 항목이 없습니다.' });
        }
        if (items.length > 200) {
            return res.status(400).json({ success: false, error: '한 번에 최대 200건까지 삭제할 수 있습니다.' });
        }

        const dateTimeRegex = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/;
        conn = await db.getConnection();
        let deleted = 0;
        let failed = 0;

        for (const item of items) {
            const idxNum = parseInt(item.idx);
            if (isNaN(idxNum) || idxNum <= 0 || !item.reported || !dateTimeRegex.test(item.reported)) {
                failed++;
                continue;
            }
            const normalizedReported = item.reported.length === 16 ? item.reported + ':00' : item.reported;
            const result = await conn.execute(`
                DELETE FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
                WHERE IDX = :idx AND (REPORTED = :reported OR REPORTED = :reportedAlt)
            `, { idx: idxNum, reported: normalizedReported, reportedAlt: item.reported });
            if (result.rowsAffected > 0) deleted++;
            else failed++;
        }

        await conn.execute('COMMIT');
        res.json({ success: true, message: `${deleted}건 삭제 완료` + (failed > 0 ? `, ${failed}건 실패` : ''), deleted, failed });
    } catch (err) {
        console.error('일괄 삭제 오류:', err);
        if (conn) try { await conn.execute('ROLLBACK'); } catch(e) {}
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 유사호출부호 데이터 현황 조회 (날짜 필터 지원, KST→UTC 변환)
router.get('/callsign-stats', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { from, to } = req.query;

        let whereClause = '1=1';
        const binds = {};

        if (from) {
            whereClause += ' AND DETECTED >= :startDt';
            binds.startDt = kstToUtc(from);
        }
        if (to) {
            whereClause += ' AND DETECTED <= :endDt';
            binds.endDt = kstToUtc(to);
        }

        const countResult = await conn.execute(
            `SELECT COUNT(*) as CNT FROM T_SIMILAR_CALLSIGN_PAIR WHERE ${whereClause}`,
            binds, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        res.json({
            success: true,
            data: {
                totalCount: countResult.rows[0]?.CNT || 0
            }
        });
    } catch (err) {
        console.error('통계 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// Excel 내보내기용 전체 호출부호 데이터 조회 (종료된 건만, LEFT JOIN 보고서)
router.get('/export-data', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { from, to, sector, sectors } = req.query;

        const airlineMap = await getAirlineMap();

        let sql = `
            SELECT c.IDX, c.DETECTED, c.CLEARED, c.CCP,
                   c.FP1_CALLSIGN, c.FP1_DEPT, c.FP1_DEST,
                   c.FP2_CALLSIGN, c.FP2_DEPT, c.FP2_DEST,
                   c.AOD_MATCH, c.FID_LEN_MATCH, c.MATCH_POS, c.MATCH_LEN,
                   c.COMP_RAT, c.SIMILARITY, c.CTRL_PEAK, c.SCORE_PEAK, c.MARK,
                   r.REPORTED, r.REPORTER, r.AO, r.TYPE, r.TYPE_DETAIL, r.REMARK
            FROM T_SIMILAR_CALLSIGN_PAIR c
            LEFT JOIN (
                SELECT IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK
                FROM (
                    SELECT IDX, REPORTED, REPORTER, AO, TYPE, TYPE_DETAIL, REMARK,
                           ROW_NUMBER() OVER (PARTITION BY IDX ORDER BY REPORTED DESC) AS RN
                    FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
                )
                WHERE RN = 1
            ) r ON r.IDX = c.IDX
            WHERE c.CLEARED <> '9999-12-31 23:59:59'
        `;

        const binds = {};

        if (from) {
            sql += ' AND c.DETECTED >= :startDt';
            binds.startDt = kstToUtc(from);
        }
        if (to) {
            sql += ' AND c.DETECTED <= :endDt';
            const toFull = to.length === 10 ? to + ' 23:59:59' : to;
            binds.endDt = kstToUtc(toFull);
        }
        // 다중 섹터 지원
        if (sectors) {
            const sectorList = sectors.split(',').filter(s => /^\d+$/.test(s.trim()));
            if (sectorList.length > 0) {
                const placeholders = sectorList.map((s, i) => `:sec${i}`);
                sql += ` AND c.CCP IN (${placeholders.join(',')})`;
                sectorList.forEach((s, i) => { binds[`sec${i}`] = s.trim(); });
            }
        } else if (sector && sector !== 'ALL') {
            sql += ' AND c.CCP = :sector';
            binds.sector = sector;
        }

        sql += ' ORDER BY c.DETECTED DESC';

        const MAX_ROWS = 10000;
        const result = await conn.execute(sql, binds, {
            outFormat: oracledb.OUT_FORMAT_OBJECT,
            maxRows: MAX_ROWS + 1
        });

        const truncated = result.rows.length > MAX_ROWS;
        const sliced = truncated ? result.rows.slice(0, MAX_ROWS) : result.rows;

        const rows = convertRowsToKst(sliced).map(row => ({
            ...row,
            FP1_AIRLINE: airlineMap[extractCallsignPrefix(row.FP1_CALLSIGN)] || '',
            FP2_AIRLINE: airlineMap[extractCallsignPrefix(row.FP2_CALLSIGN)] || ''
        }));

        res.json({ success: true, data: rows, truncated });
    } catch (err) {
        console.error('Excel 데이터 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 클라이언트 우클릭 창전환 프로세스 강제 종료
router.post('/kill-switch', (req, res) => {
    const { exec } = require('child_process');
    exec('taskkill /F /IM powershell.exe', (err, stdout, stderr) => {
        if (err) {
            // 프로세스가 없는 경우도 에러로 옴
            if (stderr && stderr.includes('not found')) {
                return res.json({ success: true, message: '실행 중인 프로세스가 없습니다.' });
            }
            return res.json({ success: true, message: '프로세스가 없거나 이미 종료되었습니다.' });
        }
        res.json({ success: true, message: '우클릭 창전환 프로세스가 종료되었습니다.' });
    });
});

module.exports = router;
