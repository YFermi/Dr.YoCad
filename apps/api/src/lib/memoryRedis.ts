/**
 * STANDALONE stand-in for the ioredis client: an in-process key/value map with
 * TTLs, covering the commands the API uses (set ... EX, get, del, ping).
 * Socket.IO fan-out never used Redis (lib/realtimeHub.ts is in-memory), so
 * nothing else changes. Data is lost on restart, like an unpersisted Redis.
 */
export class MemoryRedis {
  status = 'ready';
  private readonly store = new Map<string, { value: string; expiresAt: number | null }>();

  async connect(): Promise<void> {}

  async ping(): Promise<'PONG'> {
    return 'PONG';
  }

  async set(key: string, value: string, mode?: string, ttl?: number): Promise<'OK'> {
    const expiresAt =
      mode?.toUpperCase() === 'EX' && ttl ? Date.now() + ttl * 1000
      : mode?.toUpperCase() === 'PX' && ttl ? Date.now() + ttl
      : null;
    this.store.set(key, { value: String(value), expiresAt });
    return 'OK';
  }

  async get(key: string): Promise<string | null> {
    const entry = this.store.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && entry.expiresAt <= Date.now()) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(...keys: string[]): Promise<number> {
    return keys.reduce((n, key) => n + (this.store.delete(key) ? 1 : 0), 0);
  }

  on(): this {
    return this;
  }

  disconnect(): void {
    this.store.clear();
  }

  async quit(): Promise<'OK'> {
    this.store.clear();
    return 'OK';
  }
}
