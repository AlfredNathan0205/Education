import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule);
  // Curriculum uploads are text files of up to ~2 MB; Nest's default JSON limit is 100 KB.
  app.useBodyParser('json', { limit: '3mb' });
  const port = process.env.API_PORT ?? 3001;
  await app.listen(port);
  console.log(`API listening on port ${port}`);
}

bootstrap();
