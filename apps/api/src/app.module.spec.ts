import { Test } from '@nestjs/testing';
import { AppModule } from './app.module';

describe('AppModule', () => {
  it('should compile the module', async () => {
    // This test verifies the module graph resolves without errors.
    // It requires DATABASE_URL and Redis to be available;
    // in CI these are provided by service containers.
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    expect(module).toBeDefined();
    await module.close();
  });
});
