/**
 * lib/rate-limit.js — In-memory per-IP rate limiting middleware.
 *
 * Local requests (127.0.0.1, ::1) bypass rate limits entirely.
 */

const { isLocalRequest } = require("./tunnel");

const rateLimitBuckets = new Map(); // ip -> { count, resetAt }

function rateLimit(windowMs, maxHits) {
  return (req, res, next) => {
    // Local requests get a much higher limit
    if (isLocalRequest(req)) return next();

    // Use Cloudflare's real client IP when behind tunnel, fall back to socket IP
    const ip = req.get("cf-connecting-ip") || req.ip || req.connection?.remoteAddress || "unknown";
    const now = Date.now();
    let bucket = rateLimitBuckets.get(ip);

    if (!bucket || now > bucket.resetAt) {
      bucket = { count: 0, resetAt: now + windowMs };
      rateLimitBuckets.set(ip, bucket);
    }

    bucket.count++;
    if (bucket.count > maxHits) {
      return res.status(429).json({ error: "Too many requests. Try again later." });
    }
    next();
  };
}

// Prune stale buckets every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [ip, bucket] of rateLimitBuckets) {
    if (now > bucket.resetAt) rateLimitBuckets.delete(ip);
  }
}, 300000);

module.exports = { rateLimit };
