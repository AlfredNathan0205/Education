/**
 * The Redis connection for the job queue, from the environment. Locally (and in CI) REDIS_HOST and REDIS_PORT.
 * On a host that gives a URL (Railway gives REDIS_URL, with a password), the URL wins.
 *
 * family: 0 lets ioredis use IPv4 or IPv6. Railway's private network can be IPv6 only, and ioredis's default of
 * IPv4 cannot reach it.
 */
export interface RedisConnection {
  host: string;
  port: number;
  username?: string;
  password?: string;
  family: 0;
  tls?: Record<string, never>;
}

type Env = Record<string, string | undefined>;

export function redisConnection(env: Env = process.env): RedisConnection {
  const url = (env.REDIS_URL ?? '').trim();
  if (url) {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new Error('REDIS_URL is not a valid URL (expected redis://user:password@host:port)');
    }
    if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') throw new Error('REDIS_URL must start with redis:// or rediss://');
    return {
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port ? parseInt(u.port, 10) : 6379,
      ...(u.username ? { username: decodeURIComponent(u.username) } : {}),
      ...(u.password ? { password: decodeURIComponent(u.password) } : {}),
      family: 0,
      ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    };
  }
  const password = (env.REDIS_PASSWORD ?? '').trim();
  return {
    host: env.REDIS_HOST ?? 'localhost',
    port: parseInt(env.REDIS_PORT ?? '6379', 10),
    ...(password ? { password } : {}),
    family: 0,
  };
}
