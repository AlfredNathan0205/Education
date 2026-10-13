import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { StudentModule } from '../student/student.module';
import { EXAM_CONFIG, loadExamConfig } from '../exam/exam-domain';
import { ChapterCatalogueService } from './chapter-catalogue.service';
import { SchoolPlanService } from './school-plan.service';
import { StudentChaptersService } from './student-chapters.service';
import { SchoolRegistryService } from './school-registry.service';
import { StudentSchoolController } from './student-school.controller';
import { StudentSchoolService } from './student-school.service';

@Module({
  imports: [IdentityModule, OutboxModule, StudentModule],
  controllers: [StudentSchoolController],
  providers: [
    SchoolRegistryService,
    StudentSchoolService,
    StudentChaptersService,
    SchoolPlanService,
    ChapterCatalogueService,
    SessionGuard,
    { provide: EXAM_CONFIG, useFactory: () => loadExamConfig() },
  ],
  exports: [SchoolRegistryService],
})
export class SchoolModule {}
