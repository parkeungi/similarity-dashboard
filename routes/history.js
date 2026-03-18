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
const { kstToUtc, convertRowsToKst } = require('../config/timeUtil');
const { getCachedSettings, normalizeThresholds, safeErrorMessage } = require('../config/settingsCache');

// =====================================================================
// 상수 정의
// =====================================================================

/** 활성 레코드를 나타내는 CLEARED 컬럼의 센티넬 값 */
const ACTIVE_CLEARED_VALUE = '9999-12-31 23:59:59';

/** 페이지당 최대 레코드 수 (초과 입력 시 이 값으로 제한) */
const PAGE_SIZE_MAX = 200;

/** 페이지당 기본 레코드 수 */
const PAGE_SIZE_DEFAULT = 50;

/** 기본 표시 대상 섹터 목록 (설정 파일에 없을 때 fallback) */
const DEFAULT_SECTORS = ['3', '2', '10', '9', '11', '13', '12'];

/**
 * 표시 대상 섹터 목록을 settings.json에서 동적으로 읽음 (캐싱)
 * @returns {string[]} fixedSectors 배열
 */
function getAllowedSectors() {
    try {
        const settings = getCachedSettings();
        return (settings?.fixedSectors && settings.fixedSectors.length > 0)
            ? settings.fixedSectors
            : DEFAULT_SECTORS;
    } catch (e) {
        return DEFAULT_SECTORS;
    }
}

function getThresholdsFromSettings() {
    try {
        const settings = getCachedSettings();
        return normalizeThresholds(settings?.thresholds);
    } catch (err) {
        console.error('history 설정 파일 읽기 실패:', err);
        return normalizeThresholds();
    }
}

// =====================================================================
// 유틸리티 함수
// =====================================================================

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
/**
 * @param {Object} params
 * @param {string} [params.prefix=''] - 테이블 alias prefix (예: 'c.' — 추천 쿼리용)
 */
