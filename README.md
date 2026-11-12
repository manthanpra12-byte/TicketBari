# TicketBari

Movie ticket booking backend for our M.Tech System Design project.
Node.js + Express, PostgreSQL, Redis, Docker Compose.

## Architecture

```
Client / k6 --> API Gateway :8080 --> catalog  --> Redis (cache, holds) / PostgreSQL
 (rate limiter, circuit breaker,  --> booking  --> Redis (holds, queue) / PostgreSQL
  health, metrics)                                       |
                                                 Redis Stream "bookings"
                                                         |
                                                 worker x3 --> PostgreSQL (CONFIRMED / FAILED)
```

| Folder | What it is |
|---|---|
| `gateway/` | Request id + logging, Redis token bucket rate limiter (Lua), routing, circuit breaker, `/health`, `/metrics` |
| `services/catalog/` | Movies, shows, seat map. Redis cache-aside, PostgreSQL |
| `services/booking/` | Seat holds (Redis), PENDING booking, pushes a job to the queue |
| `worker/` | Takes jobs from the queue, fake payment with retries, updates the booking in PostgreSQL |
| `db/` | SQL migrations, seed data, migration runner |
| `loadtest/` | k6 spike test and its results |
| `scripts/` | Same-seat test (10 users, 1 seat) |
| `docs/` | Database design, demo script, load test report template |

## Requirements

- Docker Desktop (running) and Git
- Node.js 20 only if you want to run the unit tests outside Docker

## Run

```
docker compose up --build
```

First run downloads images and takes a few minutes. Stop with `Ctrl+C`, then `docker compose down`.
Fresh database: `docker compose down -v`, then `docker compose up --build`.

Settings (rate limit, cache on/off, payment failure rate, quiet logs) live in a `.env` file.
Copy `.env.example` to `.env`, edit, then apply with `docker compose up -d gateway catalog worker`.

## Quick tour (PowerShell)

```
Invoke-RestMethod http://localhost:8080/health
Invoke-RestMethod http://localhost:8080/metrics
(Invoke-WebRequest http://localhost:8080/api/movies -UseBasicParsing).Headers["x-cache"]   # MISS, run again: HIT
Invoke-RestMethod http://localhost:8080/api/shows/1/seats | Format-Table
```

Book seats (hold, book, poll). Pick seats that are still AVAILABLE in the seat map: holding or booking seats that are already booked returns 409.

```
$body = @{ show_id = 1; user_id = "manthan"; seats = @("A1","A2") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/holds -ContentType "application/json" -Body $body
$booking = Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/bookings -ContentType "application/json" -Body $body
Start-Sleep 5
Invoke-RestMethod http://localhost:8080/api/bookings/$($booking.booking_id)
```

## Part 3 features and how to see each one

### 1. Rate limiter (429)

```
1..40 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " http://localhost:8080/api/movies }
```

### 2. Circuit breaker

The gateway keeps one breaker per service. 5 failures in a row open it for 10 seconds.
While open, the gateway answers `503` at once instead of waiting for a dead service.

```
docker compose stop booking
1..10 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " http://localhost:8080/api/bookings/00000000-0000-0000-0000-000000000000 }
```

Expected: five `502` (service unreachable), then `503` (breaker open). Browsing still works:

```
curl.exe -s -o NUL -w "%{http_code}" http://localhost:8080/api/movies      # 200
Invoke-RestMethod http://localhost:8080/health                              # circuits: booking = OPEN
```

Recover: `docker compose start booking`, wait 10 seconds, call the same URL once.
The breaker lets one test request through (`HALF_OPEN`), it gets `404` (booking service is alive), and the breaker closes.

### 3. Retry with exponential backoff

Each fake payment attempt fails 30% of the time. The worker retries up to 3 times, waiting about 200, 400, 800 ms.

```
docker compose logs worker | findstr payment_retry
```

### 4. Crash recovery

A worker acknowledges (XACK) a job only when it is finished. If it dies mid-job, another worker takes the job over after 30 seconds (XAUTOCLAIM).
A job delivered twice is skipped if the booking is already finished.

Optional demo: make a booking, run `docker compose kill worker` within 1 second, then `docker compose up -d worker`.
After about 30 seconds the log shows `reclaimed_jobs` and the booking finishes.

### 5. Trace one request through every layer

Every response carries an `x-request-id` header. The same id appears in the gateway, catalog, booking and worker logs.

