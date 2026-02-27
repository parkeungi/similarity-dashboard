const db = require('../config/database');
const oracledb = require('oracledb');

async function setup() {
    let conn;
    try {
        await db.initialize();
        conn = await db.getConnection();

        // 테이블 존재 여부 확인
        const check = await conn.execute(
            `SELECT COUNT(*) AS CNT FROM USER_TABLES WHERE TABLE_NAME = 'A_REALTIME_LOGIN'`
        );

        if (check.rows[0][0] === 0) {
            // 테이블 생성 (모두 VARCHAR2)
            await conn.execute(`
                CREATE TABLE A_REALTIME_LOGIN (
                    USER_ID    VARCHAR2(20),
                    USER_NM    VARCHAR2(50),
                    CREAT_DT   VARCHAR2(20),
                    ISTERM     VARCHAR2(1)
                )
            `);
            console.log('A_REALTIME_LOGIN 테이블 생성 완료');
        } else {
            // 기존 데이터 삭제
            await conn.execute('DELETE FROM A_REALTIME_LOGIN');
            console.log('기존 데이터 삭제 완료');
        }

        // 테스트 데이터 삽입 (현재 시간 범위에 맞도록)
        const names = [
            { id: 'ctrl01', nm: '홍길동' },
            { id: 'ctrl02', nm: '김철수' },
            { id: 'ctrl03', nm: '박영희' },
            { id: 'ctrl04', nm: '이민수' },
            { id: 'ctrl05', nm: '최지우' },
            { id: 'ctrl06', nm: '정우진' },
            { id: 'ctrl07', nm: '윤서연' },
            { id: 'ctrl08', nm: '송현우' },
            { id: 'ctrl09', nm: '한승희' },
            { id: 'ctrl10', nm: '도윤서' },
            { id: 'ctrl11', nm: '문희정' },
            { id: 'ctrl12', nm: '양재훈' }
        ];

        for (const n of names) {
            await conn.execute(`
                INSERT INTO A_REALTIME_LOGIN (USER_ID, USER_NM, CREAT_DT, ISTERM)
                VALUES (:id, :nm, TO_CHAR(SYSDATE+9/24, 'YYYY-MM-DD HH24:MI:SS'), NULL)
            `, { id: n.id, nm: n.nm });
        }

        await conn.execute('COMMIT');
        console.log(`테스트 데이터 ${names.length}건 삽입 완료`);

        // 확인 조회
        const result = await conn.execute(
            `SELECT USER_NM FROM A_REALTIME_LOGIN
             WHERE CREAT_DT BETWEEN TO_CHAR(SYSDATE+7/24,'YYYY-MM-DD HH24:MI:SS') AND TO_CHAR(SYSDATE+11/24,'YYYY-MM-DD HH24:MI:SS')
             AND ISTERM IS NULL
             ORDER BY USER_NM`,
            {}, { outFormat: oracledb.OUT_FORMAT_OBJECT }
        );
        console.log('조회 결과:', result.rows.map(r => r.USER_NM));

    } catch (err) {
        console.error('오류:', err);
    } finally {
        if (conn) await conn.close();
        await db.close();
    }
}

setup();
