-- ============================================================
-- Similar Callsign Monitoring System - Oracle 11g Schema
-- ============================================================
-- Database: Oracle 11g XE
-- Character Set: UTF-8
-- Date columns: VARCHAR2 (format: 'YYYY-MM-DD HH24:MI:SS')
-- ============================================================

-- Drop existing tables (optional - uncomment if needed)
-- DROP TABLE T_SIMILAR_CALLSIGN_PAIR_REPORT CASCADE CONSTRAINTS;
-- DROP TABLE T_SIMILAR_CALLSIGN_PAIR CASCADE CONSTRAINTS;

-- ============================================================
-- Table: T_SIMILAR_CALLSIGN_PAIR
-- Description: Similar callsign pair detection data
-- ============================================================
CREATE TABLE T_SIMILAR_CALLSIGN_PAIR (
    IDX             NUMBER(10)      NOT NULL,
    DETECTED        VARCHAR2(20)    NOT NULL,   -- Detection time (YYYY-MM-DD HH24:MI:SS)
    CLEARED         VARCHAR2(20)    DEFAULT '9999-12-31 23:59:59',  -- Clear time (9999-12-31 = active)
    CCP             VARCHAR2(10),               -- Sector code (e.g., 'T1E', 'T2W', 'D1')

    -- Flight Plan 1
    FP1_CALLSIGN    VARCHAR2(10),               -- Callsign (e.g., 'KAL123')
    FP1_DEPT        VARCHAR2(4),                -- Departure airport (ICAO)
    FP1_DEST        VARCHAR2(4),                -- Destination airport (ICAO)
    FP1_EOBT        VARCHAR2(20),               -- Estimated Off-Block Time
    FP1_FID         VARCHAR2(20),               -- Flight ID
    FP1_ALT         VARCHAR2(10),               -- Altitude

    -- Flight Plan 2
    FP2_CALLSIGN    VARCHAR2(10),
    FP2_DEPT        VARCHAR2(4),
    FP2_DEST        VARCHAR2(4),
    FP2_EOBT        VARCHAR2(20),
    FP2_FID         VARCHAR2(20),
    FP2_ALT         VARCHAR2(10),

    -- Similarity metrics
    AOD_MATCH       VARCHAR2(1),                -- Arrival/Departure match flag
    FID_LEN_MATCH   VARCHAR2(1),                -- Flight ID length match flag
    MATCH_POS       NUMBER(2),                  -- Match position
    MATCH_LEN       NUMBER(2),                  -- Match length
    COMP_RAT        NUMBER(5,2),                -- Comparison ratio
    SIMILARITY      NUMBER(5,2),                -- Similarity score (key metric)
    CTRL_PEAK       NUMBER(5,2),                -- Control peak value
    SCORE_PEAK      NUMBER(5,2),                -- Score peak (error probability)
    MARK            VARCHAR2(10),               -- Additional mark

    CONSTRAINT PK_SIMILAR_CALLSIGN_PAIR PRIMARY KEY (IDX)
);

-- Indexes for performance
CREATE INDEX IDX_SCP_DETECTED ON T_SIMILAR_CALLSIGN_PAIR(DETECTED);
CREATE INDEX IDX_SCP_CLEARED ON T_SIMILAR_CALLSIGN_PAIR(CLEARED);
CREATE INDEX IDX_SCP_CCP ON T_SIMILAR_CALLSIGN_PAIR(CCP);
CREATE INDEX IDX_SCP_SIMILARITY ON T_SIMILAR_CALLSIGN_PAIR(SIMILARITY);

-- ============================================================
-- Table: T_SIMILAR_CALLSIGN_PAIR_REPORT
-- Description: Error reports for similar callsign incidents
-- ============================================================
CREATE TABLE T_SIMILAR_CALLSIGN_PAIR_REPORT (
    IDX             NUMBER(10)      NOT NULL,   -- Reference to T_SIMILAR_CALLSIGN_PAIR
    REPORTED        VARCHAR2(20)    NOT NULL,   -- Report time (YYYY-MM-DD HH24:MI:SS)
    REPORTER        VARCHAR2(50),               -- Reporter name
    AO              NUMBER(1),                  -- Error aircraft: 1=FP1, 2=FP2, 3=Both
    TYPE            NUMBER(1),                  -- Error type: 1=Controller, 2=Pilot, 3=Readback, 4=No response, 5=Other
    TYPE_DETAIL     NUMBER(1),                  -- Safety impact: 1=Minor, 2=Moderate, 3=Severe
    REMARK          VARCHAR2(500),              -- Additional remarks

    CONSTRAINT PK_SIMILAR_REPORT PRIMARY KEY (IDX, REPORTED),
    CONSTRAINT FK_REPORT_PAIR FOREIGN KEY (IDX) REFERENCES T_SIMILAR_CALLSIGN_PAIR(IDX)
);

-- Index for report queries
CREATE INDEX IDX_REPORT_REPORTED ON T_SIMILAR_CALLSIGN_PAIR_REPORT(REPORTED);
CREATE INDEX IDX_REPORT_TYPE ON T_SIMILAR_CALLSIGN_PAIR_REPORT(TYPE);

-- ============================================================
-- Table: A_REALTIME_LOGIN (Optional - for reporter selection)
-- Description: Currently logged-in users
-- Note: This may already exist in your system
-- ============================================================
-- CREATE TABLE A_REALTIME_LOGIN (
--     USER_NM     VARCHAR2(50),
--     CREAT_DT    VARCHAR2(20),
--     ISTERM      VARCHAR2(1)
-- );

-- ============================================================
-- Sequence for IDX auto-increment
-- ============================================================
CREATE SEQUENCE SEQ_SIMILAR_CALLSIGN_PAIR
    START WITH 1
    INCREMENT BY 1
    NOCACHE
    NOCYCLE;

COMMIT;
