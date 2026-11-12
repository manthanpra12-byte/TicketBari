// Test for retry with exponential backoff. Run with: npm test
const assert = require('assert');
const { withRetry } = require('../src/retry');

async function main() {
  // 1. Works on the first try: no waiting
  {
    const delays = [];
    const result = await withRetry(async () => 'ok', { sleep: async (ms) => delays.push(ms) });
    assert.strictEqual(result, 'ok');
    assert.strictEqual(delays.length, 0);
  }

  // 2. Fails twice, then works: waits about 200 ms, then about 400 ms
  {
    const delays = [];
    let calls = 0;
    const result = await withRetry(
      async () => {
        calls += 1;
        if (calls < 3) throw new Error('boom');
        return 'recovered';
      },
      { retries: 3, baseMs: 200, sleep: async (ms) => delays.push(ms) }
    );
    assert.strictEqual(result, 'recovered');
    assert.strictEqual(calls, 3);
    assert.strictEqual(delays.length, 2);
    assert.ok(delays[0] >= 200 && delays[0] < 300, 'first wait about 200 ms');
    assert.ok(delays[1] >= 400 && delays[1] < 500, 'second wait about 400 ms');
  }

  // 3. Always fails: tries 1 + 3 retries = 4 times, waits grow 200, 400, 800, then throws
  {
    const delays = [];
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls += 1;
          throw new Error('always');
        },
        { retries: 3, baseMs: 200, sleep: async (ms) => delays.push(ms) }
      ),
      /always/
    );
    assert.strictEqual(calls, 4);
    assert.strictEqual(delays.length, 3);
    assert.ok(delays[2] >= 800 && delays[2] < 900, 'third wait about 800 ms');
  }

  // 4. onRetry is called with the attempt number
  {
    const attempts = [];
    let calls = 0;
    await withRetry(
      async () => {
        calls += 1;
        if (calls < 2) throw new Error('x');
      },
      { sleep: async () => {}, onRetry: (attempt) => attempts.push(attempt) }
    );
    assert.deepStrictEqual(attempts, [1]);
  }

  console.log('All retry tests passed');
}

main();
