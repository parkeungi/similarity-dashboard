'use strict';

/**
 * settingsCache.js - settings.json 캐싱 모듈
 *
 * fs.watch로 파일 변경 감시, 변경 시에만 비동기 재로드.
 * 동기 I/O(statSync, readFileSync)를 제거하여 이벤트 루프 블로킹 방지.
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

// 초기 로드 (서버 시작 시 1회, 동기 허용)
try {
    _cachedSettings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
} catch (err) {
    console.error('settings.json 초기 로드 실패:', err.message);
}

// 파일 변경 감시 — 변경 시 비동기 재로드
let _watchDebounce = null;
try {
    fs.watch(SETTINGS_PATH, (eventType) => {
        if (eventType !== 'change') return;
        // 디바운스: 짧은 시간 내 중복 이벤트 무시
        if (_watchDebounce) return;
        _watchDebounce = setTimeout(() => {
            _watchDebounce = null;
            fs.readFile(SETTINGS_PATH, 'utf8', (err, data) => {
                if (err) {
                    console.error('settings.json 재로드 실패:', err.message);
                    return;
                }
                try {
                    _cachedSettings = JSON.parse(data);
                } catch (parseErr) {
                    console.error('settings.json 파싱 실패:', parseErr.message);
                }
            });
        }, 100);
    });
} catch (err) {
    console.error('settings.json watch 실패:', err.message);
}

/**
 * 에러 메시지 안전하게 처리 (내부 정보 노출 방지)
 * @param {Error} err - 에러 객체
 * @returns {string} 안전한 에러 메시지
 */
function safeErrorMessage(err) {
    console.error('Error:', err); // 서버 로그에만 상세 기록
    return '요청 처리 중 오류가 발생했습니다.';
}

/**
 * 캐시된 설정 반환 (블로킹 없음)
 * @returns {Object} 설정 객체
 */
function getCachedSettings() {
    return _cachedSettings;
}

/**
 * 캐시 무효화 (설정 저장 후 즉시 반영)
 */
function invalidateCache() {
    try {
        const data = fs.readFileSync(SETTINGS_PATH, 'utf8');
        _cachedSettings = JSON.parse(data);
    } catch (err) {
        console.error('settings.json 캐시 무효화 실패:', err.message);
        _cachedSettings = null;
    }
}

module.exports = {
    getCachedSettings,
    invalidateCache,
    normalizeThresholds,
    safeErrorMessage,
    DEFAULT_THRESHOLDS,
    SETTINGS_PATH
};