```
$body = @{ show_id = 1; user_id = "tracer"; seats = @("C1") } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://localhost:8080/api/holds -ContentType "application/json" -Body $body | Out-Null
$r = Invoke-WebRequest -Method Post -Uri http://localhost:8080/api/bookings -ContentType "application/json" -Body $body -UseBasicParsing
$id = $r.Headers["x-request-id"]
Start-Sleep 6
docker compose logs --no-color gateway booking worker | findstr $id
```

You will see: `request_received`, `job_enqueued`, `job_received`, `payment_retry` (sometimes), `db_committed`, `request_completed`.

### 6. Metrics

```
Invoke-RestMethod http://localhost:8080/metrics
Invoke-RestMethod -Method Post http://localhost:8080/metrics/reset     # zero the counters before a test
```

Fields: `requests_total`, `rate_limited`, `cache_hits`, `cache_misses`, `cache_hit_ratio`, `bookings_enqueued`,
`bookings_confirmed`, `bookings_failed`, `payment_retries`, `queue_depth`, `circuits`.

### 7. Double booking checks

10 users at once, same seat (expect exactly one winner). Run it from the TicketBari folder, not from a subfolder. If you already ran it, reset with `docker compose down -v`:

```
docker run --rm -e BASE_URL=http://host.docker.internal:8080 -v "${PWD}/scripts:/s" node:20-alpine node /s/same-seat-test.js
```

After any test, the database must show no duplicate seats (expect 0 rows):

```
docker compose exec postgres psql -U ticketbari -d ticketbari -c "SELECT show_id, seat_id, count(*) FROM booking_seats GROUP BY 1,2 HAVING count(*) > 1;"
```

## Load test

The k6 script simulates a spike (browsing users ramp to 200 at once) plus booking attempts.
Run every command from the `TicketBari` folder (not from `gateway` or another subfolder).

**Important:** the settings below go in a file called `.env` in the `TicketBari` folder.
Typing `RATE_LIMIT_CAPACITY=100000` directly in PowerShell does nothing. Use the exact commands shown.
After changing `.env`, the output must say `Recreated` or `Started` for the services. If it says `Running`, the change was not applied.

### Run 1: rate limiter ON (defaults)

All k6 users share one IP, so the limiter treats them as one client and rejects most requests. This shows the limiter protecting the system.

```
Remove-Item .env -ErrorAction SilentlyContinue
docker compose up -d gateway catalog
Invoke-RestMethod -Method Post http://localhost:8080/metrics/reset
docker compose --profile loadtest run --rm k6 run -e SCENARIO=browse --summary-export=/scripts/results/1-limiter-on.json /scripts/k6-spike.js
Invoke-RestMethod http://localhost:8080/metrics
```

Check: the number of requests that got through is about `capacity + refill x seconds` = 20 + 10 x 40 = 420
(`cache_hits + cache_misses` in `/metrics`). Everything else is a 429.

### Run 2: limiter relaxed, cache ON

```
@"
RATE_LIMIT_CAPACITY=100000
RATE_LIMIT_REFILL=100000
LOG_REQUESTS=false
"@ | Set-Content .env -Encoding ascii
docker compose up -d gateway catalog
1..60 | ForEach-Object { curl.exe -s -o NUL -w "%{http_code} " http://localhost:8080/api/movies }
```

All 60 must be `200`. If you still see 429, the `.env` change was not applied.

```
Invoke-RestMethod -Method Post http://localhost:8080/metrics/reset
docker compose --profile loadtest run --rm k6 run -e SCENARIO=browse --summary-export=/scripts/results/2-cache-on.json /scripts/k6-spike.js
Invoke-RestMethod http://localhost:8080/metrics
```

### Run 3: limiter relaxed, cache OFF

```
@"
RATE_LIMIT_CAPACITY=100000
RATE_LIMIT_REFILL=100000
LOG_REQUESTS=false
CACHE_ENABLED=false
"@ | Set-Content .env -Encoding ascii
docker compose up -d catalog
(Invoke-WebRequest http://localhost:8080/api/movies -UseBasicParsing).Headers["x-cache"]
```

The last command must print `OFF`. Then:

```
Invoke-RestMethod -Method Post http://localhost:8080/metrics/reset
docker compose --profile loadtest run --rm k6 run -e SCENARIO=browse --summary-export=/scripts/results/3-cache-off.json /scripts/k6-spike.js
```

