'use strict';

/**
 * timeUtil.js - KST/UTC 시간 변환 유틸리티
 *
 * DB의 DETECTED/CLEARED 컬럼은 UTC로 저장.
 * 프론트엔드와 사용자 입력은 KST(UTC+9) 기준.
 * 이 모듈이 서버 측 변환을 담당.
 */

const KST_OFFSET_MS = 9 * 60 * 60 * 1000; // 9시간 (밀리초)

/**
 * KST 날짜 문자열을 UTC로 변환 (필터 날짜 → DB 쿼리용)
 * @param {string} kstStr - KST 날짜 (예: '2026-03-05' 또는 '2026-03-05 23:59:59')
 * @returns {string} UTC 날짜 문자열
 */
function kstToUtc(kstStr) {
    if (!kstStr) return kstStr;
    // 날짜만 있으면 시간 추가
    const full = kstStr.length === 10 ? kstStr + ' 00:00:00' : kstStr;
    const d = new Date(full.replace(' ', 'T') + '+09:00');
    if (isNaN(d.getTime())) return kstStr;
    return formatDate(d);
}

/**
 * UTC 날짜 문자열을 KST로 변환 (DB 결과 → 프론트엔드 표시용)
 * @param {string} utcStr - UTC 날짜 (예: '2026-03-05 06:30:00')
 * @returns {string} KST 날짜 문자열
 */
function utcToKst(utcStr) {
    if (!utcStr) return utcStr;
    // 센티넬 값은 변환하지 않음
    if (utcStr === '9999-12-31 23:59:59') return utcStr;
    const d = new Date(utcStr.replace(' ', 'T') + 'Z');
    if (isNaN(d.getTime())) return utcStr;
    const kst = new Date(d.getTime() + KST_OFFSET_MS);
    return formatDate(kst);
}

/**
 * Date 객체를 'YYYY-MM-DD HH:MM:SS' 형식 문자열로 변환 (UTC 기준)
 */
function formatDate(d) {
    return d.getUTCFullYear() + '-' +
        String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(d.getUTCDate()).padStart(2, '0') + ' ' +
        String(d.getUTCHours()).padStart(2, '0') + ':' +
        String(d.getUTCMinutes()).padStart(2, '0') + ':' +
        String(d.getUTCSeconds()).padStart(2, '0');
}

/**
 * 현재 KST 날짜 문자열 반환 ('YYYY-MM-DD')
 */
function getKstToday() {
    const now = new Date(Date.now() + KST_OFFSET_MS);
    return now.getUTCFullYear() + '-' +
        String(now.getUTCMonth() + 1).padStart(2, '0') + '-' +
        String(now.getUTCDate()).padStart(2, '0');
}

/**
 * 결과 행 배열의 DETECTED/CLEARED 컬럼을 UTC→KST 변환
 * @param {Object[]} rows - DB 조회 결과 행 배열
 * @returns {Object[]} 변환된 행 배열 (원본 수정)
 */
function convertRowsToKst(rows) {
    if (!rows) return rows;
    rows.forEach(row => {
        if (row.DETECTED) row.DETECTED = utcToKst(row.DETECTED);
        if (row.CLEARED) row.CLEARED = utcToKst(row.CLEARED);
    });
    return rows;
}

/**
 * 현재 KST 시각 Date 객체 반환 (UTC 메서드로 KST 값 접근 가능)
 * @returns {Date}
 */
function getKstNow() {
    return new Date(Date.now() + KST_OFFSET_MS);
}

/**
 * 동계/하계 시즌 기반 조회 대상 월 계산
 * 하계: 3~10월, 동계: 11~2월
 * 시즌 경계에서는 축소된 범위 적용 (최대 3개월)
 *
 * @param {number} kstMonth - 현재 KST 월 (1~12)
 * @param {number} kstYear - 현재 KST 년도
 * @returns {Array<{year: number, month: number}>} 조회 대상 (year, month) 배열
 */
function getSeasonalLookback(kstMonth, kstYear) {
    const results = [];

    if (kstMonth === 11 || kstMonth === 3) {
        // 시즌 시작월 → 같은 달만 참조 (이전 시즌 데이터 불필요)
        results.push({ year: kstYear, month: kstMonth });
    } else if (kstMonth === 12) {
        // 동계 → 11, 12월
        results.push({ year: kstYear, month: 11 });
        results.push({ year: kstYear, month: 12 });
    } else if (kstMonth === 1) {
        // 동계 → 11, 12월(전년), 1월
        results.push({ year: kstYear - 1, month: 11 });
        results.push({ year: kstYear - 1, month: 12 });
        results.push({ year: kstYear, month: 1 });
    } else if (kstMonth === 2) {
        // 동계 → 11, 12월(전년), 1, 2월
        results.push({ year: kstYear - 1, month: 11 });
        results.push({ year: kstYear - 1, month: 12 });
        results.push({ year: kstYear, month: 1 });
        results.push({ year: kstYear, month: 2 });
    } else if (kstMonth === 4) {
        // 하계 → 3, 4월
        results.push({ year: kstYear, month: 3 });
        results.push({ year: kstYear, month: 4 });
    } else if (kstMonth === 5) {
        // 하계 → 3, 4, 5월
        results.push({ year: kstYear, month: 3 });
        results.push({ year: kstYear, month: 4 });
        results.push({ year: kstYear, month: 5 });
    } else {
        // 하계 6~10월 → 최근 3개월 + 현재월
        for (let i = 3; i >= 1; i--) {
            let m = kstMonth - i;
            let y = kstYear;
            if (m <= 0) { m += 12; y--; }
            results.push({ year: y, month: m });
        }
        results.push({ year: kstYear, month: kstMonth });
    }

    return results;
}

module.exports = {
    kstToUtc,
    utcToKst,
    getKstToday,
    getKstNow,
    getSeasonalLookback,
    convertRowsToKst
};
