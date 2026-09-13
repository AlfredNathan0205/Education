import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PlaceholderProcessor } from './placeholder.processor';
import { JobsService } from './jobs.service';

export const PLACEHOLDER_QUEUE = 'placeholder';

@Module({
  imports: [
    BullModule.registerQueue({
      name: PLACEHOLDER_QUEUE,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
        removeOnFail: false, // keeps failed jobs for dead-letter inspection
      },
    }),
  ],
  providers: [PlaceholderProcessor, JobsService],
  exports: [JobsService],
})
export class JobsModule {}
