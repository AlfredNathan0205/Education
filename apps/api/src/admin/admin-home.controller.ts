import { Controller, Get, Module, Req, UseGuards } from '@nestjs/common';
import { AuthzModule } from '../authz/authz.module';
import { AuthzService } from '../authz/authz.service';
import { IdentityModule } from '../identity/identity.module';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';

/** Step 22: what the admin home shows: the account's roles (read from the database, never from the request). */
@Controller('admin')
@UseGuards(SessionGuard)
export class AdminHomeController {
  constructor(private readonly authz: AuthzService) {}

  @Get('me')
  async me(@Req() req: AuthenticatedRequest): Promise<{ roles: string[] }> {
    return { roles: await this.authz.curriculumRolesFor(req.accountId as string) };
  }
}

@Module({ imports: [AuthzModule, IdentityModule], controllers: [AdminHomeController], providers: [SessionGuard] })
export class AdminHomeModule {}
