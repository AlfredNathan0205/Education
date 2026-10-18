import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { AdminCurriculumController } from './admin-curriculum.controller';
import { CurriculumAdminService } from './curriculum-admin.service';
import { CurriculumService } from './curriculum.service';
import { CurriculumWorkflowService } from './curriculum-workflow.service';
import { ContentImportService } from './import/content-import.service';

@Module({
  imports: [OutboxModule, AuthzModule, IdentityModule],
  controllers: [AdminCurriculumController],
  providers: [CurriculumService, CurriculumAdminService, ContentImportService, CurriculumWorkflowService, SessionGuard],
  exports: [CurriculumService, CurriculumAdminService],
})
export class CurriculumModule {}
