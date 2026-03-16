'use strict';

/**
 * settingsCache.js - settings.json 캐싱 모듈
 *
 * 매 HTTP 요청마다 fs.readFileSync 호출을 방지하기 위해
 * 파일 수정시간(mtime) 기반 캐싱 적용.
 * 파일이 변경되지 않으면 메모리 캐시 반환.
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = path.join(__dirname, 'settings.json');

/** 기본 위험도 기준값 */
const DEFAULT_THRESHOLDS = {
    similarity: { critical: 2, caution: 1 },
    scorePeak: { critical: 40, caution: 20 }
};

/**
 * 위험도 기준값 정규화 (서버 전체 공용)
 */
function normalizeThresholds(thresholds) {
    const simCriticalRaw = Number(thresholds?.similarity?.critical);
    const simCautionRaw = Number(thresholds?.similarity?.caution);
    const scoreCriticalRaw = Number(thresholds?.scorePeak?.critical);
    const scoreCautionRaw = Number(thresholds?.scorePeak?.caution);

    const normalized = {
        similarity: {
            critical: Number.isFinite(simCriticalRaw) ? simCriticalRaw : DEFAULT_THRESHOLDS.similarity.critical,
            caution: Number.isFinite(simCautionRaw) ? simCautionRaw : DEFAULT_THRESHOLDS.similarity.caution
        },
        scorePeak: {
            critical: Number.isFinite(scoreCriticalRaw) ? scoreCriticalRaw : DEFAULT_THRESHOLDS.scorePeak.critical,
            caution: Number.isFinite(scoreCautionRaw) ? scoreCautionRaw : DEFAULT_THRESHOLDS.scorePeak.caution
        }
    };

    if (!(normalized.similarity.critical > normalized.similarity.caution)) {
        normalized.similarity = DEFAULT_THRESHOLDS.similarity;
    }
    if (!(normalized.scorePeak.critical > normalized.scorePeak.caution)) {
        normalized.scorePeak = DEFAULT_THRESHOLDS.scorePeak;
    }
    return normalized;
}

// 캐시 변수
let _cachedSettings = null;
let _cachedMtimeMs = 0;

/**
 * settings.json을 mtime 기반 캐싱으로 읽기
 * 파일이 변경되지 않았으면 이전 파싱 결과 반환
 * @returns {Object} 설정 객체
 */
function getCachedSettings() {
    try {
        const stat = fs.statSync(SETTINGS_PATH);
        const mtimeMs = stat.mtimeMs;

        if (_cachedSettings && mtimeMs === _cachedMtimeMs) {
            return _cachedSettings;
        }

        const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
        _cachedSettings = JSON.parse(data);
        _cachedMtimeMs = mtimeMs;
        return _cachedSettings;
    } catch (err) {
        console.error('settings.json 읽기 실패:', err.message);
        return null;
    }
}

/**
 * 캐시 무효화 (설정 저장 후 호출)
 */
function invalidateCache() {
    _cachedSettings = null;
    _cachedMtimeMs = 0;
}

module.exports = {
    getCachedSettings,
    invalidateCache,
    normalizeThresholds,
    DEFAULT_THRESHOLDS,
    SETTINGS_PATH
};
