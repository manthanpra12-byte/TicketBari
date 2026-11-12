// k6 load test for TicketBari. Simulates a traffic spike on the gateway.
//
// Two kinds of virtual users (VUs) run at the same time:
//   browse   : many users reading movies and seat maps (shows the cache working)
//   booking  : a smaller group holding and booking seats (shows queue + workers)
//
// Run (from the TicketBari folder):
//   docker compose --profile loadtest run --rm k6
// Options (add -e NAME=value after "run --rm"):
//   SCENARIO   browse | booking | both   (default both)
//   PEAK_VUS   most users at the same time during the spike (default 200)
//   THINK_TIME seconds each user waits between actions (default 0.1)
//   BASE_URL   where the gateway is (default http://gateway:8080)

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';

const BASE = __ENV.BASE_URL || 'http://gateway:8080';
const SCENARIO = __ENV.SCENARIO || 'both';
const PEAK_VUS = Number(__ENV.PEAK_VUS || 200);
const THINK_TIME = Number(__ENV.THINK_TIME || 0.1);

// 200, 202, 409 (seat taken) and 429 (rate limited) are normal answers here.
// Only 5xx errors and connection problems count as failures.
http.setResponseCallback(http.expectedStatuses(200, 202, 409, 429));

const rateLimited = new Counter('rate_limited_responses');
const holdsOk = new Counter('holds_ok');
const holdConflicts = new Counter('hold_conflicts');
const bookingsAccepted = new Counter('bookings_accepted');

const scenarios = {};

if (SCENARIO === 'browse' || SCENARIO === 'both') {
  scenarios.browse = {
    executor: 'ramping-vus',
    exec: 'browse',
    startVUs: 0,
    stages: [
      { duration: '10s', target: Math.round(PEAK_VUS / 4) }, // warm up
      { duration: '5s', target: PEAK_VUS },                  // the spike
      { duration: '20s', target: PEAK_VUS },                 // hold the peak
      { duration: '5s', target: 0 },                         // cool down
    ],
  };
}

if (SCENARIO === 'booking' || SCENARIO === 'both') {
  scenarios.booking = {
    executor: 'shared-iterations',
    exec: 'booking',
    vus: 20,
    iterations: 60,          // 60 booking attempts in total
    maxDuration: '40s',
    startTime: SCENARIO === 'both' ? '10s' : '0s', // start when the browse spike builds up
  };
}

export const options = {
  scenarios,
  thresholds: {
    http_req_failed: ['rate<0.01'],     // under 1% real errors
    http_req_duration: ['p(95)<800'],   // 95% of requests faster than 800 ms
  },
};

function track(res) {
  if (res.status === 429) rateLimited.add(1);
  check(res, { 'status is 200 or 429': (r) => r.status === 200 || r.status === 429 });
}

export function browse() {
  track(http.get(`${BASE}/api/movies`, { tags: { name: 'GET /api/movies' } }));

  const show = 1 + Math.floor(Math.random() * 6);
  track(http.get(`${BASE}/api/shows/${show}/seats`, { tags: { name: 'GET /api/shows/:id/seats' } }));

  sleep(THINK_TIME);
}

export function booking() {
  const show = 1 + Math.floor(Math.random() * 6);
  const seat = ['A', 'B', 'C'][Math.floor(Math.random() * 3)] + (1 + Math.floor(Math.random() * 8));
  const user = `load-${__VU}-${__ITER}`;

  const body = JSON.stringify({ show_id: show, user_id: user, seats: [seat] });
  const params = { headers: { 'Content-Type': 'application/json' } };

  const hold = http.post(`${BASE}/api/holds`, body, { ...params, tags: { name: 'POST /api/holds' } });
  if (hold.status === 429) rateLimited.add(1);

  if (hold.status === 200) {
    holdsOk.add(1);
    const book = http.post(`${BASE}/api/bookings`, body, { ...params, tags: { name: 'POST /api/bookings' } });
    if (book.status === 429) rateLimited.add(1);
    if (book.status === 202) bookingsAccepted.add(1);
    check(book, { 'booking accepted (202) or limited (429)': (r) => r.status === 202 || r.status === 429 });
  } else if (hold.status === 409) {
    holdConflicts.add(1); // someone else already has that seat: correct behaviour
  }

  sleep(0.2);
}
