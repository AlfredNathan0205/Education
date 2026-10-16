import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { ReadinessController } from './readiness.controller';
import { ReadinessService } from './readiness.service';
import { ReleaseService } from './release.service';

@Module({
  imports: [AuthzModule, IdentityModule, OutboxModule],
  controllers: [ReadinessController],
  providers: [ReleaseService, ReadinessService, SessionGuard],
  exports: [ReleaseService, ReadinessService],
})
export class ReleaseModule {}
