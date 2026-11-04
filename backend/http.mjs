import { ApiError } from './errors.mjs';

export async function readJson(req, maxBytes = 16_384) {
  if (!(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) throw new ApiError(415, 'JSON_REQUIRED', 'Use Content-Type: application/json.');
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new ApiError(413, 'BODY_TOO_LARGE', 'The request body exceeds 16 KiB.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApiError(400, 'INVALID_JSON', 'The request body is not valid JSON.'); }
}

export function sendJson(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(JSON.stringify(body));
}

export function pageNumber(value, fallback, max) {
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || Number(value) > max) throw new ApiError(400, 'INVALID_PAGINATION', 'Invalid pagination value.');
  return Number(value);
}

export function createRateLimiter() {
  const buckets = new Map();
  let lastSweep = 0;
  return (key, limit, windowMs = 60_000) => {
    const now = Date.now();
    if (now - lastSweep > 60_000) {
      for (const [id, bucket] of buckets) if (bucket.reset <= now) buckets.delete(id);
      lastSweep = now;
    }
    let bucket = buckets.get(key);
    if (!bucket || bucket.reset <= now) { bucket = { count: 0, reset: now + windowMs }; buckets.set(key, bucket); }
    if (++bucket.count > limit) throw new ApiError(429, 'RATE_LIMITED', 'Too many requests. Try again after one minute.');
  };
}
