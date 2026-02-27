const oracledb = require('oracledb');
const fs = require('fs');
const path = require('path');

// Oracle 11g Thick mode
try {
    oracledb.initOracleClient({ libDir: 'C:\\instantclient_11_2' });
} catch (err) {
    console.error('Oracle Client 초기화 실패:', err.message);
}

const dbConfig = {
    user: 'cssown',
    password: 'cssadmin',
    connectString: 'localhost:1521/XE'
};

async function setupDatabase() {
    let conn;
    try {
        console.log('Oracle 연결 중...');
        conn = await oracledb.getConnection(dbConfig);
        console.log('Oracle 연결 성공!\n');

        // 1. T_SIMILAR_CALLSIGN_PAIR 테이블 생성
        console.log('=== T_SIMILAR_CALLSIGN_PAIR 테이블 생성 ===');
        try {
            await conn.execute(`DROP TABLE T_SIMILAR_CALLSIGN_PAIR`);
            console.log('기존 테이블 삭제됨');
        } catch (e) {
            // 테이블이 없으면 무시
        }

        await conn.execute(`
            CREATE TABLE T_SIMILAR_CALLSIGN_PAIR (
                IDX NUMBER PRIMARY KEY,
                DETECTED VARCHAR2(30),
                CLEARED VARCHAR2(30),
                CCP VARCHAR2(10),
                FP1_CALLSIGN VARCHAR2(20),
                FP1_DEPT VARCHAR2(10),
                FP1_DEST VARCHAR2(10),
                FP1_EOBT VARCHAR2(10),
                FP1_FID VARCHAR2(20),
                FP1_ALT VARCHAR2(10),
                FP2_CALLSIGN VARCHAR2(20),
                FP2_DEPT VARCHAR2(10),
                FP2_DEST VARCHAR2(10),
                FP2_EOBT VARCHAR2(10),
                FP2_FID VARCHAR2(20),
                FP2_ALT VARCHAR2(10),
                AOD_MATCH NUMBER,
                FID_LEN_MATCH NUMBER,
                MATCH_POS NUMBER,
                MATCH_LEN NUMBER,
                COMP_RAT NUMBER,
                SIMILARITY NUMBER,
                CTRL_PEAK NUMBER,
                SCORE_PEAK NUMBER,
                MARK NUMBER
            )
        `);
        console.log('T_SIMILAR_CALLSIGN_PAIR 테이블 생성 완료\n');

        // 2. T_SIMILAR_CALLSIGN_PAIR_REPORT 테이블 생성
        console.log('=== T_SIMILAR_CALLSIGN_PAIR_REPORT 테이블 생성 ===');
        try {
            await conn.execute(`DROP TABLE T_SIMILAR_CALLSIGN_PAIR_REPORT`);
            console.log('기존 테이블 삭제됨');
        } catch (e) {
            // 테이블이 없으면 무시
        }

        await conn.execute(`
            CREATE TABLE T_SIMILAR_CALLSIGN_PAIR_REPORT (
                IDX NUMBER NOT NULL,
                REPORTED VARCHAR2(20) NOT NULL,
                REPORTER VARCHAR2(2) NOT NULL,
                AO NUMBER(1) NOT NULL,
                TYPE NUMBER(1) NOT NULL,
                TYPE_DETAIL NUMBER(1) NOT NULL,
                REMARK VARCHAR2(400) DEFAULT '-' NOT NULL,
                PRIMARY KEY (IDX, REPORTED)
            )
        `);
        console.log('T_SIMILAR_CALLSIGN_PAIR_REPORT 테이블 생성 완료\n');

        // 3. CSV 파일 읽기 및 데이터 입력
        console.log('=== CSV 데이터 입력 ===');
        const csvPath = path.join(__dirname, 'similar_callsign.csv');
        const csvContent = fs.readFileSync(csvPath, 'utf-8');
        const lines = csvContent.split('\n').filter(line => line.trim());

        // 헤더 파싱
        const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
        console.log('컬럼:', header.join(', '));
        console.log(`총 ${lines.length - 1}개 행 처리 중...\n`);

        // 데이터 행 처리
        let insertCount = 0;
        let errorCount = 0;

        for (let i = 1; i < lines.length; i++) {
            const line = lines[i].trim();
            if (!line) continue;

            // CSV 파싱 (쉼표로 분리, 따옴표 처리)
            const values = line.split(',').map(v => v.replace(/"/g, '').trim());

            if (values.length < 25) continue;

            try {
                await conn.execute(`
                    INSERT INTO T_SIMILAR_CALLSIGN_PAIR
                    (IDX, DETECTED, CLEARED, CCP,
                     FP1_CALLSIGN, FP1_DEPT, FP1_DEST, FP1_EOBT, FP1_FID, FP1_ALT,
                     FP2_CALLSIGN, FP2_DEPT, FP2_DEST, FP2_EOBT, FP2_FID, FP2_ALT,
                     AOD_MATCH, FID_LEN_MATCH, MATCH_POS, MATCH_LEN,
                     COMP_RAT, SIMILARITY, CTRL_PEAK, SCORE_PEAK, MARK)
                    VALUES
                    (:1, :2, :3, :4, :5, :6, :7, :8, :9, :10,
                     :11, :12, :13, :14, :15, :16, :17, :18, :19, :20,
                     :21, :22, :23, :24, :25)
                `, [
                    parseInt(values[0]) || 0,           // IDX
                    values[1] || null,                  // DETECTED
                    values[2] || null,                  // CLEARED
                    values[3] || null,                  // CCP
                    values[4] || null,                  // FP1_CALLSIGN
                    values[5] || null,                  // FP1_DEPT
                    values[6] || null,                  // FP1_DEST
                    values[7] || null,                  // FP1_EOBT
                    values[8] || null,                  // FP1_FID
                    values[9] || null,                  // FP1_ALT
                    values[10] || null,                 // FP2_CALLSIGN
                    values[11] || null,                 // FP2_DEPT
                    values[12] || null,                 // FP2_DEST
                    values[13] || null,                 // FP2_EOBT
                    values[14] || null,                 // FP2_FID
                    values[15] || null,                 // FP2_ALT
                    parseInt(values[16]) || 0,          // AOD_MATCH
                    parseInt(values[17]) || 0,          // FID_LEN_MATCH
                    parseInt(values[18]) || 0,          // MATCH_POS
                    parseInt(values[19]) || 0,          // MATCH_LEN
                    parseInt(values[20]) || 0,          // COMP_RAT
                    parseInt(values[21]) || 0,          // SIMILARITY
                    parseInt(values[22]) || 0,          // CTRL_PEAK
                    parseInt(values[23]) || 0,          // SCORE_PEAK
                    parseInt(values[24]) || 0           // MARK
                ]);
                insertCount++;

                // 진행상황 표시
                if (insertCount % 200 === 0) {
                    process.stdout.write(`\r${insertCount}개 행 입력됨...`);
                }
            } catch (err) {
                errorCount++;
                if (errorCount <= 5) {
                    console.error(`\n행 ${i} 오류:`, err.message);
                }
            }
        }

        await conn.commit();
        console.log(`\n\n입력 완료: ${insertCount}개 성공, ${errorCount}개 실패`);

        // 4. 결과 확인
        console.log('\n=== 데이터 확인 ===');
        const result = await conn.execute(
            `SELECT COUNT(*) as CNT FROM T_SIMILAR_CALLSIGN_PAIR`
        );
        console.log(`T_SIMILAR_CALLSIGN_PAIR: ${result.rows[0][0]}개 행`);

        const result2 = await conn.execute(
            `SELECT COUNT(*) as CNT FROM T_SIMILAR_CALLSIGN_PAIR_REPORT`
        );
        console.log(`T_SIMILAR_CALLSIGN_PAIR_REPORT: ${result2.rows[0][0]}개 행`);

        console.log('\n데이터베이스 설정 완료!');

    } catch (err) {
        console.error('오류 발생:', err);
    } finally {
        if (conn) {
            await conn.close();
            console.log('\nOracle 연결 종료');
        }
    }
}

setupDatabase();
