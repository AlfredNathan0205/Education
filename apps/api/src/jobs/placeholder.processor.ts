import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { PLACEHOLDER_QUEUE } from './jobs.module';

@Processor(PLACEHOLDER_QUEUE)
export class PlaceholderProcessor extends WorkerHost {
  private readonly logger = new Logger(PlaceholderProcessor.name);

  async process(job: Job): Promise<void> {
    this.logger.log(`Processing placeholder job ${job.id}`);
    // No-op — proves the BullMQ pipeline is wired correctly.
  }
}
