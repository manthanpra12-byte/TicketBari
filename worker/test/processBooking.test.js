// Test for processBooking using fake database and Redis objects (no real services needed).
// Run with: npm test
const assert = require('assert');
const path = require('path');

const src = path.join(__dirname, '..', 'src') + path.sep;

let scenario = 'happy';
let queries = [];
let redisCalls = [];

// A fake database connection that records the SQL it receives
const fakeClient = {
  async query(sql) {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('SELECT id FROM seats')) return { rows: [{ id: 1 }, { id: 2 }] };
    if (sql.includes('INSERT INTO booking_seats') && scenario === 'conflict') {
      const err = new Error('duplicate key');
      err.code = '23505'; // PostgreSQL "unique violation"
      throw err;
    }
    return { rows: [] };
  },
  release() {},
};
const fakePool = {
  async query(sql) {
    queries.push(sql.replace(/\s+/g, ' ').trim());
    if (sql.includes('SELECT status FROM bookings')) {
      return { rows: [{ status: scenario === 'already_done' ? 'CONFIRMED' : 'PENDING' }] };
    }
    return { rows: [] };
  },
  connect: async () => fakeClient,
};
const fakeRedis = {
  async del(...keys) {
    redisCalls.push(['del', ...keys]);
  },
  async incr(key) {
    redisCalls.push(['incr', key]);
  },
};

// Put the fakes in place of ./db and ./redis before loading processBooking
for (const [file, fake] of [['db.js', fakePool], ['redis.js', fakeRedis]]) {
  const resolved = require.resolve(src + file);
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports: fake };
}
const { processBooking } = require(src + 'processBooking.js');

const job = { booking_id: 'b1', show_id: '1', user_id: 'u1', seats: 'A1,A2', request_id: 'r1' };

async function run(name, env) {
  scenario = name;
  queries = [];
  redisCalls = [];
  Object.assign(process.env, { PAYMENT_TIME_MS: '1', RETRY_BASE_MS: '1', PAYMENT_RETRIES: '2' }, env);
  const realLog = console.log;
  console.log = () => {}; // silence the JSON logs during the test
  try {
    await processBooking(job);
  } finally {
    console.log = realLog;
  }
  return { sql: queries.join(' | '), redisCalls };
}

async function main() {
  // 1. Payment works: booking is confirmed in one transaction
  let r = await run('happy', { PAYMENT_FAIL_RATE: '0' });
  assert.ok(r.sql.includes('BEGIN') && r.sql.includes('COMMIT'), 'committed');
  assert.strictEqual(queries.filter((q) => q.includes('INSERT INTO booking_seats')).length, 2);
  assert.ok(r.sql.includes("status = 'CONFIRMED'"));
  assert.deepStrictEqual(r.redisCalls, [['incr', 'metrics:bookings_confirmed']]);

  // 2. Payment always fails: retried 2 times, then FAILED and the seats are released
  r = await run('decline', { PAYMENT_FAIL_RATE: '1' });
  assert.ok(!r.sql.includes('BEGIN'), 'no transaction when payment fails');
  assert.ok(r.sql.includes("status = 'FAILED'"));
  assert.strictEqual(r.redisCalls.filter((c) => c[1] === 'metrics:payment_retries').length, 2);
  assert.ok(r.redisCalls.some((c) => c[0] === 'del' && c.includes('hold:1:A1') && c.includes('hold:1:A2')));
  assert.ok(r.redisCalls.some((c) => c[1] === 'metrics:bookings_failed'));

  // 3. Another booking already owns the seat: roll back, FAILED, release seats
  r = await run('conflict', { PAYMENT_FAIL_RATE: '0' });
  assert.ok(r.sql.includes('ROLLBACK'));
  assert.ok(r.sql.includes("status = 'FAILED'"));
  assert.ok(r.redisCalls.some((c) => c[0] === 'del'));

  // 4. The job is delivered a second time after the booking is done: do nothing
  r = await run('already_done', { PAYMENT_FAIL_RATE: '0' });
  assert.ok(!r.sql.includes('BEGIN') && !r.sql.includes("status = 'FAILED'"));
  assert.deepStrictEqual(r.redisCalls, []);

  console.log('All processBooking tests passed');
}

main();
