export type AiRateLimitBucket = 'chat' | 'analysis';

interface BucketConfig {
  maxRequests: number;
  windowMs: number;
}

const BUCKET_CONFIGS: Record<AiRateLimitBucket, BucketConfig> = {
  // /ai/chat: 30 requests per 5 minutes per user
  chat: {
    maxRequests: 30,
    windowMs: 5 * 60 * 1000,
  },
  // /ai/summary, /ai/bom, /ai/dfm: 5 requests per 10 minutes per user
  analysis: {
    maxRequests: 5,
    windowMs: 10 * 60 * 1000,
  },
};

export interface AiRateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
  remaining: number;
}

const userWindows = new Map<string, number[]>();

/**
 * Sliding-window per-user rate limiter for AI endpoints.
 * Keys are scoped by `${bucket}:${userId}`.
 */
export function checkAiRateLimit(
  userId: string,
  bucket: AiRateLimitBucket,
  nowMs = Date.now()
): AiRateLimitResult {
  const cfg = BUCKET_CONFIGS[bucket];
  const key = `${bucket}:${userId}`;
  const cutoff = nowMs - cfg.windowMs;

  const existing = userWindows.get(key) ?? [];
  const active = existing.filter((ts) => ts > cutoff);

  if (active.length >= cfg.maxRequests) {
    const oldestTs = active[0] ?? nowMs;
    const retryAfterMs = Math.max(1000, oldestTs + cfg.windowMs - nowMs);
    userWindows.set(key, active);
    return {
      allowed: false,
      retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
      remaining: 0,
    };
  }

  active.push(nowMs);
  userWindows.set(key, active);
  return {
    allowed: true,
    retryAfterSeconds: 0,
    remaining: Math.max(0, cfg.maxRequests - active.length),
  };
}
