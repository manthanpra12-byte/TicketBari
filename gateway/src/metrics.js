// Reads the counters that all services keep in Redis (keys named metrics:...).

const NAMES = [
  'requests_total',     // gateway: API requests received
  'rate_limited',       // gateway: requests rejected with 429
  'cache_hits',         // catalog: answered from Redis
  'cache_misses',       // catalog: had to read PostgreSQL
  'bookings_enqueued',  // booking: jobs pushed to the queue
  'bookings_confirmed', // worker: finished as CONFIRMED
  'bookings_failed',    // worker: finished as FAILED
  'payment_retries',    // worker: fake payment attempts that were retried
];

async function getMetrics(redis) {
  const values = await redis.mget(NAMES.map((n) => 'metrics:' + n));

  const m = {};
  NAMES.forEach((name, i) => {
    m[name] = Number(values[i] || 0);
  });

  const lookups = m.cache_hits + m.cache_misses;
  m.cache_hit_ratio = lookups > 0 ? Number((m.cache_hits / lookups).toFixed(3)) : null;

  // jobs that were queued but are not finished yet (waiting or being processed)
  m.queue_depth = Math.max(0, m.bookings_enqueued - m.bookings_confirmed - m.bookings_failed);
  return m;
}

async function resetMetrics(redis) {
  await redis.del(...NAMES.map((n) => 'metrics:' + n));
}

module.exports = { getMetrics, resetMetrics };
