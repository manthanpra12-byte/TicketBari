# TicketBari: 10-Minute Demo Script

Practise this twice on the laptop you will present with. Open two terminals (PowerShell) in the `TicketBari` folder
and one browser tab. Run `docker compose down -v` before you start so the data is clean.

## Before you go on stage

- Docker Desktop running, `.env` deleted (defaults), nothing else using ports 8080, 5432, 6379.
- Pre-pull images: run `docker compose up --build` once, then `docker compose down`.
- Have this README open for copying commands.

## Timeline

| Min | What to show | Say |
|---|---|---|
| 0:00 | Architecture diagram | Gateway is the only entry. Catalog reads, booking writes, workers finish bookings later. Redis does cache, seat holds, rate limits and the queue. PostgreSQL is the source of truth. |
| 1:30 | `docker compose up --build`, then `Invoke-RestMethod http://localhost:8080/health` | One command starts 8 containers. Health reports every node. |
| 2:30 | Book seats: hold, book, poll (README "Quick tour") | The booking returns 202 at once with status PENDING. A worker finishes it and the status becomes CONFIRMED. |
| 3:30 | Same-seat test (10 users, 1 seat) | Exactly one wins. Redis NX hold first, PostgreSQL UNIQUE constraint as the last guard. |
| 4:30 | Trace one request (README section 5) | One request id across gateway, booking, worker and database. |
| 5:30 | Run the k6 spike (limiter ON, run 1), then `/metrics` | Most requests are answered with 429 by the gateway, so the backend stays healthy. |
| 7:00 | Cache: show `x-cache` MISS then HIT, show `cache_hit_ratio` in `/metrics` | Reads come from Redis, PostgreSQL is not touched. |
| 8:00 | `docker compose stop booking`, send the 10 requests | Five 502, then the breaker opens and answers 503 instantly. Movies still return 200. |
| 9:00 | `docker compose start booking`, wait 10 s, one request | The breaker lets one test request through and closes. |
| 9:30 | Summary slide: results table from the report | Throughput, p95 latency, cache effect, zero double bookings. |

## Who explains what (3 people)

- Person A: architecture, gateway, rate limiter, circuit breaker, docker-compose
- Person B: database schema, catalog cache, seat holds, double-booking prevention
- Person C: queue, workers, retries, crash recovery, load test and report

## If something fails live

- Services will not start: `docker compose down -v`, then `docker compose up --build`.
- Port already in use: close the other program, or change the left number of the port in `docker-compose.yml`.
- Keep a screen recording of a good run as a backup.
- If a command gives 429 on stage, wait 2 seconds (the bucket refills).

## Questions to prepare for

- Why token bucket and not leaky bucket? It allows controlled bursts.
- Why Lua in Redis? The read and update happen as one atomic step.
- Why 202 instead of waiting? The user is not blocked, and workers can scale.
- What if a worker crashes? The job is not ACKed, another worker reclaims it after 30 seconds.
- What if the same job runs twice? The worker checks the booking is still PENDING first.
- Retry or circuit breaker? Retry for short glitches, breaker for a service that is down.
- Why a shared database? Simplicity. A strict design would give each service its own.
- What happens if Redis goes down? The rate limiter lets requests through; holds and cache stop working, so booking and catalog report DOWN.
