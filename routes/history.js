/**
 * history.js - 유사호출부호 이력/아카이브 조회 API 라우터
 *
 * @description T_SIMILAR_CALLSIGN_PAIR 테이블의 전체 이력 데이터를 조회하는 엔드포인트.
 *              실시간 화면(/api/callsigns)과 달리 CLEARED 상태 무관하게 기간 필터로 조회.
 *              Oracle 11g 호환 ROWNUM 페이지네이션 적용.
 *
 * Endpoints:
 *   GET /api/history         - 페이지네이션 이력 목록
 *   GET /api/history/summary - 기간 집계 통계
 */

'use strict';

const express = require('express');
const router = express.Router();
const oracledb = require('oracledb');
const db = require('../config/database');

// =====================================================================
// 상수 정의
// =====================================================================

/** 활성 레코드를 나타내는 CLEARED 컬럼의 센티넬 값 */
const ACTIVE_CLEARED_VALUE = '9999-12-31 23:59:59';

/** 페이지당 최대 레코드 수 (초과 입력 시 이 값으로 제한) */
const PAGE_SIZE_MAX = 200;

/** 페이지당 기본 레코드 수 */
const PAGE_SIZE_DEFAULT = 50;

/**
 * 표시 대상 섹터 목록 (FIXED_SECTORS와 동일)
 * @description GL, GH, KL, KH, JN, JL, JH 섹터만 이력 조회 대상
 */
const ALLOWED_SECTORS = ['3', '2', '10', '9', '11', '13', '12'];

// =====================================================================
// 유틸리티 함수
// =====================================================================

/**
 * 에러 메시지를 안전하게 처리 (내부 정보 노출 방지)
 *
 * @param {Error} err - 발생한 에러 객체
 * @returns {string} 사용자에게 표시할 안전한 한국어 메시지
 */
function safeErrorMessage(err) {
    console.error('Error:', err); // 서버 로그에만 상세 기록
    return '요청 처리 중 오류가 발생했습니다.';
}

/**
 * 페이지 번호와 페이지 크기 파라미터를 검증 및 정규화
 *
 * @param {string|number} rawPage     - 요청 쿼리의 page 값
 * @param {string|number} rawPageSize - 요청 쿼리의 pageSize 값
 * @returns {{ page: number, pageSize: number }} 검증된 양의 정수 값
 */
function parsePagination(rawPage, rawPageSize) {
    // parseInt 후 NaN/음수/0 방어: 이 경우 기본값으로 fallback
    let page = parseInt(rawPage, 10);
    if (!Number.isFinite(page) || page < 1) {
        page = 1;
    }

    let pageSize = parseInt(rawPageSize, 10);
    if (!Number.isFinite(pageSize) || pageSize < 1) {
        pageSize = PAGE_SIZE_DEFAULT;
    }

    // 최대 허용 크기 초과 시 상한 적용
    if (pageSize > PAGE_SIZE_MAX) {
        pageSize = PAGE_SIZE_MAX;
    }

    return { page, pageSize };
}

/**
 * 공통 WHERE 절 빌더 - DETECTED 날짜, 섹터, 위험도, 상태 필터 조합
 *
 * @description 모든 파라미터는 bind 변수로 처리하여 SQL Injection 방지.
 *              반환된 whereClause는 "WHERE 1=1" 이후 조건이므로
 *              실제 SQL에서는 "WHERE " + whereClause 형태로 사용.
 *
 * @param {Object} params
 * @param {string} [params.from]   - 시작일 (YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS)
 * @param {string} [params.to]     - 종료일 (YYYY-MM-DD 또는 YYYY-MM-DD HH:MM:SS)
 * @param {string} [params.sector] - 섹터 코드, 'ALL' 또는 미입력 시 전체
 * @param {string} [params.risk]   - 'danger' | 'warning' | 'info' | '' (전체)
 * @param {string} [params.status] - 'active' | 'cleared' | '' (전체)
 * @returns {{ whereClause: string, binds: Object }}
 */
