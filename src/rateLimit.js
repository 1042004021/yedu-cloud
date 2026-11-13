'use strict';

/**
 * 极简内存限流：单实例够用；多实例部署时应换成 Redis 等共享存储。
 */
function createRateLimiter({ windowMs = 60_000, max = 120 } = {}) {
  const buckets = new Map();
  let lastSweep = Date.now();

  return function rateLimit(req, res, next) {
    const now = Date.now();
    const identity = req.deviceId || req.ip || 'unknown';
    const key = `${req.method}:${req.path}:${identity}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    if (now - lastSweep > windowMs) {
      lastSweep = now;
      for (const [bucketKey, value] of buckets) {
        if (value.resetAt <= now) buckets.delete(bucketKey);
      }
    }

    if (bucket.count > max) {
      res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
    }
    next();
  };
}

module.exports = { createRateLimiter };
