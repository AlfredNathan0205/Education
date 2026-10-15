import { Module } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { IdentityModule } from '../identity/identity.module';
import { OutboxModule } from '../outbox/outbox.module';
import { PrivacyModule } from '../privacy/privacy.module';
import { SessionGuard } from '../student/session.guard';
import { AdminEntitlementController, EntitlementController } from './entitlement.controller';
import { EntitlementService } from './entitlement.service';
import { EntitlementSweeper } from './sweeper';

@Module({
  imports: [AuthzModule, IdentityModule, PrivacyModule, OutboxModule],
  controllers: [EntitlementController, AdminEntitlementController],
  providers: [EntitlementService, EntitlementSweeper, SessionGuard],
  exports: [EntitlementService],
})
export class EntitlementModule {}
