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
import { InvalidDateOfBirthError } from '../privacy/age-classification';
import { MethodNotAcceptedError } from '../privacy/privacy.errors';
import { SessionGuard, type AuthenticatedRequest } from './session.guard';
import {
  GuardianConsentRequiredError,
  InvalidProfileInputError,
  StudentNotFoundError,
  StudentService,
  type StudentProfileView,
} from './student.service';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Strict calendar date: rejects 2013-02-30 rather than letting Date roll it over. */
export function parseIsoDate(value: unknown): Date {
  if (typeof value !== 'string') throw new BadRequestException('dateOfBirth must be YYYY-MM-DD');
  const m = ISO_DATE.exec(value);
  if (!m) throw new BadRequestException('dateOfBirth must be YYYY-MM-DD');
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    throw new BadRequestException('dateOfBirth is not a real date');
  }
  return date;
}

function body(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new BadRequestException('Request body must be a JSON object');
  }
  return raw as Record<string, unknown>;
}

@Controller('students/me')
@UseGuards(SessionGuard)
export class StudentController {
  constructor(private readonly students: StudentService) {}

  @Post()
  @HttpCode(200)
  create(@Req() req: AuthenticatedRequest): Promise<StudentProfileView> {
    return this.students.createOwnProfile(req.accountId as string);
  }

  @Get()
  async get(@Req() req: AuthenticatedRequest): Promise<StudentProfileView> {
    return this.map(() => this.students.getOwnProfile(req.accountId as string));
  }

  @Put('date-of-birth')
  async dob(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<StudentProfileView> {
    const date = parseIsoDate(body(raw).dateOfBirth);
    return this.map(() => this.students.setDateOfBirth(req.accountId as string, date));
  }

  @Put('display-name')
  async name(@Req() req: AuthenticatedRequest, @Body() raw: unknown): Promise<StudentProfileView> {
    const name = body(raw).displayName;
    if (typeof name !== 'string') throw new BadRequestException('displayName must be a string');
    return this.map(() => this.students.setDisplayName(req.accountId as string, name));
  }

  private async map<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StudentNotFoundError) throw new NotFoundException(e.message);
      if (e instanceof InvalidDateOfBirthError || e instanceof InvalidProfileInputError) {
        throw new BadRequestException(e.message);
      }
      if (e instanceof GuardianConsentRequiredError) throw new ForbiddenException(e.message);
      if (e instanceof MethodNotAcceptedError) throw new UnprocessableEntityException(e.message);
      if ((e as { code?: string }).code === 'P2002') throw new ConflictException();
      throw e;
    }
  }
}
