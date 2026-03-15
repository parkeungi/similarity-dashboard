const express = require('express');
const router = express.Router();
const oracledb = require('oracledb');
const db = require('../config/database');
const { kstToUtc, convertRowsToKst } = require('../config/timeUtil');

// 에러 메시지 안전하게 처리 (내부 정보 노출 방지)
function safeErrorMessage(err) {
    console.error('Error:', err); // 서버 로그에만 상세 기록
    return '요청 처리 중 오류가 발생했습니다.';
}

// 보고서 전체 조회 (JOIN)
router.get('/reports', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const { from, to, sector, type, typeDetail } = req.query;

        let sql = `
            SELECT r.IDX, r.REPORTED, r.REPORTER, r.AO, r.TYPE, r.TYPE_DETAIL, r.REMARK,
                   c.CCP, c.DETECTED, c.CLEARED,
                   c.FP1_CALLSIGN, c.FP1_DEPT, c.FP1_DEST, c.FP1_EOBT, c.FP1_FID, c.FP1_ALT,
                   c.FP2_CALLSIGN, c.FP2_DEPT, c.FP2_DEST, c.FP2_EOBT, c.FP2_FID, c.FP2_ALT,
                   c.SIMILARITY, c.SCORE_PEAK, c.CTRL_PEAK, c.COMP_RAT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            LEFT JOIN T_SIMILAR_CALLSIGN_PAIR c ON r.IDX = c.IDX
            WHERE 1=1
        `;

        const binds = {};

        if (from) {
            sql += ' AND r.REPORTED >= :startDt';
            binds.startDt = from;
        }
        if (to) {
            sql += ' AND r.REPORTED <= :endDt';
            binds.endDt = to.length === 10 ? to + ' 23:59:59' : to;
        }
        if (sector && sector !== 'ALL') {
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

        sql += ' ORDER BY r.REPORTED DESC';

        const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: convertRowsToKst(result.rows) });
    } catch (err) {
        console.error('보고서 조회 오류:', err);
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
            binds.startDt = from;
        }
        if (to) {
            whereClause += ' AND r.REPORTED <= :endDt';
            binds.endDt = to;
        }

        // 순차 실행 (단일 connection에서 병렬 실행 시 Thick mode 안정성 문제)
        const typeResult = await conn.execute(`
            SELECT r.TYPE, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY r.TYPE
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const detailResult = await conn.execute(`
            SELECT r.TYPE_DETAIL, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY r.TYPE_DETAIL
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const sectorResult = await conn.execute(`
            SELECT c.CCP, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            LEFT JOIN T_SIMILAR_CALLSIGN_PAIR c ON r.IDX = c.IDX
            WHERE ${whereClause}
            GROUP BY c.CCP
            ORDER BY c.CCP
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const dailyResult = await conn.execute(`
            SELECT SUBSTR(r.REPORTED, 1, 10) as REPORT_DATE, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY SUBSTR(r.REPORTED, 1, 10)
            ORDER BY REPORT_DATE DESC
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const monthlyResult = await conn.execute(`
            SELECT SUBSTR(r.REPORTED, 1, 7) as REPORT_MONTH, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
            GROUP BY SUBSTR(r.REPORTED, 1, 7)
            ORDER BY REPORT_MONTH
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const totalResult = await conn.execute(`
            SELECT COUNT(*) as TOTAL
            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT r
            WHERE ${whereClause}
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({
            success: true,
            data: {
                total: totalResult.rows[0]?.TOTAL || 0,
                byType: typeResult.rows,
                byDetail: detailResult.rows,
                bySector: sectorResult.rows,
                byDate: dailyResult.rows,
                byMonth: monthlyResult.rows
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
        const { from, to, sector } = req.query;

        let sql = `
            SELECT c.IDX, c.DETECTED, c.CLEARED, c.CCP,
                   c.FP1_CALLSIGN, c.FP1_DEPT, c.FP1_DEST,
                   c.FP2_CALLSIGN, c.FP2_DEPT, c.FP2_DEST,
                   c.AOD_MATCH, c.FID_LEN_MATCH, c.MATCH_POS, c.MATCH_LEN,
                   c.COMP_RAT, c.SIMILARITY, c.CTRL_PEAK, c.SCORE_PEAK,
                   r.REPORTED, r.REPORTER, r.AO, r.TYPE, r.TYPE_DETAIL, r.REMARK
            FROM T_SIMILAR_CALLSIGN_PAIR c
            LEFT JOIN T_SIMILAR_CALLSIGN_PAIR_REPORT r ON r.IDX = c.IDX
            WHERE c.CLEARED <> '9999-12-31 23:59:59'
        `;

        const binds = {};

        if (from) {
            sql += ' AND c.DETECTED >= :startDt';
            binds.startDt = from;
        }
        if (to) {
            sql += ' AND c.DETECTED <= :endDt';
            binds.endDt = to.length === 10 ? to + ' 23:59:59' : to;
        }
        if (sector && sector !== 'ALL') {
            sql += ' AND c.CCP = :sector';
            binds.sector = sector;
        }

        sql += ' ORDER BY c.DETECTED DESC';

        const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: convertRowsToKst(result.rows) });
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
