# TicketBari: Load Test Report

Team: [names] | Date: [date]

Fill the [brackets] with numbers from your own runs (`loadtest/results/*.json` and `/metrics`).
Delete these grey instructions in the final version. Target length: 2 to 3 pages.

## 1. Setup

- Machine: [CPU, RAM], Docker Desktop with [x] GB memory
- System: gateway, catalog, booking, 3 workers, PostgreSQL 16, Redis 7 (Docker Compose)
- Tool: k6, spike to [200] virtual users, think time [0.1]s
- Test duration: about 40 seconds per run
- Rate limiter: token bucket per IP, capacity [20], refill [10]/s (run 1); relaxed to [100000] for runs 2 to 4

## 2. Scenarios

| Run | What | Limiter | Cache |
|---|---|---|---|
| 1 | Browse + booking spike | ON (20 burst, 10/s) | ON |
| 2 | Browse spike | relaxed | ON |
| 3 | Browse spike | relaxed | OFF |
| 4 | Booking attempts | relaxed | ON |
| 5 | Booking service stopped during load | ON | ON |

## 3. Results

| Run | Requests | Throughput (req/s) | Median latency | p95 latency | 429 responses | Errors (5xx) |
|---|---|---|---|---|---|---|
| 1 | [ ] | [ ] | [ ] ms | [ ] ms | [ ] ([ ] %) | [ ] |
| 2 | [ ] | [ ] | [ ] ms | [ ] ms | [ ] | [ ] |
| 3 | [ ] | [ ] | [ ] ms | [ ] ms | [ ] | [ ] |
| 4 | [ ] | [ ] | [ ] ms | [ ] ms | [ ] | [ ] |

Where to read them: throughput = `http_reqs.rate`, latency = `http_req_duration` (`med`, `p(95)`), 429 = `rate_limited_responses.count`.

## 4. How the rate limiter protected the system

- Run 1: [x] % of requests were answered with 429 straight from the gateway.
- Compare the catalog and PostgreSQL load in run 1 versus run 2: only [x] requests reached the catalog in run 1.
- The system stayed healthy: [0] server errors, `/health` stayed `OK`.

## 5. How the cache helped

| | Cache ON (run 2) | Cache OFF (run 3) |
|---|---|---|
| Throughput (req/s) | [ ] | [ ] |
| Median latency | [ ] ms | [ ] ms |
| p95 latency | [ ] ms | [ ] ms |
| Cache hit ratio (`/metrics`) | [ ] | n/a |

Conclusion: [one or two sentences, for example "the cache cut p95 latency by x percent because most reads never reached PostgreSQL"].

## 6. Queue and workers (run 4)

- Bookings accepted (202): [ ] | enqueued: [ ] | confirmed: [ ] | failed: [ ]
- Payment retries: [ ] (`payment_retries` in `/metrics`)
- Hold conflicts (409): [ ] (users competing for the same seat)
- Booking requests returned in about [ ] ms because the slow work happens in the workers, not in the request.

## 7. Correctness

- Double bookings after the tests: [0] (query in the README)
- Same-seat test (10 users, 1 seat): [1] winner, [9] refused

## 8. Resilience (run 5)

- Booking service stopped: [x] requests got 502, then the breaker opened and the next requests got 503 immediately.
- Browsing (`/api/movies`) stayed at 200 the whole time.
- After restarting booking, the breaker closed again after [10] seconds.

## 9. Observations and limits

- Bottleneck: [for example, the single gateway process or Docker Desktop CPU limit]
- All k6 users share one IP, so the per-IP limiter treats them as one client.
- Both services share one database (a simplification).
- Possible next steps: more gateway instances behind a load balancer, read replicas, per-user rate limits.
