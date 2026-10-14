import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { EXAM_CONFIG, loadExamConfig } from '../exam/exam-domain';
import { IdentityModule } from '../identity/identity.module';
import { QuestionModule } from '../question/question.module';
import { SessionGuard } from '../student/session.guard';
import { PublicationController } from './publication.controller';
import { PublicationService } from './publication.service';

@Module({
  imports: [AuthzModule, IdentityModule, QuestionModule],
  controllers: [PublicationController],
  providers: [PublicationService, SessionGuard, { provide: EXAM_CONFIG, useFactory: () => loadExamConfig() }],
  exports: [PublicationService],
})
export class PublicationModule {}
