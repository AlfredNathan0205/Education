import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { SessionGuard } from '../student/session.guard';
import { BlueprintController } from './blueprint.controller';
import { BlueprintService } from './blueprint.service';

@Module({
  imports: [AuthzModule, IdentityModule, OutboxModule],
  controllers: [BlueprintController],
  providers: [BlueprintService, SessionGuard],
  exports: [BlueprintService],
})
export class BlueprintModule {}
