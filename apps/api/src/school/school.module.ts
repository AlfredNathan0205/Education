import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { StudentModule } from '../student/student.module';
import { SchoolRegistryService } from './school-registry.service';
import { StudentSchoolController } from './student-school.controller';
import { StudentSchoolService } from './student-school.service';

@Module({
  imports: [IdentityModule, OutboxModule, StudentModule],
  controllers: [StudentSchoolController],
  providers: [SchoolRegistryService, StudentSchoolService, SessionGuard],
  exports: [SchoolRegistryService],
})
export class SchoolModule {}
