type Bucket = {
  timestamps: number[];
  windowMs: number;
  lastSeen: number;
};

const store = new Map<string, Bucket>();
const MAX_BUCKETS = 10_000;

let lastCleanup = Date.now();

function pruneBucket(bucket: Bucket, now: number, windowMs: number): void {
  bucket.windowMs = windowMs;
  bucket.lastSeen = now;
  bucket.timestamps = bucket.timestamps.filter((t) => now - t < windowMs);
}

function cleanup(now: number, force = false) {
  if (!force && now - lastCleanup < 60_000) return;
  lastCleanup = now;
  for (const [key, bucket] of store) {
    bucket.timestamps = bucket.timestamps.filter((t) => now - t < bucket.windowMs);
    if (bucket.timestamps.length === 0) store.delete(key);
  }
}

function evictOldestBucket() {
  let oldestKey: string | null = null;
  let oldestSeen = Infinity;
  for (const [key, bucket] of store) {
    if (bucket.lastSeen < oldestSeen) {
      oldestSeen = bucket.lastSeen;
      oldestKey = key;
    }
  }
  if (oldestKey) store.delete(oldestKey);
}

/**
 * 进程内滑动窗口限流。返回 true 表示允许，false 表示已超限。
 */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  cleanup(now);
  let bucket = store.get(key);
  if (!bucket) {
    if (store.size >= MAX_BUCKETS) {
      cleanup(now, true);
      if (store.size >= MAX_BUCKETS) evictOldestBucket();
    }
    bucket = { timestamps: [], windowMs, lastSeen: now };
    store.set(key, bucket);
  }
  pruneBucket(bucket, now, windowMs);
  if (bucket.timestamps.length >= limit) return false;
  bucket.timestamps.push(now);
  return true;
}

/**
 * 只读检查滑动窗口是否已经耗尽，不新增时间戳。
 */
export function isRateLimited(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now();
  cleanup(now);
  const bucket = store.get(key);
  if (!bucket) return false;

  pruneBucket(bucket, now, windowMs);
  if (bucket.timestamps.length === 0) {
    store.delete(key);
    return false;
  }
  return bucket.timestamps.length >= limit;
}

/** 距离窗口内最早一次请求过期还需等待的秒数 */
export function retryAfterSeconds(key: string, windowMs: number): number {
  const now = Date.now();
  const bucket = store.get(key);
  if (!bucket || bucket.timestamps.length === 0) return 0;
  pruneBucket(bucket, now, windowMs);
  if (bucket.timestamps.length === 0) {
    store.delete(key);
    return 0;
  }
  const oldest = Math.min(...bucket.timestamps);
  return Math.max(0, Math.ceil((oldest + windowMs - now) / 1000));
}

export function __resetRateLimitForTests(): void {
  store.clear();
  lastCleanup = Date.now();
}

export function __rateLimitStoreSizeForTests(): number {
  return store.size;
}
