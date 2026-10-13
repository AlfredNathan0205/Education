import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { CurriculumModule } from '../curriculum/curriculum.module';
import { IdentityModule } from '../identity/identity.module';
import { SessionGuard } from '../student/session.guard';
import { QuestionBankService } from './question-bank.service';
import { QuestionController } from './question.controller';
import { QuestionService } from './question.service';

@Module({
  imports: [AuthzModule, IdentityModule, CurriculumModule],
  controllers: [QuestionController],
  providers: [QuestionService, QuestionBankService, SessionGuard],
  exports: [QuestionService],
})
export class QuestionModule {}
