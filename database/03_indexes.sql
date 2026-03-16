-- 유사호출부호 경고 시스템 성능 최적화 인덱스
-- 실행 전 기존 인덱스 존재 여부 확인 권장

-- 실시간 활성 데이터 조회 최적화 (GET /api/callsigns)
-- CLEARED 센티넬 값 + 섹터 + 검출시각 기준
CREATE INDEX IDX_PAIR_CLEARED_CCP_DET
    ON T_SIMILAR_CALLSIGN_PAIR (CLEARED, CCP, DETECTED);

-- 이력 조회 최적화 (GET /api/history, 기간+섹터 필터)
CREATE INDEX IDX_PAIR_DETECTED_CCP
    ON T_SIMILAR_CALLSIGN_PAIR (DETECTED, CCP);

-- 보고서 조회 최적화 (LEFT JOIN, 보고 건수 서브쿼리)
CREATE INDEX IDX_REPORT_IDX
    ON T_SIMILAR_CALLSIGN_PAIR_REPORT (IDX);

-- 예측 쿼리 최적화 (NOT EXISTS 서브쿼리에서 활성 쌍 확인)
CREATE INDEX IDX_PAIR_ACTIVE_CALLSIGNS
    ON T_SIMILAR_CALLSIGN_PAIR (CLEARED, FP1_CALLSIGN, FP2_CALLSIGN);
