# TicketBari: Database Design

PostgreSQL 16 is the source of truth. Redis holds temporary data (cache, seat holds, queue, counters).
Schema and sample data live in `db/migrations/`. The `migrate` container applies them once at startup.

## Tables (PostgreSQL)

```
movies 1 ----< shows 1 ----< seats
                  |             |
                  |             |
                  v             v
              bookings 1 ----< booking_seats >---- seats
```

| Table | Purpose | Key columns |
|---|---|---|
| `movies` | Movies that can be shown | id, title, duration_min, language |
| `shows` | One screening of a movie | id, movie_id, screen, start_time, price |
| `seats` | Every seat of a show | id, show_id, seat_label. UNIQUE (show_id, seat_label) |
| `bookings` | One row per booking attempt (our transaction log) | id (UUID), user_id, show_id, status, request_id, created_at, updated_at |
| `booking_seats` | Seats owned by a confirmed booking | booking_id, show_id, seat_id. UNIQUE (show_id, seat_id) |
| `schema_migrations` | Which migration files were applied | name, applied_at |

Booking status lifecycle: `PENDING` (saved by the booking service) then `CONFIRMED` or `FAILED` (set by a worker).

## Why the constraints matter

`UNIQUE (show_id, seat_id)` on `booking_seats` is the final protection against double booking.
Even if two workers confirm two different bookings for the same seat at the same moment,
PostgreSQL accepts the first insert and rejects the second (error code 23505).
The worker rolls back its transaction, marks that booking `FAILED` and releases the seat hold.

## Redis keys

| Key | Value | TTL | Used by |
|---|---|---|---|
| `cache:movies` | JSON list of movies | 60s | catalog (cache-aside) |
| `cache:shows:<movieId>` | JSON list of shows | 60s | catalog |
| `cache:seats:<showId>` | JSON seats + booked flag | 5s | catalog |
| `hold:<showId>:<seat>` | user id | 300s | booking (SET NX EX), catalog (read) |
| `bookings` (stream) | booking jobs | none | booking (XADD), workers (XREADGROUP, group `workers`) |
| `ratelimit:<ip>` | token bucket (tokens, ts) | 60s | gateway (Lua script) |
| `metrics:*` | counters (cache_hits, cache_misses, rate_limited, bookings_confirmed, bookings_failed) | none | all services |

## Migration approach

Plain `.sql` files named `001_...`, `002_...`. `db/migrate.js` applies each file once, in order, inside a
transaction, and records it in `schema_migrations`. Running it again skips files already applied.
To add a change later, add a new file (for example `003_add_index.sql`). Never edit an applied file.
