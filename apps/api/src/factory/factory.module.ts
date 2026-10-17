import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { CoverageService } from '../bank-coverage/coverage.service';
import { IdentityModule } from '../identity/identity.module';
import { QuestionModule } from '../question/question.module';
import { SessionGuard } from '../student/session.guard';
import { AdminFactoryController } from './admin-factory.controller';
import { AdminFactoryService } from './admin-factory.service';

@Module({
  imports: [AuthzModule, IdentityModule, QuestionModule],
  controllers: [AdminFactoryController],
  providers: [AdminFactoryService, CoverageService, SessionGuard],
})
export class FactoryModule {}
