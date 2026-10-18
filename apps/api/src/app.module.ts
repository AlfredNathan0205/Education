import { redisConnection } from './infra/redis-connection';
import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { HealthController } from './health/health.controller';
import { DatabaseModule } from './database/database.module';
import { OutboxModule } from './outbox/outbox.module';
import { JobsModule } from './jobs/jobs.module';
import { IdentityModule } from './identity/identity.module';
import { PrivacyModule } from './privacy/privacy.module';
import { AuthzModule } from './authz/authz.module';
import { StudentModule } from './student/student.module';
import { CurriculumModule } from './curriculum/curriculum.module';
import { QuestionModule } from './question/question.module';
import { PublicationModule } from './publication/publication.module';
import { BlueprintModule } from './blueprint/blueprint.module';
import { ExamModule } from './exam/exam.module';
import { HomeModule } from './home/home.module';
import { MasteryModule } from './mastery/mastery.module';
import { RecommendationModule } from './recommendation/recommendation.module';
import { CompetitionModule } from './competition/competition.module';
import { SocialModule } from './social/social.module';
import { ParentModule } from './parent/parent.module';
import { EntitlementModule } from './entitlement/entitlement.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { RightsModule } from './rights/rights.module';
import { MfaModule } from './mfa/mfa.module';
import { ReleaseModule } from './release/release.module';
import { FactoryModule } from './factory/factory.module';
import { AdminHomeModule } from './admin/admin-home.controller';
import { GuardianModule } from './guardian/guardian.module';
import { SchoolModule } from './school/school.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.forRoot({ connection: redisConnection() }),
    DatabaseModule,
    OutboxModule,
    JobsModule,
    IdentityModule,
    PrivacyModule,
    CurriculumModule,
    QuestionModule,
    PublicationModule,
    BlueprintModule,
    ExamModule,
    HomeModule,
    MasteryModule,
    RecommendationModule,
    CompetitionModule,
    SocialModule,
    ParentModule,
    EntitlementModule,
    AnalyticsModule,
    RightsModule,
    MfaModule,
    ReleaseModule,
    FactoryModule,
    AdminHomeModule,
    GuardianModule,
    StudentModule,
    SchoolModule,
    AuthzModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
