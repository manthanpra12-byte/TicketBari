-- Token bucket that runs INSIDE Redis.
-- Redis runs a Lua script as one single step, so two gateway requests can never
-- read and update the same bucket at the same time (no race condition).
--
-- KEYS[1] = bucket key (one per client IP)
-- ARGV[1] = capacity (max tokens)
-- ARGV[2] = refill rate (tokens per second)
-- ARGV[3] = current time in milliseconds
-- Returns: { allowed (1 or 0), retry_after_seconds }

local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

local data = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])

-- first request from this client: start with a full bucket
if tokens == nil then
  tokens = capacity
  ts = now
end

-- add the tokens earned since the last request, never above capacity
local seconds = math.max(0, now - ts) / 1000
tokens = math.min(capacity, tokens + seconds * refill)

local allowed = 0
local retry = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
else
  retry = math.max(1, math.ceil((1 - tokens) / refill))
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', ARGV[3])
redis.call('EXPIRE', KEYS[1], 60) -- forget idle clients

return { allowed, retry }
