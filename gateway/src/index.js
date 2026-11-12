// TicketBari API Gateway: the single entry point for every client request.
// Job: 1) tag + log the request  2) rate limit  3) route to the right service
//      4) stop calling a service that keeps failing (circuit breaker).

const express = require('express');
const crypto = require('crypto');
const rateLimiter = require('./rateLimiter');
const { checkHealth } = require('./health');
const CircuitBreaker = require('./circuitBreaker');
const redis = require('./redis');
const { getMetrics, resetMetrics } = require('./metrics');

const PORT = process.env.PORT || 8080;
const CATALOG_URL = process.env.CATALOG_URL || 'http://catalog:3001';
const BOOKING_URL = process.env.BOOKING_URL || 'http://booking:3002';
const LOG_REQUESTS = process.env.LOG_REQUESTS !== 'false'; // set to false during load tests

function log(msg, extra) {
  console.log(JSON.stringify({ svc: 'gateway', msg, ...extra }));
}

// One circuit breaker per service, so a broken booking service does not block browsing
const breakerOptions = {
  failureThreshold: Number(process.env.BREAKER_FAILURES) || 5,
  resetTimeoutMs: Number(process.env.BREAKER_RESET_MS) || 10000,
  onChange: (name, from, to) => log('circuit_' + to.toLowerCase(), { service: name, from }),
};
const breakers = {
  catalog: new CircuitBreaker('catalog', breakerOptions),
  booking: new CircuitBreaker('booking', breakerOptions),
};

const app = express();

// Allow the browser frontend (a different port) to call the gateway
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type, x-request-id');
  res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.set('Access-Control-Expose-Headers', 'x-request-id, x-cache');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json());

// Step 1: give every request an id and log it (the id lets us trace it later)
app.use((req, res, next) => {
  req.id = req.headers['x-request-id'] || crypto.randomUUID();
  res.set('x-request-id', req.id);
  const startedAt = Date.now();

  if (LOG_REQUESTS) {
    log('request_received', { request_id: req.id, method: req.method, path: req.originalUrl, ip: req.ip });
    res.on('finish', () => {
      log('request_completed', {
        request_id: req.id,
        status: res.statusCode,
        duration_ms: Date.now() - startedAt,
      });
    });
  }
  next();
});

// Health, metrics: BEFORE the rate limiter so monitoring is never blocked
app.get('/health', async (req, res) => {
  const report = await checkHealth();
  report.circuits = { catalog: breakers.catalog.state, booking: breakers.booking.state };
  res.json(report);
});

app.get('/metrics', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  try {
    const metrics = await getMetrics(redis);
    metrics.circuits = { catalog: breakers.catalog.state, booking: breakers.booking.state };
    res.json(metrics);
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Zero the counters before a load test run
app.post('/metrics/reset', async (req, res) => {
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  try {
    await resetMetrics(redis);
    res.json({ status: 'reset' });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

// Count every API request (including the ones the limiter rejects next)
app.use((req, res, next) => {
  if (redis) redis.incr('metrics:requests_total').catch(() => {});
  next();
});

// Step 2: rate limit everything below this line
app.use(rateLimiter);

// Step 3: routing. Pick the service by URL prefix and forward the request.
function forwardTo(name, serviceUrl) {
  const breaker = breakers[name];

  return async (req, res) => {
    // Step 4: if this service keeps failing, do not even try
    if (!breaker.canRequest()) {
      log('circuit_rejected', { request_id: req.id, service: name });
      res.set('Retry-After', String(breaker.retryAfterSeconds()));
      return res
        .status(503)
        .json({ error: `${name} service is temporarily unavailable`, circuit: breaker.state });
    }

    try {
      const options = {
        method: req.method,
        headers: { 'content-type': 'application/json', 'x-request-id': req.id },
        signal: AbortSignal.timeout(5000), // do not wait forever
      };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        options.body = JSON.stringify(req.body || {});
      }

      // req.originalUrl is the full path, e.g. /api/movies/1/shows
      const response = await fetch(serviceUrl + req.originalUrl, options);
      const text = await response.text();

      // a 5xx answer counts as a failure, 2xx/4xx means the service is alive
      if (response.status >= 500) breaker.recordFailure();
      else breaker.recordSuccess();

      const cacheHeader = response.headers.get('x-cache'); // HIT or MISS from the catalog
      if (cacheHeader) res.set('x-cache', cacheHeader);

      res.status(response.status).type('application/json').send(text);
    } catch (err) {
      breaker.recordFailure(); // could not connect or timed out
      log('upstream_error', { request_id: req.id, service: name, error: err.message });
      res.status(502).json({ error: 'Service unavailable' });
    }
  };
}

app.use('/api/movies', forwardTo('catalog', CATALOG_URL));
app.use('/api/shows', forwardTo('catalog', CATALOG_URL));
app.use('/api/holds', forwardTo('booking', BOOKING_URL));
app.use('/api/bookings', forwardTo('booking', BOOKING_URL));

// Anything else: unknown route
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.listen(PORT, () => {
  log('started', { port: PORT });
});
