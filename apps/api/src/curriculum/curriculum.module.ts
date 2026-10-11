import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { OutboxModule } from '../outbox/outbox.module';
import { CurriculumAdminService } from './curriculum-admin.service';
import { CurriculumService } from './curriculum.service';

@Module({
  imports: [OutboxModule, AuthzModule],
  providers: [CurriculumService, CurriculumAdminService],
  exports: [CurriculumService, CurriculumAdminService],
})
export class CurriculumModule {}
