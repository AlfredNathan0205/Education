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
import { GuardianModule } from './guardian/guardian.module';
import { SchoolModule } from './school/school.module';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST ?? 'localhost',
        port: parseInt(process.env.REDIS_PORT ?? '6379', 10),
      },
    }),
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
    GuardianModule,
    StudentModule,
    SchoolModule,
    AuthzModule,
  ],
  controllers: [HealthController],
})
export class AppModule {}
