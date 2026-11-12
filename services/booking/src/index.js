// Booking service: seat holds and booking requests.
//
// Booking flow:
//   1. POST /api/holds    -> hold the seats in Redis for 5 minutes
//   2. POST /api/bookings -> save a PENDING booking, push a job to the queue,
//                            answer 202 Accepted right away (we do NOT wait for payment)
//   3. A worker does the slow part later (see /worker)
//   4. GET /api/bookings/:id -> client polls until the status is CONFIRMED or FAILED

const express = require('express');
const crypto = require('crypto');
const pool = require('./db');
const redis = require('./redis');

const PORT = process.env.PORT || 3002;
const HOLD_SECONDS = 300; // 5 minutes
const STREAM = 'bookings'; // Redis Stream used as the job queue

const app = express();
app.use(express.json());

function log(req, msg, extra) {
  console.log(
    JSON.stringify({ svc: 'booking', request_id: req.headers['x-request-id'], msg, ...extra })
  );
}

const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    log(req, 'error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  });

// A seat hold is a Redis key like  hold:1:A1  whose value is the user id
const holdKey = (showId, seat) => `hold:${showId}:${seat}`;

// Read and validate { show_id, user_id, seats[] } from the request body
function readInput(body) {
  const showId = Number(body.show_id);
  const userId = body.user_id;
  const seats = Array.isArray(body.seats) ? [...new Set(body.seats)] : [];

  const valid =
    Number.isInteger(showId) &&
    showId > 0 &&
    typeof userId === 'string' &&
    userId.length > 0 &&
    seats.length > 0 &&
    seats.length <= 6 &&
    seats.every((s) => typeof s === 'string' && /^[A-Za-z0-9]{1,5}$/.test(s));

  return valid ? { showId, userId, seats } : null;
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    await redis.ping();
    res.json({ status: 'UP', postgres: 'UP', redis: 'UP' });
  } catch (err) {
    res.status(503).json({ status: 'DOWN', error: err.message });
  }
});

// ---- Step 1: hold seats ----------------------------------------------------
app.post(
  '/api/holds',
  wrap(async (req, res) => {
    const input = readInput(req.body);
    if (!input) {
      return res.status(400).json({ error: 'show_id, user_id and seats (1 to 6) are required' });
    }
    const { showId, userId, seats } = input;

    // The seats must exist for this show
    const found = await pool.query(
      'SELECT seat_label FROM seats WHERE show_id = $1 AND seat_label = ANY($2)',
      [showId, seats]
    );
    if (found.rows.length !== seats.length) {
      return res.status(400).json({ error: 'Unknown show or seat' });
    }

    // The seats must not already be booked (the database is the source of truth)
    const booked = await pool.query(
      `SELECT s.seat_label
         FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
        WHERE s.show_id = $1 AND s.seat_label = ANY($2)`,
      [showId, seats]
    );
    if (booked.rows.length > 0) {
      return res
        .status(409)
        .json({ error: 'Seat already booked', seats: booked.rows.map((r) => r.seat_label) });
    }

    // Try to hold each seat. NX = "only set if the key does not exist yet",
    // so only ONE user can win a seat. EX = auto-delete after 5 minutes.
    const won = [];
    const lost = [];
    for (const seat of seats) {
      const ok = await redis.set(holdKey(showId, seat), userId, 'EX', HOLD_SECONDS, 'NX');
      if (ok === 'OK') won.push(seat);
      else lost.push(seat);
    }

    if (lost.length > 0) {
      // all or nothing: give back the seats we did get
      if (won.length > 0) await redis.del(...won.map((s) => holdKey(showId, s)));
      log(req, 'hold_conflict', { show_id: showId, seats: lost });
      return res.status(409).json({ error: 'Seat already held by someone else', seats: lost });
    }

    log(req, 'seats_held', { show_id: showId, user_id: userId, seats });
    res.json({ show_id: showId, user_id: userId, seats, expires_in_seconds: HOLD_SECONDS });
  })
);

// ---- Step 2: create a booking ----------------------------------------------
app.post(
  '/api/bookings',
  wrap(async (req, res) => {
    const input = readInput(req.body);
    if (!input) {
      return res.status(400).json({ error: 'show_id, user_id and seats (1 to 6) are required' });
    }
    const { showId, userId, seats } = input;
    const requestId = req.headers['x-request-id'] || '';

    // Every seat must still be held by THIS user (holds expire after 5 minutes)
    const holders = await redis.mget(seats.map((s) => holdKey(showId, s)));
    if (holders.some((h) => h !== userId)) {
      return res.status(409).json({ error: 'Hold missing or expired. Hold the seats again.' });
    }

    // Save the booking as PENDING
    const bookingId = crypto.randomUUID();
    await pool.query(
      'INSERT INTO bookings (id, user_id, show_id, status, request_id) VALUES ($1, $2, $3, $4, $5)',
      [bookingId, userId, showId, 'PENDING', requestId]
    );

    // Push a job to the queue (XADD adds a message to the stream)
    try {
      await redis.xadd(
        STREAM, '*',
        'booking_id', bookingId,
        'show_id', String(showId),
        'user_id', userId,
        'seats', seats.join(','),
        'request_id', requestId
      );
    } catch (err) {
      await pool.query("UPDATE bookings SET status = 'FAILED', updated_at = now() WHERE id = $1", [bookingId]);
      throw err;
    }

    redis.incr('metrics:bookings_enqueued').catch(() => {});
    log(req, 'job_enqueued', { booking_id: bookingId });

    // 202 Accepted = "we got it, the work will finish later"
    res.status(202).json({ booking_id: bookingId, status: 'PENDING' });
  })
);

// ---- Step 4: check the status ----------------------------------------------
app.get(
  '/api/bookings/:id',
  wrap(async (req, res) => {
    const id = req.params.id;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const b = await pool.query(
      'SELECT id, user_id, show_id, status, created_at, updated_at FROM bookings WHERE id = $1',
      [id]
    );
    if (b.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const seats = await pool.query(
      `SELECT s.seat_label FROM booking_seats bs JOIN seats s ON s.id = bs.seat_id
        WHERE bs.booking_id = $1 ORDER BY s.id`,
      [id]
    );

    const row = b.rows[0];
    res.json({
      booking_id: row.id,
      status: row.status,
      show_id: row.show_id,
      user_id: row.user_id,
      seats: seats.rows.map((r) => r.seat_label),
      created_at: row.created_at,
      updated_at: row.updated_at,
    });
  })
);

app.listen(PORT, () => {
  console.log(JSON.stringify({ svc: 'booking', msg: 'started', port: PORT }));
});
