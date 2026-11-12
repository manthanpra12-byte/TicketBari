// Catalog service: movies, shows and seat maps. Read-heavy, so it uses a cache.
//
// Cache-aside pattern:
//   1. look in Redis. Found = cache HIT, return it.
//   2. Not found = cache MISS: read PostgreSQL, store the result in Redis
//      with a TTL (time to live), then return it.

const express = require('express');
const pool = require('./db');
const redis = require('./redis');

const PORT = process.env.PORT || 3001;
const MOVIES_TTL = 60; // seconds. Movies rarely change.
const SHOWS_TTL = 60;
const SEATS_TTL = 5; // seat bookings change quickly, so keep this short
const CACHE_ENABLED = process.env.CACHE_ENABLED !== 'false'; // set to false to measure "no cache"
const LOG_REQUESTS = process.env.LOG_REQUESTS !== 'false'; // set to false during load tests

const app = express();

function log(req, msg, extra) {
  console.log(
    JSON.stringify({ svc: 'catalog', request_id: req.headers['x-request-id'], msg, ...extra })
  );
}

// Express 4 does not catch errors from async routes, so we wrap them
const wrap = (fn) => (req, res) =>
  fn(req, res).catch((err) => {
    log(req, 'error', { error: err.message });
    res.status(500).json({ error: 'Internal error' });
  });

// Generic cache-aside helper
async function cached(req, res, key, ttl, loadFromDb) {
  // cache switched off (only for the load test comparison): always read PostgreSQL
  if (!CACHE_ENABLED) {
    res.set('x-cache', 'OFF');
    return loadFromDb();
  }

  const hit = await redis.get(key);
  if (hit) {
    if (LOG_REQUESTS) log(req, 'cache_hit', { key });
    redis.incr('metrics:cache_hits').catch(() => {});
    res.set('x-cache', 'HIT');
    return JSON.parse(hit);
  }

  if (LOG_REQUESTS) log(req, 'cache_miss', { key });
  redis.incr('metrics:cache_misses').catch(() => {});
  res.set('x-cache', 'MISS');
  const data = await loadFromDb();
  await redis.set(key, JSON.stringify(data), 'EX', ttl);
  return data;
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

app.get(
  '/api/movies',
  wrap(async (req, res) => {
    const movies = await cached(req, res, 'cache:movies', MOVIES_TTL, async () => {
      const r = await pool.query('SELECT id, title, duration_min, language FROM movies ORDER BY id');
      return r.rows;
    });
    res.json(movies);
  })
);

app.get(
  '/api/movies/:id/shows',
  wrap(async (req, res) => {
    const movieId = Number(req.params.id);
    const shows = await cached(req, res, `cache:shows:${movieId}`, SHOWS_TTL, async () => {
      const r = await pool.query(
        'SELECT id, movie_id, screen, start_time, price FROM shows WHERE movie_id = $1 ORDER BY start_time',
        [movieId]
      );
      return r.rows;
    });
    res.json(shows);
  })
);

app.get(
  '/api/shows/:id/seats',
  wrap(async (req, res) => {
    const showId = Number(req.params.id);

    // Part A (cached 5s): every seat of the show and whether it is already booked in the database
    const seats = await cached(req, res, `cache:seats:${showId}`, SEATS_TTL, async () => {
      const r = await pool.query(
        `SELECT s.seat_label AS seat, (bs.seat_id IS NOT NULL) AS booked
           FROM seats s
           LEFT JOIN booking_seats bs ON bs.seat_id = s.id
          WHERE s.show_id = $1
          ORDER BY s.id`,
        [showId]
      );
      return r.rows;
    });

    if (seats.length === 0) {
      return res.status(404).json({ error: 'Show not found' });
    }

    // Part B (always fresh): seat holds live in Redis as keys like hold:1:A1
    const holders = await redis.mget(seats.map((s) => `hold:${showId}:${s.seat}`));

    res.json(
      seats.map((s, i) => ({
        seat: s.seat,
        status: s.booked ? 'BOOKED' : holders[i] ? 'HELD' : 'AVAILABLE',
      }))
    );
  })
);

app.listen(PORT, () => {
  console.log(JSON.stringify({ svc: 'catalog', msg: 'started', port: PORT }));
});
