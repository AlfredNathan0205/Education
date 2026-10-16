import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { rateLimiter, securityHeaders } from './security/http-security';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Step 20: no framework banner, security headers on every response, and rate limits before any route runs.
  app.disable('x-powered-by');
  app.use(securityHeaders());
  app.use(rateLimiter());
  // Curriculum uploads are text files of up to ~2 MB; Nest's default JSON limit is 100 KB.
  app.useBodyParser('json', { limit: '3mb' });
  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  console.log(`API listening on port ${port}`);
}

bootstrap();