function buildWhereClause({ from, to, sector, sectors, risk, status, thresholds, prefix = '' }) {
    let whereClause = '1=1';
    const binds = {};
    const dateRegex = /^\d{4}-\d{2}-\d{2}/;
    const p = prefix;  // 'c.' 또는 ''

    // --- 날짜 범위 필터 (DETECTED 기준, KST→UTC 변환 후 비교) ---
    if (from) {
        if (!dateRegex.test(from)) {
            throw new Error('시작일 형식이 유효하지 않습니다.');
        }
        whereClause += ` AND ${p}DETECTED >= :startDt`;
        binds.startDt = kstToUtc(from);
    }
    if (to) {
        if (!dateRegex.test(to)) {
            throw new Error('종료일 형식이 유효하지 않습니다.');
        }
        const toFull = to.length === 10 ? to + ' 23:59:59' : to;
        whereClause += ` AND ${p}DETECTED <= :endDt`;
        binds.endDt = kstToUtc(toFull);
    }

    // --- 섹터 필터 (다중 섹터 지원) ---
    const allowedSectors = getAllowedSectors();
    if (sectors) {
        // 다중 섹터 (쉼표 구분)
        const sectorList = sectors.split(',').filter(s => /^\d+$/.test(s.trim()));
        if (sectorList.length > 0) {
            const placeholders = sectorList.map((_, i) => `:sec${i}`).join(', ');
            whereClause += ` AND ${p}CCP IN (${placeholders})`;
            sectorList.forEach((s, i) => { binds[`sec${i}`] = s.trim(); });
        }
    } else if (sector && sector !== 'ALL') {
        // 단일 섹터 (하위 호환)
        if (!allowedSectors.includes(sector)) {
            throw new Error('유효하지 않은 섹터입니다.');
        }
        whereClause += ` AND ${p}CCP = :sector`;
        binds.sector = sector;
    } else {
        // 전체 조회 시에도 허용된 섹터만
        whereClause += ` AND ${p}CCP IN (${allowedSectors.map((_, i) => `:sec${i}`).join(', ')})`;
        allowedSectors.forEach((sec, i) => {
            binds[`sec${i}`] = sec;
        });
    }

    // --- 위험도 필터 (SIMILARITY 기준) ---
    if (risk) {
        const simThresholds = normalizeThresholds(thresholds).similarity;
        if (risk === 'danger') {
            whereClause += ` AND ${p}SIMILARITY > :simCritical`;
            binds.simCritical = simThresholds.critical;
        } else if (risk === 'warning') {
            whereClause += ` AND ${p}SIMILARITY > :simCaution AND ${p}SIMILARITY <= :simCritical`;
            binds.simCaution = simThresholds.caution;
            binds.simCritical = simThresholds.critical;
        } else if (risk === 'info') {
            whereClause += ` AND ${p}SIMILARITY <= :simCaution`;
            binds.simCaution = simThresholds.caution;
        }
    } else {
        // risk 미지정 시: displaySimilarity 설정 적용 (매우높음/높음만 선택 시 보통 제외)
        const settings = getCachedSettings();
        const displaySimilarity = settings?.displaySimilarity || [];
        if (displaySimilarity.length > 0) {
            const simThresholds = normalizeThresholds(thresholds).similarity;
            const conditions = [];
            let needCritical = false, needCaution = false;
            if (displaySimilarity.includes('critical')) {
                conditions.push(`${p}SIMILARITY > :dsCritical`);
                needCritical = true;
            }
            if (displaySimilarity.includes('caution')) {
                conditions.push(`(${p}SIMILARITY > :dsCaution AND ${p}SIMILARITY <= :dsCritical)`);
                needCritical = true;
                needCaution = true;
            }
            if (displaySimilarity.includes('monitor')) {
                conditions.push(`${p}SIMILARITY <= :dsCaution`);
                needCaution = true;
            }
            if (needCritical) binds.dsCritical = simThresholds.critical;
            if (needCaution) binds.dsCaution = simThresholds.caution;
            if (conditions.length) {
                whereClause += ` AND (${conditions.join(' OR ')})`;
            }
        }
    }

    // --- 활성/해제 상태 필터 (CLEARED 기준, 바인드 변수 사용) ---
    if (status === 'active') {
        whereClause += ` AND ${p}CLEARED = :clearedVal`;
        binds.clearedVal = ACTIVE_CLEARED_VALUE;
    } else if (status === 'cleared') {
        whereClause += ` AND ${p}CLEARED != :clearedVal`;
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
        const { from, to, sector, sectors, risk, status } = req.query;
        const { page, pageSize } = parsePagination(req.query.page, req.query.pageSize);
        const thresholds = getThresholdsFromSettings();

        // ROWNUM 페이지네이션 범위 계산
        const minRow = (page - 1) * pageSize;       // 이전 페이지까지의 행 수 (exclusive)
        const maxRow = page * pageSize;              // 현재 페이지까지의 행 수 (inclusive)

        const { whereClause, binds } = buildWhereClause({ from, to, sector, sectors, risk, status, thresholds });

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
                        c.CTRL_PEAK,
                        c.AOD_MATCH,
                        CASE WHEN r.IDX IS NOT NULL THEN 1 ELSE 0 END AS HAS_REPORT,
                        r.REPORTER,
                        r.REPORTED,
                        r.AO,
                        r.TYPE AS REPORT_TYPE,
                        r.TYPE_DETAIL,
                        r.REMARK
                    FROM T_SIMILAR_CALLSIGN_PAIR c
                    LEFT JOIN (
                        SELECT IDX, REPORTER, REPORTED, AO, TYPE, TYPE_DETAIL, REMARK
                        FROM (
                            SELECT IDX, REPORTER, REPORTED, AO, TYPE, TYPE_DETAIL, REMARK,
                                   ROW_NUMBER() OVER (PARTITION BY IDX ORDER BY REPORTED DESC) AS RN
                            FROM T_SIMILAR_CALLSIGN_PAIR_REPORT
                        )
                        WHERE RN = 1
                    ) r ON r.IDX = c.IDX
                    WHERE ${whereClause}
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
            data: convertRowsToKst(dataResult.rows),
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
        const { from, to, sector, sectors } = req.query;
        const thresholds = getThresholdsFromSettings();
        const { whereClause, binds } = buildWhereClause({ from, to, sector, sectors, thresholds });

        // summary용 바인드에 CLEARED 센티넬 값 추가 (CASE WHEN에서 사용)
        const summaryBinds = Object.assign({}, binds, {
            clearedSentinel: ACTIVE_CLEARED_VALUE,
            simCritical: thresholds.similarity.critical,
            simCaution: thresholds.similarity.caution
        });

        conn = await db.getConnection();

        // 순차 실행 (단일 connection에서 병렬 실행 시 Thick mode 안정성 문제)
        const summaryResult = await conn.execute(`
            SELECT
                COUNT(*) AS TOTAL_COUNT,
                SUM(CASE WHEN SIMILARITY > :simCritical THEN 1 ELSE 0 END) AS DANGER_CNT,
                SUM(CASE WHEN SIMILARITY > :simCaution AND SIMILARITY <= :simCritical THEN 1 ELSE 0 END) AS WARNING_CNT,
                SUM(CASE WHEN SIMILARITY <= :simCaution THEN 1 ELSE 0 END) AS INFO_CNT,
                SUM(CASE WHEN CLEARED = :clearedSentinel THEN 1 ELSE 0 END) AS ACTIVE_COUNT,
                SUM(CASE WHEN CLEARED != :clearedSentinel THEN 1 ELSE 0 END) AS CLEARED_COUNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            WHERE ${whereClause}
        `, summaryBinds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const byDateResult = await conn.execute(`
            SELECT
                TO_CHAR(TO_DATE(c.DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'YYYY-MM-DD') AS DETECT_DATE,
                COUNT(*) AS CNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            WHERE ${whereClause}
            GROUP BY TO_CHAR(TO_DATE(c.DETECTED, 'YYYY-MM-DD HH24:MI:SS') + 9/24, 'YYYY-MM-DD')
            ORDER BY DETECT_DATE ASC
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const bySectorResult = await conn.execute(`
            SELECT c.CCP, COUNT(*) AS CNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            WHERE ${whereClause}
            GROUP BY c.CCP
            ORDER BY c.CCP ASC
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

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

// =====================================================================
// 누락 추천 — CRITERIA 미등록 패턴을 DB에서 동적으로 탐지
// =====================================================================

/* buildDateSectorClause 제거됨 — buildWhereClause({ prefix: 'c.' })로 통합 */

/**
 * 기존 CRITERIA 등록 패턴 규칙 기반으로 미등록 패턴의 유사도를 추정
 *
 * 규칙 (기존 24개 등록 패턴 분석 결과):
 *   COMP=50 + POS=0(전체매치)        → 4 (매우높음)
 *   COMP=50 + AOD=1                  → 4
 *   COMP=50 + 그 외                  → 3
 *   AOD=1 + COMP>=43 + LEN>=3       → 4
 *   AOD=1 + FID=1 + COMP>=38 + LEN>=3 → 3
 *   AOD=0 + FID=1 + COMP>=38 + LEN>=3 → 1
 *   COMP=40 + AOD=1                  → 2
 *   COMP=40 + AOD=0                  → 1
 *   AOD=1 + COMP>=33 + LEN=2        → 2
 *   AOD=0 + FID=0 + COMP>=33        → 0
 *   COMP<=29 + AOD=0                 → 0
 *   나머지                           → 0
 */
function estimateSimilarity({ AOD_MATCH: aod, FID_LEN_MATCH: fid, MATCH_POS: pos, MATCH_LEN: len, COMP_RAT: comp }) {
    if (comp >= 50 && pos === 0) return 4;
    if (comp >= 50 && aod === 1) return 4;
    if (comp >= 50) return 3;
    if (aod === 1 && comp >= 43 && len >= 3) return 4;
    if (aod === 1 && fid === 1 && comp >= 38 && len >= 3) return 3;
    if (aod === 0 && fid === 1 && comp >= 38 && len >= 3) return 1;
    if (comp >= 40 && aod === 1) return 2;
    if (comp >= 40) return 1;
    if (aod === 1 && comp >= 33 && len === 2) return 2;
    if (aod === 0 && fid === 0 && comp >= 33) return 0;
    if (comp <= 29 && aod === 0) return 0;
    return 0;
}

/**
 * GET /history/recommendations/unregistered
 * PAIR에서 SIMILARITY=-1인 패턴 중 CRITERIA에 미등록인 패턴 목록
 * → 이 패턴들을 등록하면 향후 유사도가 정상 산출됨
 */
router.get('/recommendations/unregistered', async (req, res) => {
    let conn;
    try {
        const { from, to, sector, sectors } = req.query;
        const { whereClause: clause, binds } = buildWhereClause({ from, to, sector, sectors, prefix: 'c.' });

        conn = await db.getConnection();

        // PAIR에서 SIMILARITY=-1인 패턴을 집계 + 대표 호출부호 예시 포함
        const result = await conn.execute(`
            SELECT
                p.AOD_MATCH,
                p.FID_LEN_MATCH,
                p.MATCH_POS,
                p.MATCH_LEN,
                p.COMP_RAT,
                p.CNT AS PAIR_COUNT,
                p.SAMPLE_FP1,
                p.SAMPLE_FP2,
                cr.SIMILARITY AS REGISTERED_SIM
            FROM (
                SELECT
                    c.AOD_MATCH, c.FID_LEN_MATCH, c.MATCH_POS, c.MATCH_LEN, c.COMP_RAT,
                    COUNT(*) AS CNT,
                    MAX(c.FP1_CALLSIGN) AS SAMPLE_FP1,
                    MAX(c.FP2_CALLSIGN) AS SAMPLE_FP2
                FROM T_SIMILAR_CALLSIGN_PAIR c
                WHERE c.SIMILARITY = -1
                  AND ${clause}
                GROUP BY c.AOD_MATCH, c.FID_LEN_MATCH, c.MATCH_POS, c.MATCH_LEN, c.COMP_RAT
            ) p
            LEFT JOIN T_SIMILAR_CALLSIGN_CRITERIA cr
                ON  cr.AOD_MATCH         = p.AOD_MATCH
                AND cr.FID_LENGTH_MATCH  = p.FID_LEN_MATCH
                AND cr.MATCH_POSITION    = p.MATCH_POS
                AND cr.MATCH_LENGTH      = p.MATCH_LEN
                AND cr.COMPOSITION_RATIO = p.COMP_RAT
            ORDER BY cr.SIMILARITY NULLS FIRST, p.COMP_RAT DESC, p.MATCH_LEN DESC, p.CNT DESC
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        // 미등록 / 등록됨 분리 + 미등록에 추정 유사도 추가
        const unregistered = [];
        const registered = [];
        for (const row of result.rows) {
            if (row.REGISTERED_SIM == null) {
                row.ESTIMATED_SIM = estimateSimilarity(row);
                unregistered.push(row);
            } else {
                registered.push(row);
            }
        }

        res.json({
            success: true,
            data: {
                unregistered,
                registered,
                unregisteredCount: unregistered.reduce((sum, r) => sum + r.PAIR_COUNT, 0),
                registeredCount: registered.reduce((sum, r) => sum + r.PAIR_COUNT, 0)
            }
        });
    } catch (err) {
        console.error('미등록 패턴 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

/**
 * GET /history/recommendations
 * SIMILARITY = -1 중 CRITERIA 미등록 패턴에 해당하는 개별 건 목록
 *
 * 동작 방식:
 *   1) CRITERIA 테이블 전체를 조회하여 등록된 패턴 집합 파악
 *   2) PAIR에서 SIMILARITY=-1이면서 CRITERIA에 매칭되지 않는 건 조회
 */
router.get('/recommendations', async (req, res) => {
    let conn;
    try {
        const { from, to, sector, sectors } = req.query;
        const { page, pageSize } = parsePagination(req.query.page, req.query.pageSize);

        const minRow = (page - 1) * pageSize;
        const maxRow = page * pageSize;

        const { whereClause: clause, binds } = buildWhereClause({ from, to, sector, sectors, prefix: 'c.' });
        const paginationBinds = Object.assign({}, binds, { minRow, maxRow });

        // CRITERIA에 미등록인 SIMILARITY=-1 건 조회 (LEFT JOIN + IS NULL)
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
                        c.CTRL_PEAK,
                        c.AOD_MATCH,
                        c.FID_LEN_MATCH,
                        c.MATCH_POS,
                        c.MATCH_LEN,
                        c.COMP_RAT
                    FROM T_SIMILAR_CALLSIGN_PAIR c
                    LEFT JOIN T_SIMILAR_CALLSIGN_CRITERIA cr
                        ON  cr.AOD_MATCH         = c.AOD_MATCH
                        AND cr.FID_LENGTH_MATCH  = c.FID_LEN_MATCH
                        AND cr.MATCH_POSITION    = c.MATCH_POS
                        AND cr.MATCH_LENGTH      = c.MATCH_LEN
                        AND cr.COMPOSITION_RATIO = c.COMP_RAT
                    WHERE c.SIMILARITY = -1
                      AND cr.AOD_MATCH IS NULL
                      AND ${clause}
                    ORDER BY c.COMP_RAT DESC, c.MATCH_LEN DESC, c.DETECTED DESC
                ) a
                WHERE ROWNUM <= :maxRow
            )
            WHERE rnum > :minRow
        `;

        const countSql = `
            SELECT COUNT(*) AS TOTAL_COUNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            LEFT JOIN T_SIMILAR_CALLSIGN_CRITERIA cr
                ON  cr.AOD_MATCH         = c.AOD_MATCH
                AND cr.FID_LENGTH_MATCH  = c.FID_LEN_MATCH
                AND cr.MATCH_POSITION    = c.MATCH_POS
                AND cr.MATCH_LENGTH      = c.MATCH_LEN
                AND cr.COMPOSITION_RATIO = c.COMP_RAT
            WHERE c.SIMILARITY = -1
              AND cr.AOD_MATCH IS NULL
              AND ${clause}
        `;

        conn = await db.getConnection();

        const dataResult = await conn.execute(dataSql, paginationBinds, { outFormat: oracledb.OUT_FORMAT_OBJECT });
        const countResult = await conn.execute(countSql, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const totalCount = countResult.rows[0]?.TOTAL_COUNT || 0;
        const totalPages = Math.ceil(totalCount / pageSize);

        res.json({
            success: true,
            data: convertRowsToKst(dataResult.rows),
            pagination: { page, pageSize, totalCount, totalPages }
        });
    } catch (err) {
        console.error('누락 추천 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

/**
 * GET /history/recommendations/summary
 * 누락 추천 건수 집계 (통계 카드용)
 */
router.get('/recommendations/summary', async (req, res) => {
    let conn;
    try {
        const { from, to, sector, sectors } = req.query;
        const { whereClause: clause, binds } = buildWhereClause({ from, to, sector, sectors, prefix: 'c.' });

        conn = await db.getConnection();

        const result = await conn.execute(`
            SELECT COUNT(*) AS TOTAL_COUNT
            FROM T_SIMILAR_CALLSIGN_PAIR c
            LEFT JOIN T_SIMILAR_CALLSIGN_CRITERIA cr
                ON  cr.AOD_MATCH         = c.AOD_MATCH
                AND cr.FID_LENGTH_MATCH  = c.FID_LEN_MATCH
                AND cr.MATCH_POSITION    = c.MATCH_POS
                AND cr.MATCH_LENGTH      = c.MATCH_LEN
                AND cr.COMPOSITION_RATIO = c.COMP_RAT
            WHERE c.SIMILARITY = -1
              AND cr.AOD_MATCH IS NULL
              AND ${clause}
        `, binds, { outFormat: oracledb.OUT_FORMAT_OBJECT });

        const totalCount = result.rows[0]?.TOTAL_COUNT ?? 0;
        res.json({
            success: true,
            data: { totalCount }
        });
    } catch (err) {
        console.error('누락 추천 통계 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

/**
 * POST /history/recommendations/register
 * 미등록 패턴을 T_SIMILAR_CALLSIGN_CRITERIA 테이블에 등록
 *
 * CRITERIA 컬럼명 매핑:
 *   PAIR: FID_LEN_MATCH → CRITERIA: FID_LENGTH_MATCH
 *   PAIR: MATCH_POS     → CRITERIA: MATCH_POSITION
 *   PAIR: MATCH_LEN     → CRITERIA: MATCH_LENGTH
 *   PAIR: COMP_RAT      → CRITERIA: COMPOSITION_RATIO
 */
router.post('/recommendations/register', async (req, res) => {
    let conn;
    try {
        const items = req.body.items;
        if (!Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ success: false, error: '등록할 항목이 없습니다.' });
        }
        if (items.length > 50) {
            return res.status(400).json({ success: false, error: '한 번에 최대 50건까지 등록할 수 있습니다.' });
        }

        conn = await db.getConnection();

        let inserted = 0;
        let skipped = 0;

        for (const item of items) {
            const aod = Number(item.AOD_MATCH);
            const fidLen = Number(item.FID_LEN_MATCH);
            const matchPos = Number(item.MATCH_POS);
            const matchLen = Number(item.MATCH_LEN);
            const compRat = Number(item.COMP_RAT);
            const similarity = Number(item.SIMILARITY);
            const example = item.EXAMPLE ? String(item.EXAMPLE).substring(0, 50) : '';

            // 입력값 검증 (정수 여부 포함)
            if (![0, 1].includes(aod) || ![0, 1].includes(fidLen) ||
                !Number.isInteger(matchPos) || matchPos < 0 || matchPos > 4 ||
                !Number.isInteger(matchLen) || matchLen < 2 || matchLen > 4 ||
                !Number.isInteger(compRat) || compRat < 0 || compRat > 100 ||
                !Number.isInteger(similarity) || similarity < 0 || similarity > 4) {
                skipped++;
                continue;
            }

            // MERGE: 중복이면 건너뛰고, 없으면 INSERT (race condition 방어)
            const mergeResult = await conn.execute(`
                MERGE INTO T_SIMILAR_CALLSIGN_CRITERIA cr
                USING (SELECT :aod AS AOD_MATCH, :fidLen AS FID_LENGTH_MATCH,
                              :matchPos AS MATCH_POSITION, :matchLen AS MATCH_LENGTH,
                              :compRat AS COMPOSITION_RATIO FROM DUAL) src
                ON (cr.AOD_MATCH = src.AOD_MATCH
                    AND cr.FID_LENGTH_MATCH = src.FID_LENGTH_MATCH
                    AND cr.MATCH_POSITION = src.MATCH_POSITION
                    AND cr.MATCH_LENGTH = src.MATCH_LENGTH
                    AND cr.COMPOSITION_RATIO = src.COMPOSITION_RATIO)
                WHEN NOT MATCHED THEN INSERT
                    (EXAMPLE, AOD_MATCH, FID_LENGTH_MATCH, MATCH_POSITION, MATCH_LENGTH, COMPOSITION_RATIO, SIMILARITY)
                VALUES (:example, :aod, :fidLen, :matchPos, :matchLen, :compRat, :similarity)
            `, { example, aod, fidLen, matchPos, matchLen, compRat, similarity });

            if (mergeResult.rowsAffected > 0) {
                inserted++;
            } else {
                skipped++;
            }
        }

        await conn.execute('COMMIT');

        res.json({
            success: true,
            data: { inserted, skipped, total: items.length }
        });
    } catch (err) {
        console.error('기준 등록 오류:', err);
        if (conn) {
            try { await conn.execute('ROLLBACK'); } catch (e) { /* ignore */ }
        }
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

/**
 * GET /history/recommendations/criteria-check
 * CRITERIA 테이블 전체 조회
 */
router.get('/recommendations/criteria-check', async (req, res) => {
    let conn;
    try {
        conn = await db.getConnection();

        const result = await conn.execute(`
            SELECT AOD_MATCH, FID_LENGTH_MATCH, MATCH_POSITION, MATCH_LENGTH, COMPOSITION_RATIO, SIMILARITY
            FROM T_SIMILAR_CALLSIGN_CRITERIA
            ORDER BY SIMILARITY DESC, AOD_MATCH DESC
        `, [], { outFormat: oracledb.OUT_FORMAT_OBJECT });

        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('기준 조회 오류:', err);
        res.status(500).json({ success: false, error: safeErrorMessage(err) });
    } finally {
        if (conn) await conn.close();
    }
});

module.exports = router;
