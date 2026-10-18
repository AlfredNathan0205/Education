import { redisConnection } from './redis-connection';

describe('redisConnection', () => {
  it('locally: host and port, defaults as before', () => {
    expect(redisConnection({})).toEqual({ host: 'localhost', port: 6379, family: 0 });
    expect(redisConnection({ REDIS_HOST: 'redis', REDIS_PORT: '6380', REDIS_PASSWORD: 'pw' })).toEqual({ host: 'redis', port: 6380, password: 'pw', family: 0 });
  });

  it('a URL wins: user, password (decoded), IPv6 host, TLS for rediss', () => {
    expect(redisConnection({ REDIS_URL: 'redis://default:p%40ss@redis.railway.internal:6379', REDIS_HOST: 'ignored' })).toEqual({
      host: 'redis.railway.internal', port: 6379, username: 'default', password: 'p@ss', family: 0,
    });
    expect(redisConnection({ REDIS_URL: 'rediss://[fd12::1]:6380' })).toEqual({ host: 'fd12::1', port: 6380, family: 0, tls: {} });
  });

  it('refuses a URL that is not Redis', () => {
    expect(() => redisConnection({ REDIS_URL: 'not a url' })).toThrow(/valid URL/);
    expect(() => redisConnection({ REDIS_URL: 'http://x:1' })).toThrow(/redis:\/\//);
  });
});
