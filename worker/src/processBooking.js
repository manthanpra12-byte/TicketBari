// Processes ONE booking job: pretend to take payment (retrying if it fails),
// then finish the booking in PostgreSQL.

const os = require('os');
const pool = require('./db');
const redis = require('./redis');
const { withRetry } = require('./retry');

// Read the settings when needed (so they can be changed from docker-compose / .env)
function config() {
  return {
    failRate: Number(process.env.PAYMENT_FAIL_RATE ?? 0.3), // chance one payment attempt fails
    retries: Number(process.env.PAYMENT_RETRIES ?? 3),
    retryBaseMs: Number(process.env.RETRY_BASE_MS ?? 200),
    paymentMs: Number(process.env.PAYMENT_TIME_MS ?? 1000), // one attempt takes 1x to 2x this
  };
}

function log(job, msg, extra) {
  console.log(
    JSON.stringify({ svc: 'worker', worker: os.hostname(), request_id: job.request_id, msg, ...extra })
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Counters for /metrics. Never let a counter problem break a booking.
const count = (key) => redis.incr(key).catch(() => {});

// Fake payment: takes about 1 to 2 seconds, sometimes fails
async function simulatePayment() {
  const { failRate, paymentMs } = config();
  await sleep(paymentMs + Math.random() * paymentMs);
  if (Math.random() < failRate) {
    throw new Error('Payment declined');
  }
}

// Give the seats back so other users can hold them
async function releaseHolds(job) {
  const keys = job.seats.split(',').map((seat) => `hold:${job.show_id}:${seat}`);
  await redis.del(...keys);
}

async function markFailed(job, reason) {
  // only a PENDING booking can fail: never overwrite a finished booking
  await pool.query(
    "UPDATE bookings SET status = 'FAILED', updated_at = now() WHERE id = $1 AND status = 'PENDING'",
    [job.booking_id]
  );
  await releaseHolds(job);
  count('metrics:bookings_failed');
  log(job, 'booking_failed', { booking_id: job.booking_id, reason });
}

async function processBooking(job) {
  log(job, 'job_received', { booking_id: job.booking_id, seats: job.seats });

  // 0. A job can be delivered twice (for example after a worker crash).
  //    If the booking is already finished, do nothing.
  const current = await pool.query('SELECT status FROM bookings WHERE id = $1', [job.booking_id]);
  if (current.rows.length === 0 || current.rows[0].status !== 'PENDING') {
    log(job, 'job_skipped', { booking_id: job.booking_id, reason: 'booking is not pending' });
    return;
  }

  // 1. payment, with retries and exponential backoff
  const { retries, retryBaseMs } = config();
  try {
    await withRetry(simulatePayment, {
      retries,
      baseMs: retryBaseMs,
      onRetry: (attempt, delayMs, err) => {
        count('metrics:payment_retries');
        log(job, 'payment_retry', { attempt, delay_ms: Math.round(delayMs), error: err.message });
      },
    });
  } catch (err) {
    return markFailed(job, 'Payment failed after retries: ' + err.message);
  }

  // 2. save the result in ONE transaction: either everything is saved or nothing
  let confirmed = false;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const seatRows = await client.query(
      'SELECT id FROM seats WHERE show_id = $1 AND seat_label = ANY($2)',
      [job.show_id, job.seats.split(',')]
    );

    for (const row of seatRows.rows) {
      // UNIQUE (show_id, seat_id) makes this fail if the seat is already booked
      await client.query(
        'INSERT INTO booking_seats (booking_id, show_id, seat_id) VALUES ($1, $2, $3)',
        [job.booking_id, job.show_id, row.id]
      );
    }

    await client.query("UPDATE bookings SET status = 'CONFIRMED', updated_at = now() WHERE id = $1", [
      job.booking_id,
    ]);
    await client.query('COMMIT');
    confirmed = true;
  } catch (err) {
    await client.query('ROLLBACK');
    // error code 23505 = unique violation = someone else already owns the seat
    await markFailed(job, err.code === '23505' ? 'Seat already booked' : err.message);
  } finally {
    client.release();
  }

  if (confirmed) {
    count('metrics:bookings_confirmed');
    log(job, 'db_committed', { booking_id: job.booking_id, status: 'CONFIRMED' });
  }
}

module.exports = { processBooking };
