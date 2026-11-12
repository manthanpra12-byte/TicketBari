// Redis connection used for the cache and for reading seat holds
const Redis = require('ioredis');

const client = new Redis(process.env.REDIS_URL);
client.on('error', (err) => {
  console.log(JSON.stringify({ svc: 'catalog', msg: 'redis_error', error: err.message }));
});

module.exports = client;
