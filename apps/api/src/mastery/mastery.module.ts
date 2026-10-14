import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { ExamModule } from '../exam/exam.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { MasteryAdminController, MasteryController } from './mastery.controller';
import { MasteryService } from './mastery.service';
import { MasteryViewService } from './mastery-view.service';
import { MasterySweeper } from './sweeper';

@Module({
  imports: [AuthzModule, ExamModule, IdentityModule, OutboxModule],
  controllers: [MasteryController, MasteryAdminController],
  providers: [MasteryService, MasteryViewService, MasterySweeper, SessionGuard],
  exports: [MasteryService],
})
export class MasteryModule {}