### Run 4: bookings under load (queue + workers + retries)

The seed data has only 144 seats, so start from a fresh database. The cache goes back on, the limiter stays relaxed.

```
@"
RATE_LIMIT_CAPACITY=100000
RATE_LIMIT_REFILL=100000
LOG_REQUESTS=false
"@ | Set-Content .env -Encoding ascii
docker compose down -v
docker compose up -d --build
Start-Sleep 15
Invoke-RestMethod -Method Post http://localhost:8080/metrics/reset
docker compose --profile loadtest run --rm k6 run -e SCENARIO=booking --summary-export=/scripts/results/4-booking.json /scripts/k6-spike.js
Start-Sleep 20
Invoke-RestMethod http://localhost:8080/metrics
```

Check: `bookings_enqueued` equals `bookings_confirmed + bookings_failed`, `queue_depth` is 0, `payment_retries` is above 0.
Then check there are no double bookings (the query is in the section above).

### Run 5 (optional): breaker under load

Run 2 again and run `docker compose stop booking` in a second terminal while it runs. Watch `/health` (`circuits`).

### Back to normal

```
Remove-Item .env
docker compose up -d gateway catalog
```

### Reading the results

Each `loadtest/results/*.json` has: `metrics.http_reqs.rate` (throughput), `metrics.http_req_duration` (`med`, `p(95)`),
`metrics.rate_limited_responses.count` (429s). The k6 numbers must match `/metrics`: `requests_total` equals `http_reqs.count`
and `rate_limited` equals `rate_limited_responses.count` (when you reset the metrics before the run).
Put the numbers into `docs/load-test-report-template.md`. Use `-e PEAK_VUS=100` if your laptop struggles.

## Unit tests

```
cd gateway
npm install
npm test        # token bucket, circuit breaker

cd ../worker
npm install
npm test        # retry with backoff, booking processing
```

## API contract

| Method | Endpoint | Handled by | Body |
|---|---|---|---|
| GET | `/api/movies` | catalog | |
| GET | `/api/movies/:id/shows` | catalog | |
| GET | `/api/shows/:id/seats` | catalog | |
| POST | `/api/holds` | booking | `{ show_id, user_id, seats: ["A1"] }` |
| POST | `/api/bookings` | booking (202) | `{ show_id, user_id, seats: ["A1"] }` |
| GET | `/api/bookings/:id` | booking | |
| GET | `/health` | gateway | |
| GET | `/metrics` | gateway | |
| POST | `/metrics/reset` | gateway | |

Errors: `400` bad input, `404` not found, `409` seat held or booked by someone else, `429` rate limited,
`502` service unreachable, `503` circuit breaker open.

## Design decisions (for the viva)

- **Token bucket** allows short bursts, then limits the long-run rate. It runs as a Lua script in Redis so the check and update are one atomic step.
- **202 Accepted**: the user is not blocked while payment runs. The worker finishes the job and the client polls.
- **Two layers against double booking**: a Redis hold (`SET NX`, fast path) and the PostgreSQL `UNIQUE (show_id, seat_id)` constraint (final guard).
- **Circuit breaker vs retry**: retry handles short glitches (a failed payment attempt). The breaker stops us hammering a service that is down.
- **Consumer group**: Redis gives each job to one worker. Un-ACKed jobs are reclaimed, so a crashed worker loses nothing.
- **Known simplification**: both services share one PostgreSQL database. A strict microservice design gives each service its own.
- **Known limit**: rate limiting is per IP, so all k6 users look like one client.

## Frontend (website)

A plain HTML/CSS/JavaScript site, no build step, served by nginx. It only talks to the gateway on port 8080.

```
docker compose up -d --build frontend
```

Open http://localhost:3000.

- **Book tickets:** pick a movie, a show and seats, then press Book. You see the steps: hold (Redis), 202 accepted, worker confirms.
  Open the site in two browser windows and change the name in the top right to compete for the same seat.
- **System status:** services UP/DOWN, circuit breaker state, live counters, and a button that sends 40 requests at once to show the rate limiter (429).

Demo idea: run `docker compose stop booking` and watch the status page turn the booking breaker OPEN, then `docker compose start booking`.
Note: if you edited `.env` for the load test, delete it first so the default limiter (capacity 20) is back.
#   T i c k e t B a r i  
 