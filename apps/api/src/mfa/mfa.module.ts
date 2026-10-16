import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { IdentityModule } from '../identity/identity.module';
import { SessionGuard } from '../student/session.guard';
import { MfaController } from './mfa.controller';
import { MfaGuard } from './mfa.guard';
import { MfaService } from './mfa.service';

@Module({
  imports: [IdentityModule],
  controllers: [MfaController],
  providers: [MfaService, SessionGuard, { provide: APP_GUARD, useClass: MfaGuard }],
  exports: [MfaService],
})
export class MfaModule {}
