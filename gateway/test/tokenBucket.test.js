// Simple test for the token bucket. Run with: npm test
const assert = require('assert');
const { takeToken } = require('../src/tokenBucket');

const capacity = 5;
const refill = 1; // 1 token per second
const start = 1000000;

// 1. A fresh bucket allows a burst of 5 requests
for (let i = 0; i < 5; i++) {
  assert.strictEqual(takeToken('userA', capacity, refill, start).allowed, true);
}

// 2. The 6th request in the same instant is rejected
const rejected = takeToken('userA', capacity, refill, start);
assert.strictEqual(rejected.allowed, false);
assert.ok(rejected.retryAfter >= 1);

// 3. After 2 seconds, 2 tokens are back: 2 allowed, then rejected again
assert.strictEqual(takeToken('userA', capacity, refill, start + 2000).allowed, true);
assert.strictEqual(takeToken('userA', capacity, refill, start + 2000).allowed, true);
assert.strictEqual(takeToken('userA', capacity, refill, start + 2000).allowed, false);

// 4. Another user has their own bucket and is not affected
assert.strictEqual(takeToken('userB', capacity, refill, start).allowed, true);

// 5. The bucket never holds more than capacity, even after a long wait
for (let i = 0; i < 5; i++) {
  assert.strictEqual(takeToken('userA', capacity, refill, start + 999999999).allowed, true);
}
assert.strictEqual(takeToken('userA', capacity, refill, start + 999999999).allowed, false);

console.log('All token bucket tests passed');
