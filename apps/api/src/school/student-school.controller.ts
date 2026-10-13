import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  NotFoundException,
  Post,
  Put,
  Req,
  UnprocessableEntityException,
  UseGuards,
} from '@nestjs/common';
import { SessionGuard, type AuthenticatedRequest } from '../student/session.guard';
import { GuardianConsentRequiredError, StudentNotFoundError } from '../student/student.service';
import { NotInLaunchCohortError, SchoolNotFoundError } from './school.errors';
import { InvalidSchoolInputError } from './school-domain';
import { StudentSchoolService, type AcademicView, type SchoolChoice, type SchoolSearchHit } from './student-school.service';

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

function str(v: unknown, field: string): string {
  if (typeof v !== 'string') throw new BadRequestException(`${field} must be a string`);
  return v;
}

/** Exactly one of: a registry school (+ optional branch) or free-text school name. */
export function parseSchoolChoice(raw: unknown): SchoolChoice {
  const b = body(raw);
  const hasId = b.schoolId !== undefined;
  const hasName = b.schoolName !== undefined;
  if (hasId === hasName) throw new BadRequestException('Send either schoolId or schoolName');
  if (hasId) {
    const choice: { schoolId: string; branchId?: string } = { schoolId: str(b.schoolId, 'schoolId') };
    if (b.branchId !== undefined) choice.branchId = str(b.branchId, 'branchId');
    return choice;
  }
  return { schoolName: str(b.schoolName, 'schoolName') };
}

@Controller('students/me')
@UseGuards(SessionGuard)
export class StudentSchoolController {
  constructor(private readonly schools: StudentSchoolService) {}

  @Get('academic')
  academic(@Req() req: AuthenticatedRequest): Promise<AcademicView> {
    return this.map(() => this.schools.getAcademic(req.accountId as string));
  }

  @Put('grade')
  grade(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<AcademicView> {
    const b = body(raw);
    const curriculumCode = str(b.curriculumCode, 'curriculumCode');
    const gradeCode = str(b.gradeCode, 'gradeCode');
    return this.map(() => this.schools.setGrade(req.accountId as string, curriculumCode, gradeCode));
  }

  @Post('schools/search')
  @HttpCode(200)
  search(@Body() raw: unknown): Promise<SchoolSearchHit[]> {
    return this.map(() => this.schools.search(body(raw).query));
  }

  @Put('school')
  school(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<AcademicView> {
    const choice = parseSchoolChoice(raw);
    return this.map(() => this.schools.selectSchool(req.accountId as string, choice));
  }

  @Post('school/leave')
  @HttpCode(200)
  leave(@Req() req: AuthenticatedRequest): Promise<AcademicView> {
    return this.map(() => this.schools.leaveSchool(req.accountId as string));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudentNotFoundError || e instanceof SchoolNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof InvalidSchoolInputError) throw new BadRequestException(e.message);
      if (e instanceof GuardianConsentRequiredError) throw new ForbiddenException(e.message);
      if (e instanceof NotInLaunchCohortError) throw new UnprocessableEntityException(e.message);
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException('Please try again');
      throw e;
    }
  }
}
