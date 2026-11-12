// Worker: takes booking jobs from the Redis Stream and processes them one by one.
//
// Several workers run at the same time (3 containers). They all belong to ONE
// "consumer group" called "workers", so Redis gives each job to exactly one of
// them. That is how the work is shared.
//
// Crash safety: a job is only removed from the "pending" list when we XACK it.
// If a worker dies in the middle of a job, nobody ACKs it. After RECLAIM_IDLE_MS
// another worker takes it over with XAUTOCLAIM, so no job is lost.

const os = require('os');
const redis = require('./redis');
const { processBooking } = require('./processBooking');

const STREAM = 'bookings';
const GROUP = 'workers';
const CONSUMER = os.hostname(); // unique per container
const RECLAIM_IDLE_MS = Number(process.env.RECLAIM_IDLE_MS) || 30000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Redis returns a message as a flat list: [key1, value1, key2, value2, ...]
function toObject(fields) {
  const obj = {};
  for (let i = 0; i < fields.length; i += 2) {
    obj[fields[i]] = fields[i + 1];
  }
  return obj;
}

async function handleMessages(messages) {
  for (const [messageId, fields] of messages) {
    if (!fields) continue; // message no longer exists
    await processBooking(toObject(fields));
    // XACK tells Redis "this job is done"
    await redis.xack(STREAM, GROUP, messageId);
  }
}

// Take over jobs that another worker started but never finished
async function reclaimStuckJobs() {
  const [, messages] = await redis.xautoclaim(STREAM, GROUP, CONSUMER, RECLAIM_IDLE_MS, '0-0', 'COUNT', 5);
  if (messages.length > 0) {
    console.log(
      JSON.stringify({ svc: 'worker', worker: CONSUMER, msg: 'reclaimed_jobs', count: messages.length })
    );
    await handleMessages(messages);
  }
}

async function start() {
  // create the consumer group (the error means "already exists", which is fine)
  try {
    await redis.xgroup('CREATE', STREAM, GROUP, '0', 'MKSTREAM');
  } catch (err) {
    if (!String(err.message).includes('BUSYGROUP')) throw err;
  }

  console.log(JSON.stringify({ svc: 'worker', worker: CONSUMER, msg: 'started' }));

  while (true) {
    try {
      await reclaimStuckJobs();

      // wait up to 5 seconds for a new job. COUNT 1 = take one job at a time,
      // so jobs are spread evenly across the workers.
      const result = await redis.xreadgroup(
        'GROUP', GROUP, CONSUMER,
        'COUNT', 1,
        'BLOCK', 5000,
        'STREAMS', STREAM, '>'
      );
      if (!result) continue; // nothing arrived, wait again

      for (const [, messages] of result) {
        await handleMessages(messages);
      }
    } catch (err) {
      console.log(JSON.stringify({ svc: 'worker', worker: CONSUMER, msg: 'loop_error', error: err.message }));
      await sleep(1000);
    }
  }
}

start().catch((err) => {
  console.error('worker crashed:', err);
  process.exit(1);
});
