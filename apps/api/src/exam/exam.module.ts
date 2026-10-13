import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { EXAM_CONFIG, loadExamConfig } from './exam-domain';
import { ExamController } from './exam.controller';
import { ExamService } from './exam.service';

@Module({
  imports: [IdentityModule, PrivacyModule, OutboxModule],
  controllers: [ExamController],
  providers: [
    ExamService,
    SessionGuard,
    // EXAM_ALLOW_UNACTIVATED_CURRICULUM=true is a development switch and fails at startup in production.
    { provide: EXAM_CONFIG, useFactory: () => loadExamConfig() },
  ],
})
export class ExamModule {}
