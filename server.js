const express = require('express');
const path = require('path');
const db = require('./config/database');

const app = express();
const PORT = 4000;

// ==================== Rate Limiting (인메모리) ====================
const rateLimitStore = new Map();
let rateLimitCleanupInterval = null;

// 만료된 Rate Limit 항목 정리 (단일 interval로 관리)
function startRateLimitCleanup(windowMs = 60000) {
    if (rateLimitCleanupInterval) return; // 이미 실행 중이면 무시

    rateLimitCleanupInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, data] of rateLimitStore.entries()) {
            if (now - data.startTime > windowMs) {
                rateLimitStore.delete(key);
            }
        }
    }, 300000); // 5분마다 정리
}

// 정리 interval 중지 (서버 종료 시 호출)
function stopRateLimitCleanup() {
    if (rateLimitCleanupInterval) {
        clearInterval(rateLimitCleanupInterval);
        rateLimitCleanupInterval = null;
    }
}

/**
 * Rate Limiting 미들웨어 생성
 * @param {Object} options - { windowMs, max, message }
 */
function createRateLimiter(options = {}) {
    const windowMs = options.windowMs || 60000;  // 기본 1분
    const max = options.max || 100;              // 기본 100회
    const message = options.message || '요청이 너무 많습니다. 잠시 후 다시 시도해주세요.';

    // 정리 interval 시작 (최초 1회만)
    startRateLimitCleanup(windowMs);

    return (req, res, next) => {
        const key = req.ip || req.connection.remoteAddress;
        const now = Date.now();

        let record = rateLimitStore.get(key);

        if (!record || now - record.startTime > windowMs) {
            // 새 윈도우 시작
            record = { count: 1, startTime: now };
            rateLimitStore.set(key, record);
        } else {
            record.count++;
        }

        // 남은 요청 수 헤더 추가
        res.setHeader('X-RateLimit-Limit', max);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, max - record.count));

        if (record.count > max) {
            return res.status(429).json({ success: false, error: message });
        }

        next();
    };
}

// API Rate Limiter (분당 100회)
const apiLimiter = createRateLimiter({
    windowMs: 60000,
    max: 100,
    message: 'API 요청이 너무 많습니다. 1분 후 다시 시도해주세요.'
});

// 관리자 API Rate Limiter (분당 60회, 더 엄격)
const adminLimiter = createRateLimiter({
    windowMs: 60000,
    max: 60,
    message: '관리자 API 요청이 너무 많습니다. 1분 후 다시 시도해주세요.'
});

// 보안 헤더 미들웨어
app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'");
    next();
});

// 미들웨어
app.use(express.json({ limit: '50mb' })); // CSV 업로드를 위해 크기 제한 증가
app.use(express.static(path.join(__dirname, 'public')));

// 같은 서버에서 서빙하므로 CORS 불필요 (폐쇄망 단일서버)

// API 라우터 (Rate Limiting 적용)
app.use('/api/admin', adminLimiter, require('./routes/admin'));
app.use('/api/history', apiLimiter, require('./routes/history'));
app.use('/api', apiLimiter, require('./routes/api'));

// 기본 라우트
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/history', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'history.html'));
});

// 초기 설정 페이지 (도메인 설정 안내)
app.get('/setup', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'setup.html'));
});

// 서버 시작
async function startServer() {
    try {
        await db.initialize();
        app.listen(PORT, () => {
            console.log('='.repeat(50));
            console.log('  유사호출부호 모니터링 시스템 시작');
            console.log('='.repeat(50));
            console.log(`  관제사 화면: http://callsign.monitor:${PORT}`);
            console.log(`  관리자 화면: http://callsign.monitor:${PORT}/admin`);
            console.log(`  검출 이력:   http://callsign.monitor:${PORT}/history`);
            console.log(`  초기 설정:   http://callsign.monitor:${PORT}/setup`);
            console.log('='.repeat(50));
        });
    } catch (err) {
        console.error('서버 시작 실패:', err);
        process.exit(1);
    }
}

// 종료 처리
async function gracefulShutdown(signal) {
    console.log(`\n${signal} 수신, 서버 종료 중...`);
    stopRateLimitCleanup(); // Rate Limit 정리 interval 중지
    await db.close();
    process.exit(0);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

startServer();
