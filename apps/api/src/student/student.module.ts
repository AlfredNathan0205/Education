import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from './session.guard';
import { StudentController } from './student.controller';
import { StudentService } from './student.service';

@Module({
  imports: [IdentityModule, PrivacyModule, OutboxModule],
  controllers: [StudentController],
  providers: [StudentService, SessionGuard],
  exports: [StudentService],
})
export class StudentModule {}
