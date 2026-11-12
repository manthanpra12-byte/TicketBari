// Redis connection used to read jobs from the stream and release seat holds
const Redis = require('ioredis');

const client = new Redis(process.env.REDIS_URL);
client.on('error', (err) => {
  console.log(JSON.stringify({ svc: 'worker', msg: 'redis_error', error: err.message }));
});

module.exports = client;
