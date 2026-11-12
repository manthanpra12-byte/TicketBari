// Token Bucket rate limiter (in memory).
//
// Idea: every client (IP address) owns a bucket that holds tokens.
//  - Each request costs 1 token.
//  - Tokens are added back over time (refillPerSec tokens every second).
//  - The bucket can never hold more than "capacity" tokens.
//  - Empty bucket = request is rejected (HTTP 429).
// A full bucket allows a short burst, then the refill rate limits the long-run speed.

const buckets = new Map(); // key (client IP) -> { tokens, last }

function takeToken(key, capacity, refillPerSec, now = Date.now()) {
  // 1. get this client's bucket, or start with a full one
  let bucket = buckets.get(key);
  if (!bucket) {
    bucket = { tokens: capacity, last: now };
  }

  // 2. add the tokens earned since the last request (but never above capacity)
  const secondsPassed = (now - bucket.last) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + secondsPassed * refillPerSec);
  bucket.last = now;

  // 3. spend one token if we have it
  let allowed = false;
  if (bucket.tokens >= 1) {
    bucket.tokens -= 1;
    allowed = true;
  }

  buckets.set(key, bucket);

  // if rejected, tell the client how many seconds until 1 token is back
  const retryAfter = allowed ? 0 : Math.max(1, Math.ceil((1 - bucket.tokens) / refillPerSec));
  return { allowed, retryAfter };
}

module.exports = { takeToken };
