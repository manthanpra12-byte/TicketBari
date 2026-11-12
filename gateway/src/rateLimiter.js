// Express middleware that applies the token bucket to every request.
// With Redis the counters are shared by every gateway instance and survive
// a gateway restart. Without Redis it uses the in-memory version.

const fs = require('fs');
const path = require('path');
const { takeToken } = require('./tokenBucket');
const redis = require('./redis');

// Settings can be changed from docker-compose.yml / .env without touching code
const CAPACITY = Number(process.env.RATE_LIMIT_CAPACITY) || 20; // max burst
const REFILL_PER_SEC = Number(process.env.RATE_LIMIT_REFILL) || 10; // sustained speed
const LOG_REQUESTS = process.env.LOG_REQUESTS !== 'false';

const luaScript = redis ? fs.readFileSync(path.join(__dirname, 'tokenBucket.lua'), 'utf8') : null;

async function checkLimit(ip) {
  if (!redis) {
    return takeToken(ip, CAPACITY, REFILL_PER_SEC);
  }
  const [allowed, retryAfter] = await redis.eval(
    luaScript, 1, `ratelimit:${ip}`, CAPACITY, REFILL_PER_SEC, Date.now()
  );
  return { allowed: allowed === 1, retryAfter };
}

async function rateLimiter(req, res, next) {
  let result;
  try {
    result = await checkLimit(req.ip);
  } catch (err) {
    // If Redis is down we let the request through instead of blocking everyone
    console.log(
      JSON.stringify({ svc: 'gateway', request_id: req.id, msg: 'rate_limiter_error', error: err.message })
    );
    return next();
  }

  if (!result.allowed) {
    if (LOG_REQUESTS) {
      console.log(
        JSON.stringify({ svc: 'gateway', request_id: req.id, msg: 'rate_limited', ip: req.ip })
      );
    }
    if (redis) redis.incr('metrics:rate_limited').catch(() => {});
    res.set('Retry-After', String(result.retryAfter));
    return res.status(429).json({
      error: 'Too Many Requests',
      retry_after_seconds: result.retryAfter,
    });
  }

  next(); // allowed: continue to the routes
}

module.exports = rateLimiter;
