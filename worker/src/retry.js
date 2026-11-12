// Retry with exponential backoff.
//
// If a call fails, wait a little and try again. Each wait is twice as long as the last:
//   retry 1 after about 200 ms, retry 2 after about 400 ms, retry 3 after about 800 ms.
// A small random "jitter" is added so many workers do not all retry at the same moment.
// After the last retry the error is thrown so the caller can give up.

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(fn, options = {}) {
  const retries = options.retries ?? 3;
  const baseMs = options.baseMs ?? 200;
  const sleep = options.sleep || defaultSleep; // replaceable, makes testing fast
  const onRetry = options.onRetry || (() => {});

  let attempt = 0;
  while (true) {
    try {
      return await fn();
    } catch (err) {
      if (attempt >= retries) throw err; // out of retries: give up

      const delayMs = baseMs * 2 ** attempt + Math.random() * 100; // 200, 400, 800 (+ jitter)
      attempt += 1;
      onRetry(attempt, delayMs, err);
      await sleep(delayMs);
    }
  }
}

module.exports = { withRetry };
