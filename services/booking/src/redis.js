// Redis connection used for seat holds and the job queue
const Redis = require('ioredis');

const client = new Redis(process.env.REDIS_URL);
client.on('error', (err) => {
  console.log(JSON.stringify({ svc: 'booking', msg: 'redis_error', error: err.message }));
});

module.exports = client;
