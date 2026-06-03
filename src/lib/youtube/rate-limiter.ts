import { createLogger } from "@/lib/utils/logger";

const log = createLogger("rate-limiter");

/** Token bucket sencillo por API para respetar límites por 100s. */
class TokenBucket {
  private tokens: number;
  private lastRefill = Date.now();
  constructor(
    private capacity: number,
    private refillPerSec: number
  ) {
    this.tokens = capacity;
  }
  private refill() {
    const now = Date.now();
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsed * this.refillPerSec);
    this.lastRefill = now;
  }
  async take(): Promise<void> {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return;
    }
    const waitMs = ((1 - this.tokens) / this.refillPerSec) * 1000;
    await sleep(waitMs);
    return this.take();
  }
}

const buckets: Record<string, TokenBucket> = {
  data: new TokenBucket(50, 5),
  analytics: new TokenBucket(20, 2),
  reporting: new TokenBucket(20, 2),
};

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function throttle(api: keyof typeof buckets): Promise<void> {
  await buckets[api]?.take();
}

export interface BackoffOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (status: number) => boolean;
}

/**
 * Backoff exponencial con jitter para errores transitorios (429/5xx).
 * No reintenta errores 4xx no recuperables (salvo 429).
 */
export async function withBackoff<T>(
  label: string,
  fn: () => Promise<T>,
  opts: BackoffOptions = {}
): Promise<T> {
  const {
    maxRetries = 5,
    baseDelayMs = 800,
    maxDelayMs = 60_000,
    retryOn = (s) => s === 429 || s === 500 || s === 503 || s === 403,
  } = opts;

  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const status = (err as { status?: number }).status ?? 0;
      const retryable = retryOn(status);
      if (!retryable || attempt >= maxRetries) throw err;
      const retryAfter = (err as { retryAfterMs?: number }).retryAfterMs;
      const expo = Math.min(maxDelayMs, baseDelayMs * 2 ** attempt);
      const jitter = Math.random() * expo * 0.3;
      const delay = retryAfter ?? expo + jitter;
      attempt++;
      log.warn(
        `${label}: status ${status}, reintento ${attempt}/${maxRetries} en ${Math.round(delay)}ms`
      );
      await sleep(delay);
    }
  }
}
