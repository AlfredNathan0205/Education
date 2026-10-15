import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { EntitlementModule } from '../entitlement/entitlement.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { EXAM_CONFIG, loadExamConfig } from './exam-domain';
import { ExamController } from './exam.controller';
import { ExamService } from './exam.service';
import { ExamSweeper } from './sweeper';
import { ItemInvalidationController } from './item-invalidation.controller';
import { ItemInvalidationService } from './item-invalidation.service';

@Module({
  imports: [AuthzModule, IdentityModule, PrivacyModule, OutboxModule, EntitlementModule],
  controllers: [ExamController, ItemInvalidationController],
  providers: [
    ExamService,
    ExamSweeper,
    ItemInvalidationService,
    SessionGuard,
    // EXAM_ALLOW_UNACTIVATED_CURRICULUM=true is a development switch and fails at startup in production.
    { provide: EXAM_CONFIG, useFactory: () => loadExamConfig() },
  ],
  exports: [ExamService],
})
export class ExamModule {}