function buildWhereClause({ from, to, sector, risk, status }) {
    let whereClause = '1=1';
    const binds = {};
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;

    // --- 날짜 범위 필터 (DETECTED 기준, 형식 검증 포함) ---
    if (from) {
        if (!dateRegex.test(from)) {
            throw new Error('시작일 형식이 유효하지 않습니다.');
        }
        whereClause += ' AND DETECTED >= :startDt';
        binds.startDt = from;
    }
    if (to) {
        if (!dateRegex.test(to)) {
            throw new Error('종료일 형식이 유효하지 않습니다.');
        }
        whereClause += ' AND DETECTED <= :endDt';
        binds.endDt = to;
    }

    // --- 섹터 필터 (ALLOWED_SECTORS 내 섹터만 조회) ---
    if (sector && sector !== 'ALL') {
        // 특정 섹터 선택 시 (ALLOWED_SECTORS 포함 여부도 검증)
        if (!ALLOWED_SECTORS.includes(sector)) {
            throw new Error('유효하지 않은 섹터입니다.');
        }
        whereClause += ' AND CCP = :sector';
        binds.sector = sector;
    } else {
        // 전체 조회 시에도 ALLOWED_SECTORS 내 섹터만
        whereClause += ` AND CCP IN (${ALLOWED_SECTORS.map((_, i) => `:sec${i}`).join(', ')})`;
        ALLOWED_SECTORS.forEach((sec, i) => {
            binds[`sec${i}`] = sec;
        });
    }

    // --- 위험도 필터 (SIMILARITY 기준) ---
    if (risk === 'danger') {
        whereClause += ' AND SIMILARITY > 2';
    } else if (risk === 'warning') {
        whereClause += ' AND SIMILARITY > 1 AND SIMILARITY <= 2';
    } else if (risk === 'info') {
        whereClause += ' AND SIMILARITY <= 1';
    }

    // --- 활성/해제 상태 필터 (CLEARED 기준, 바인드 변수 사용) ---
    if (status === 'active') {
        whereClause += ' AND CLEARED = :clearedVal';
        binds.clearedVal = ACTIVE_CLEARED_VALUE;
    } else if (status === 'cleared') {
        whereClause += ' AND CLEARED != :clearedVal';
        binds.clearedVal = ACTIVE_CLEARED_VALUE;
    }

    return { whereClause, binds };
}

// =====================================================================
// 라우트 핸들러
// =====================================================================

/**
 * GET /history
 * 유사호출부호 이력 목록 페이지네이션 조회
 *
 * @description DETECTED 날짜 기준으로 T_SIMILAR_CALLSIGN_PAIR 전체 이력을 조회.
 *              LEFT JOIN으로 오류보고서 존재 여부(HAS_REPORT)를 함께 반환.
 *              Oracle 11g에 OFFSET/FETCH FIRST가 없으므로 ROWNUM 이중 서브쿼리 사용.
 *
 * @query {string} [from]     - 시작일 (DETECTED 기준)
 * @query {string} [to]       - 종료일 (DETECTED 기준)
 * @query {string} [sector]   - 섹터 코드 ('ALL' = 전체)
 * @query {string} [risk]     - 위험도 ('danger'|'warning'|'info'|'' = 전체)
 * @query {string} [status]   - 상태 ('active'|'cleared'|'' = 전체)
 * @query {number} [page=1]   - 페이지 번호 (1-based)
 * @query {number} [pageSize=50] - 페이지당 건수 (최대 200)
 *
 * @returns {{ success: boolean, data: Array, pagination: Object }}
 */
