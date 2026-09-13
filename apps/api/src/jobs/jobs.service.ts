import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PLACEHOLDER_QUEUE } from './jobs.module';

@Injectable()
export class JobsService {
  constructor(@InjectQueue(PLACEHOLDER_QUEUE) private readonly queue: Queue) {}

  /** Enqueue a no-op placeholder job to prove the pipeline works. */
  async enqueuePlaceholder(data: Record<string, unknown> = {}) {
    return this.queue.add('placeholder-job', data);
  }
}
