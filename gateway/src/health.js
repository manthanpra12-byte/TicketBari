// Health check: asks every node "are you alive?" and reports UP or DOWN.
// Services also check their own Postgres and Redis connections in their /health.

const redis = require('./redis');

const CATALOG_URL = process.env.CATALOG_URL || 'http://catalog:3001';
const BOOKING_URL = process.env.BOOKING_URL || 'http://booking:3002';

// HTTP nodes we ping
const nodes = {
  catalog: CATALOG_URL + '/health',
  booking: BOOKING_URL + '/health',
};

async function pingNode(url) {
  try {
    // give up after 2 seconds so one dead service cannot hang the report
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.ok ? 'UP' : 'DOWN';
  } catch (err) {
    return 'DOWN'; // connection refused, timeout, etc.
  }
}

async function pingRedis() {
  try {
    return (await redis.ping()) === 'PONG' ? 'UP' : 'DOWN';
  } catch (err) {
    return 'DOWN';
  }
}

async function checkHealth() {
  const names = Object.keys(nodes);

  // ping everything at the same time
  const results = await Promise.all(names.map((name) => pingNode(nodes[name])));

  const report = { gateway: 'UP' };
  names.forEach((name, i) => {
    report[name] = results[i];
  });
  if (redis) {
    report.redis = await pingRedis();
  }

  const allUp = Object.values(report).every((s) => s === 'UP');
  report.status = allUp ? 'OK' : 'DEGRADED';
  return report;
}

module.exports = { checkHealth };
