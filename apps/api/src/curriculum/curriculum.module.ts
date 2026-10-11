import { Module } from '@nestjs/common';
import { OutboxModule } from '../outbox/outbox.module';
import { CurriculumService } from './curriculum.service';

@Module({
  imports: [OutboxModule],
  providers: [CurriculumService],
  exports: [CurriculumService],
})
export class CurriculumModule {}
