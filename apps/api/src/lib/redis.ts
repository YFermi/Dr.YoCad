import { Redis } from 'ioredis';
import { MemoryRedis } from './memoryRedis.js';
import { STANDALONE } from './standalone.js';

function createRedis(): Redis {
  const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';

  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: 3,
    enableReadyCheck: true,
    lazyConnect: true,
    retryStrategy: (times) => Math.min(times * 50, 2000),
  });

  client.on('error', (err) => {
    console.error('[redis] connection error:', err.message);
  });

  return client;
}

// STANDALONE: in-memory stand-in, no Redis server (see lib/memoryRedis.ts).
export const redis: Redis = STANDALONE
  ? (new MemoryRedis() as unknown as Redis)
  : createRedis();

export async function connectRedis(): Promise<void> {
  if (redis.status === 'wait') {
    await redis.connect();
  }
}
