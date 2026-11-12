// Redis connection for the gateway. If REDIS_URL is not set we export null
// and the rate limiter falls back to the in-memory version from Part 1.
const Redis = require('ioredis');

const url = process.env.REDIS_URL;
let client = null;

if (url) {
  client = new Redis(url, {
    commandTimeout: 2000, // never wait more than 2s for Redis
    maxRetriesPerRequest: 1,
  });
  client.on('error', (err) => {
    console.log(JSON.stringify({ svc: 'gateway', msg: 'redis_error', error: err.message }));
  });
}

module.exports = client;
