// Test for the circuit breaker. Run with: npm test
const assert = require('assert');
const CircuitBreaker = require('../src/circuitBreaker');

let time = 0; // fake clock so the test does not need to wait
const changes = [];
const breaker = new CircuitBreaker('booking', {
  failureThreshold: 3,
  resetTimeoutMs: 1000,
  now: () => time,
  onChange: (name, from, to) => changes.push(from + '->' + to),
});

// 1. Starts CLOSED and lets requests through
assert.strictEqual(breaker.state, 'CLOSED');
assert.strictEqual(breaker.canRequest(), true);

// 2. Failures in a row open it; then requests are rejected
breaker.recordFailure();
breaker.recordFailure();
assert.strictEqual(breaker.state, 'CLOSED'); // 2 failures is not enough
breaker.recordFailure();
assert.strictEqual(breaker.state, 'OPEN');
assert.strictEqual(breaker.canRequest(), false);
assert.ok(breaker.retryAfterSeconds() >= 1);

// 3. After the timeout, ONE test request is allowed (HALF_OPEN), others are not
time += 1000;
assert.strictEqual(breaker.canRequest(), true);
assert.strictEqual(breaker.state, 'HALF_OPEN');
assert.strictEqual(breaker.canRequest(), false);

// 4. The test request fails: back to OPEN
breaker.recordFailure();
assert.strictEqual(breaker.state, 'OPEN');
assert.strictEqual(breaker.canRequest(), false);

// 5. Wait again, the test request succeeds: CLOSED
time += 1000;
assert.strictEqual(breaker.canRequest(), true);
breaker.recordSuccess();
assert.strictEqual(breaker.state, 'CLOSED');
assert.strictEqual(breaker.canRequest(), true);

// 6. A success resets the count (it counts failures IN A ROW)
breaker.recordFailure();
breaker.recordFailure();
breaker.recordSuccess();
breaker.recordFailure();
breaker.recordFailure();
assert.strictEqual(breaker.state, 'CLOSED');

// 7. The state changes were reported
assert.deepStrictEqual(changes, [
  'CLOSED->OPEN',
  'OPEN->HALF_OPEN',
  'HALF_OPEN->OPEN',
  'OPEN->HALF_OPEN',
  'HALF_OPEN->CLOSED',
]);

console.log('All circuit breaker tests passed');
