const express = require('express');
const router = express.Router();
const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');
const db = require('../config/database');

// 에러 메시지 안전하게 처리 (내부 정보 노출 방지)
function safeErrorMessage(err) {
    console.error('Error:', err); // 서버 로그에만 상세 기록
    return '요청 처리 중 오류가 발생했습니다.';
}

// 설정 파일 경로
const SETTINGS_PATH = path.join(__dirname, '..', 'config', 'settings.json');

// 설정 읽기
function getSettings() {
    try {
        const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
        return JSON.parse(data);
    } catch (err) {
        return { displaySectors: [], displaySimilarity: [], refreshRate: 10000, maxRows: 100 };
    }
}

/**
 * 유사도 필터 SQL 조건 생성
 * @param {string[]} displaySimilarity - ['critical', 'caution', 'monitor']
 * @returns {string} SQL WHERE 조건 (빈 배열이면 빈 문자열)
 */
function buildSimilarityFilter(displaySimilarity) {
    if (!displaySimilarity || displaySimilarity.length === 0) {
        return ''; // 필터 없음 = 전체 표시
    }

    const conditions = [];

    // critical (매우높음): SIMILARITY > 2
    if (displaySimilarity.includes('critical')) {
        conditions.push('SIMILARITY > 2');
    }

    // caution (높음): SIMILARITY > 1 AND SIMILARITY <= 2
    if (displaySimilarity.includes('caution')) {
        conditions.push('(SIMILARITY > 1 AND SIMILARITY <= 2)');
    }

    // monitor (보통): SIMILARITY <= 1
    if (displaySimilarity.includes('monitor')) {
        conditions.push('SIMILARITY <= 1');
    }

    if (conditions.length === 0) {
        return '';
    }

    return ' AND (' + conditions.join(' OR ') + ')';
}

// 설정 저장
function saveSettings(settings) {
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2), 'utf8');
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
        const { displaySectors, displaySimilarity, refreshRate, maxRows, updatedBy } = req.body;
        const settings = {
            displaySectors: displaySectors || [],
            displaySimilarity: displaySimilarity || [],
            refreshRate: refreshRate || 10000,
            maxRows: maxRows || 100,
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

        // 유사도 필터 조건 생성
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity);

        let sql = `
            SELECT IDX, DETECTED, CLEARED, CCP,
                   FP1_CALLSIGN, FP1_DEPT, FP1_DEST, FP1_EOBT, FP1_FID, FP1_ALT,
                   FP2_CALLSIGN, FP2_DEPT, FP2_DEST, FP2_EOBT, FP2_FID, FP2_ALT,
                   AOD_MATCH, FID_LEN_MATCH, MATCH_POS, MATCH_LEN,
                   COMP_RAT, SIMILARITY, CTRL_PEAK, SCORE_PEAK, MARK
            FROM T_SIMILAR_CALLSIGN_PAIR
            WHERE CLEARED = '9999-12-31 23:59:59'
            ${similarityFilter}
        `;

        const binds = {};
        if (sector && sector !== 'ALL') {
            sql += ' AND CCP = :sector';
            binds.sector = sector;
        } else if (sectors) {
            // 다중 섹터 필터링
            const sectorList = sectors.split(',').map(s => s.trim());
            const placeholders = sectorList.map((_, i) => `:s${i}`).join(',');
            sql += ` AND CCP IN (${placeholders})`;
            sectorList.forEach((s, i) => { binds[`s${i}`] = s; });
        }

        sql += ' ORDER BY DETECTED DESC';

        const result = await conn.execute(sql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT }); // OBJECT format

        res.json({
            success: true,
            data: result.rows,
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

        // 유사도 필터 조건 생성
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity);

        const result = await conn.execute(`
            SELECT CCP, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR
            WHERE CLEARED = '9999-12-31 23:59:59'
            ${similarityFilter}
            GROUP BY CCP
            ORDER BY CCP
        `, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('sectors 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

// 현재 로그인 사용자 목록 조회 (보고자 선택용)
router.get('/reporters', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        const result = await conn.execute(`
            SELECT USER_NM FROM A_REALTIME_LOGIN
            WHERE CREAT_DT BETWEEN TO_CHAR(SYSDATE+7/24,'YYYY-MM-DD HH24:MI:SS') AND TO_CHAR(SYSDATE+11/24,'YYYY-MM-DD HH24:MI:SS')
            AND ISTERM IS NULL
            ORDER BY USER_NM
        `, {}, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('reporters 조회 오류:', err);
        res.json({ success: true, data: [] });
    } finally {
        if (conn) await conn.close();
    }
});

// 오늘 시간대별 검출 건수 조회 (관제사 화면용)
router.get('/hourly-stats', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();
        const settings = getSettings();
        const today = new Date().toISOString().split('T')[0];

        // 유사도 필터 조건 생성
        const similarityFilter = buildSimilarityFilter(settings.displaySimilarity);

        // 섹터 필터 조건 생성
        const binds = { today: today };
        let sectorFilter = '';
        const displaySectors = settings.displaySectors || [];
        if (displaySectors.length > 0) {
            const placeholders = displaySectors.map((_, i) => `:s${i}`).join(',');
            sectorFilter = ` AND CCP IN (${placeholders})`;
            displaySectors.forEach((s, i) => { binds[`s${i}`] = s; });
        }

        const result = await conn.execute(`
            SELECT TO_NUMBER(SUBSTR(DETECTED, 12, 2)) as HOUR, COUNT(*) as CNT
            FROM T_SIMILAR_CALLSIGN_PAIR
            WHERE DETECTED >= :today
            ${similarityFilter}
            ${sectorFilter}
            GROUP BY SUBSTR(DETECTED, 12, 2)
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
                date: today,
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
        if (!type || ![1, 2, 3, 4, 5].includes(Number(type))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 오류유형 값입니다.' });
        }
        if (!typeDetail || ![1, 2, 3].includes(Number(typeDetail))) {
            return res.status(400).json({ success: false, error: '유효하지 않은 안전영향도 값입니다.' });
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

module.exports = router;