router.get('/', async (req, res) => {
    let conn;
    try {
        const { from, to, sector, risk, status } = req.query;
        const { page, pageSize } = parsePagination(req.query.page, req.query.pageSize);

        // ROWNUM 페이지네이션 범위 계산
        const minRow = (page - 1) * pageSize;       // 이전 페이지까지의 행 수 (exclusive)
        const maxRow = page * pageSize;              // 현재 페이지까지의 행 수 (inclusive)

        const { whereClause, binds } = buildWhereClause({ from, to, sector, risk, status });

        // 페이지네이션 bind 변수 추가
        const paginationBinds = Object.assign({}, binds, {
            minRow: minRow,
            maxRow: maxRow
        });

        /**
         * Oracle 11g 페이지네이션 패턴:
         *   외부: rnum > :minRow  (이전 페이지 행 제거)
         *   중간: ROWNUM <= :maxRow (현재 페이지까지만)
         *   내부: LEFT JOIN으로 보고 여부 확인 + GROUP BY로 중복 제거
         *   정렬: DETECTED DESC, IDX DESC (결정적 정렬 보장)
         */
        const dataSql = `
            SELECT *
            FROM (
                SELECT a.*, ROWNUM rnum
                FROM (
                    SELECT
                        c.IDX,
                        c.DETECTED,
                        c.CLEARED,
                        c.CCP,
                        c.FP1_CALLSIGN,
                        c.FP1_DEPT,
                        c.FP1_DEST,
                        c.FP1_EOBT,
                        c.FP1_ALT,
                        c.FP2_CALLSIGN,
                        c.FP2_DEPT,
                        c.FP2_DEST,
                        c.FP2_EOBT,
                        c.FP2_ALT,
                        c.SIMILARITY,
                        c.SCORE_PEAK,
                        CASE WHEN COUNT(r.IDX) > 0 THEN 1 ELSE 0 END AS HAS_REPORT
                    FROM T_SIMILAR_CALLSIGN_PAIR c
                    LEFT JOIN T_SIMILAR_CALLSIGN_PAIR_REPORT r ON r.IDX = c.IDX
                    WHERE ${whereClause}
                    GROUP BY c.IDX, c.DETECTED, c.CLEARED, c.CCP,
                             c.FP1_CALLSIGN, c.FP1_DEPT, c.FP1_DEST, c.FP1_EOBT, c.FP1_ALT,
                             c.FP2_CALLSIGN, c.FP2_DEPT, c.FP2_DEST, c.FP2_EOBT, c.FP2_ALT,
                             c.SIMILARITY, c.SCORE_PEAK
                    ORDER BY c.DETECTED DESC, c.IDX DESC
                ) a
                WHERE ROWNUM <= :maxRow
            )
            WHERE rnum > :minRow
        `;

        // 총 건수 쿼리 (페이지네이션 totalPages 계산용)
        const countSql = `
            SELECT COUNT(*) AS TOTAL_COUNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            WHERE ${whereClause}
        `;

        conn = await db.getConnection();

        // 데이터 쿼리와 카운트 쿼리를 동일 connection에서 순차 실행
        // (단일 connection은 병렬 Promise.all 대신 순차 await 권장)
        const dataResult = await conn.execute(
            dataSql,
            paginationBinds,
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const countResult = await conn.execute(
            countSql,
            binds,
            { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );

        const totalCount = countResult.rows[0]?.TOTAL_COUNT || 0;
        const totalPages = Math.ceil(totalCount / pageSize);

        res.json({
            success: true,
            data: dataResult.rows,
            pagination: {
                page,
                pageSize,
                totalCount,
                totalPages
            }
        });
    } catch (err) {
        console.error('이력 목록 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

/**
 * GET /history/summary
 * 유사호출부호 이력 집계 통계 조회
 *
 * @description 지정 기간 내 T_SIMILAR_CALLSIGN_PAIR 데이터를 다각도로 집계.
 *              단일 connection에서 3개 쿼리를 Promise.all 병렬 실행.
 *              risk+status 통합 쿼리로 테이블 스캔 최소화.
 *
 * @query {string} [from]   - 시작일 (DETECTED 기준)
 * @query {string} [to]     - 종료일 (DETECTED 기준)
 * @query {string} [sector] - 섹터 코드 ('ALL' = 전체)
 *
 * @returns {{
 *   success: boolean,
 *   data: {
 *     totalCount: number,
 *     activeCount: number,
 *     clearedCount: number,
 *     byRisk: { DANGER_CNT: number, WARNING_CNT: number, INFO_CNT: number },
 *     byDate: Array<{ DETECT_DATE: string, CNT: number }>,
 *     bySector: Array<{ CCP: string, CNT: number }>
 *   }
 * }}
 */
router.get('/summary', async (req, res) => {
    let conn;
    try {
        const { from, to, sector } = req.query;
        const { whereClause, binds } = buildWhereClause({ from, to, sector });

        // summary용 바인드에 CLEARED 센티넬 값 추가 (CASE WHEN에서 사용)
        const summaryBinds = Object.assign({}, binds, {
            clearedSentinel: ACTIVE_CLEARED_VALUE
        });

        conn = await db.getConnection();

        // 단일 커넥션에서 3개 쿼리 병렬 실행 (admin.js 패턴과 동일)
        const [summaryResult, byDateResult, bySectorResult] = await Promise.all([
            // [1] 전체 건수 + 위험도별 + 활성/해제 건수를 단일 쿼리로 통합
            conn.execute(`
                SELECT
                    COUNT(*) AS TOTAL_COUNT,
                    SUM(CASE WHEN SIMILARITY > 2 THEN 1 ELSE 0 END) AS DANGER_CNT,
                    SUM(CASE WHEN SIMILARITY > 1 AND SIMILARITY <= 2 THEN 1 ELSE 0 END) AS WARNING_CNT,
                    SUM(CASE WHEN SIMILARITY <= 1 THEN 1 ELSE 0 END) AS INFO_CNT,
                    SUM(CASE WHEN CLEARED = :clearedSentinel THEN 1 ELSE 0 END) AS ACTIVE_COUNT,
                    SUM(CASE WHEN CLEARED != :clearedSentinel THEN 1 ELSE 0 END) AS CLEARED_COUNT
                FROM T_SIMILAR_CALLSIGN_PAIR c
                WHERE ${whereClause}
            `, summaryBinds, { outFormat: oracledb.OUT_FORMAT_OBJECT }),

            // [2] 일별 검출 건수
            conn.execute(`
                SELECT
                    SUBSTR(c.DETECTED, 1, 10) AS DETECT_DATE,
                    COUNT(*) AS CNT
                FROM T_SIMILAR_CALLSIGN_PAIR c
                WHERE ${whereClause}
                GROUP BY SUBSTR(c.DETECTED, 1, 10)
                ORDER BY DETECT_DATE ASC
            `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT }),

            // [3] 섹터별 검출 건수
            conn.execute(`
                SELECT c.CCP, COUNT(*) AS CNT
                FROM T_SIMILAR_CALLSIGN_PAIR c
                WHERE ${whereClause}
                GROUP BY c.CCP
                ORDER BY c.CCP ASC
            `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT })
        ]);

        const s = summaryResult.rows[0] || {};

        res.json({
            success: true,
            data: {
                totalCount:   s.TOTAL_COUNT   ?? 0,
                activeCount:  s.ACTIVE_COUNT  ?? 0,
                clearedCount: s.CLEARED_COUNT ?? 0,
                byRisk: {
                    DANGER_CNT:  s.DANGER_CNT  ?? 0,
                    WARNING_CNT: s.WARNING_CNT ?? 0,
                    INFO_CNT:    s.INFO_CNT    ?? 0
                },
                byDate:   byDateResult.rows,
                bySector: bySectorResult.rows
            }
        });
    } catch (err) {
        console.error('이력 통계 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

module.exports = router;
