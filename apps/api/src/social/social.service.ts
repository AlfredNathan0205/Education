import { Inject, Injectable } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import type { Prisma } from '@exam-app/database';
import { InsufficientBankError, WHOLE_SUBJECT, assemble, type AssemblyDesign } from '../assembly/assembly-engine';
import { loadServablePool } from '../assembly/pool';
import { AuthzService } from '../authz/authz.service';
import { publicHandle } from '../competition/competition-domain';
import { DatabaseService } from '../database/database.service';
import { ExamConflictError, ExamInputError, ExamNotFoundError, ExamNotPermittedError, ExamUnavailableError } from '../exam/exam.errors';
import { ExamService } from '../exam/exam.service';
import { newSeed } from '../exam/exam-domain';
import { OutboxService } from '../outbox/outbox.service';
import { PrivacyService } from '../privacy/privacy.service';
import {
  SOCIAL_V1,
  afterGuardianDecision,
  challengeRefusal,
  effectiveStatus,
  interactionBlocked,
  isReportReason,
  newFriendCode,
  normaliseCode,
  outcomeFor,
  pairOf,
  startingStatus,
  type ChallengeStatus,
  type Outcome,
  type ReportResolution,
} from './social-domain';

type Tx = Prisma.TransactionClient;

export const SOCIAL_CONFIG = Symbol('SOCIAL_CONFIG');
export interface SocialConfig {
  /** SOCIAL_FEATURES_ENABLED. Off: every social route answers 404 and the overview says disabled. */
  enabled: boolean;
}

/** SOCIAL_FEATURES_ENABLED=true switches friends and challenges on. Off by default (spec: CONTROLLED activation). */
export function socialEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = env.SOCIAL_FEATURES_ENABLED?.trim().toLowerCase();
  if (raw === undefined || raw === '' || raw === 'false') return false;
  if (raw === 'true') return true;
  throw new Error('SOCIAL_FEATURES_ENABLED must be "true" or "false"');
}

export class SocialDisabledError extends Error {
  constructor() {
    super('Not found');
  }
}

const CHALLENGE_BLUEPRINT = 'CHALLENGE10';
const CHALLENGE_DESIGN: AssemblyDesign = {
  code: CHALLENGE_BLUEPRINT,
  version: 1,
  total: SOCIAL_V1.challenge.questions,
  difficulty: { ...SOCIAL_V1.challenge.mix },
  types: [{ type: 'MCQ', count: SOCIAL_V1.challenge.questions }],
  cells: [],
  preferUnseen: true,
  openingDifficulty: 'EASY',
};

export interface FriendView {
  friendshipId: string;
  handle: string;
  status: 'PENDING_GUARDIAN' | 'ACTIVE';
  /** While pending: whose guardian still has to approve. */
  waitingFor: Array<'YOUR_GUARDIAN' | 'THEIR_GUARDIAN'>;
}

export interface ChallengeView {
  id: string;
  role: 'CHALLENGER' | 'OPPONENT';
  status: ChallengeStatus;
  subjectName: string;
  opponentHandle: string;
  expiresAt: string;
  /** Your own test for this challenge, if you have started it. */
  myAssessmentId: string | null;
  myState: 'NOT_STARTED' | 'IN_PROGRESS' | 'FINISHED';
  /** Only when both have finished (spec: the other player's progress and answers stay hidden until then). */
  result: { mine: { correct: number; total: number }; theirs: { correct: number; total: number }; outcome: Outcome } | null;
}

export interface SocialOverview {
  enabled: boolean;
  restricted?: boolean;
  handle?: string;
  code?: { code: string; expiresAt: string } | null;
  friends?: FriendView[];
  challenges?: ChallengeView[];
  subjects?: Array<{ subjectVersionId: string; subjectName: string }>;
}

/**
 * Friends and ranked challenges (Step 16), behind SOCIAL_FEATURES_ENABLED. No free text anywhere: handles are
 * generated, reports are reason codes, and there is no chat.
 */
@Injectable()
export class SocialService {
  constructor(
    private readonly db: DatabaseService,
    private readonly exam: ExamService,
    private readonly privacy: PrivacyService,
    private readonly authz: AuthzService,
    private readonly outbox: OutboxService,
    @Inject(SOCIAL_CONFIG) private readonly config: SocialConfig,
  ) {}

  private on(): void {
    if (!this.config.enabled) throw new SocialDisabledError();
  }

  // ── the student's overview ────────────────────────────────────────────────

  async overview(accountId: string, now = new Date()): Promise<SocialOverview> {
    if (!this.config.enabled) return { enabled: false };
    const me = await this.exam.studentFor(accountId);
    const db = this.db.client as any;
    const handle = await this.handleFor(db, me);
    const restricted = await this.isRestricted(db, me);
    const code = await db.friend_code.findFirst({ where: { student_id: me, used_at: null, expires_at: { gt: now } }, orderBy: { created_at: 'desc' } });

    const rows: any[] = await db.friendship.findMany({
      where: { status: { not: 'ENDED' }, OR: [{ student_low: me }, { student_high: me }] },
      include: { approvals: true },
      orderBy: { created_at: 'asc' },
    });
    const friends: FriendView[] = [];
    for (const f of rows) {
      const other = f.student_low === me ? f.student_high : f.student_low;
      const pending = f.approvals.filter((a: any) => a.status === 'PENDING');
      friends.push({
        friendshipId: f.id,
        handle: await this.handleFor(db, other),
        status: f.status,
        waitingFor: [...(pending.some((a: any) => a.student_id === me) ? ['YOUR_GUARDIAN' as const] : []), ...(pending.some((a: any) => a.student_id === other) ? ['THEIR_GUARDIAN' as const] : [])],
      });
    }

    const parts: any[] = await db.challenge_participant.findMany({
      where: { student_id: me, challenge: { created_at: { gte: new Date(now.getTime() - 30 * 86_400_000) } } },
      include: { challenge: { include: { participants: true } } },
    });
    const challenges: ChallengeView[] = [];
    for (const p of parts.sort((a, b) => b.challenge.created_at - a.challenge.created_at)) {
      challenges.push(await this.challengeView(db, p.challenge, me, now));
    }
    const units = await this.exam.listUnits(accountId);
    return {
      enabled: true,
      restricted,
      handle,
      code: code ? { code: code.code, expiresAt: code.expires_at.toISOString() } : null,
      friends,
      challenges,
      subjects: units.map((u) => ({ subjectVersionId: u.subjectVersionId, subjectName: u.subjectName })),
    };
  }

  // ── friends ───────────────────────────────────────────────────────────────

  /** A new one-time code to show a friend in person. Rate-limited. */
  async createCode(accountId: string, now = new Date()): Promise<{ code: string; expiresAt: string }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    const db = this.db.client as any;
    await this.notRestricted(db, me);
    const recent = await db.friend_code.count({ where: { student_id: me, created_at: { gte: new Date(now.getTime() - 3600_000) } } });
    if (recent >= SOCIAL_V1.code.perHour) throw new ExamConflictError(`You can make at most ${SOCIAL_V1.code.perHour} codes an hour. Use the one you have, or try later.`);
    const expiresAt = new Date(now.getTime() + SOCIAL_V1.code.ttlMinutes * 60_000);
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = newFriendCode(() => randomInt(0, 1_000_000) / 1_000_000);
      try {
        await db.friend_code.create({ data: { student_id: me, code, expires_at: expiresAt } });
        return { code, expiresAt: expiresAt.toISOString() };
      } catch (e) {
        if ((e as { code?: string }).code !== 'P2002') throw e;
      }
    }
    throw new Error('could not make a unique friend code');
  }

  /** Enter a friend's code. With a minor in the pair the friendship waits for each minor's guardian. */
  async redeem(accountId: string, raw: unknown, now = new Date()): Promise<{ friendshipId: string; status: string }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    const WRONG = 'That code is not valid, has been used, or has expired. Ask your friend to show you a new one.';
    const out = await this.db.client.$transaction(async (tx: Tx): Promise<{ friendshipId: string; status: string } | 'WRONG_CODE'> => {
      const db = tx as any;
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${me}::uuid FOR UPDATE`;
      await this.notRestricted(db, me);
      const failed = await db.friend_code_attempt.count({ where: { student_id: me, ok: false, at: { gte: new Date(now.getTime() - 3600_000) } } });
      if (failed >= SOCIAL_V1.failedRedeemsPerHour) throw new ExamConflictError('Too many codes that did not work. Try again in an hour.');
      const code = normaliseCode(raw);
      const row = code ? await db.friend_code.findUnique({ where: { code } }) : null;
      const other: string | null = row && row.student_id !== me && !row.used_at && row.expires_at > now ? row.student_id : null;
      // A blocked or restricted pair gets the same answer as a wrong code: nothing is revealed about the other student.
      const refused = other ? interactionBlocked({ blockedEitherWay: await this.blockedEitherWay(db, me, other), restricted: await this.restrictedOf(db, [me, other]), self: me, other }) : 'INVALID';
      // Returned, not thrown: the failed attempt must be recorded outside this transaction or it would roll back.
      if (!other || refused) return 'WRONG_CODE';
      const pair = pairOf(me, other);
      if (await db.friendship.findFirst({ where: { student_low: pair.low, student_high: pair.high, status: { not: 'ENDED' } } })) {
        throw new ExamConflictError('You are already friends (or waiting for approval)');
      }
      const minors = (await Promise.all([me, other].map(async (s) => ((await this.isMinor(db, s)) ? s : null)))).filter((s): s is string => s !== null);
      const start = startingStatus(minors);
      await db.friend_code.update({ where: { id: row.id }, data: { used_at: now, used_by_student_id: me } });
      await db.friend_code_attempt.create({ data: { student_id: me, ok: true } });
      const f = await db.friendship.create({
        data: {
          student_low: pair.low,
          student_high: pair.high,
          status: start.status,
          code_id: row.id,
          activated_at: start.status === 'ACTIVE' ? now : null,
          approvals: { create: start.approvalsNeeded.map((s) => ({ student_id: s, status: 'PENDING' })) },
        },
      });
      await this.publish(tx, 'social.friendship_created.v1', f.id, { friendshipId: f.id, status: f.status, guardianApprovals: start.approvalsNeeded.length });
      return { friendshipId: f.id, status: f.status };
    });
    if (out === 'WRONG_CODE') {
      await (this.db.client as any).friend_code_attempt.create({ data: { student_id: me, ok: false } });
      throw new ExamNotFoundError(WRONG);
    }
    return out;
  }

  async unfriend(accountId: string, friendshipId: string): Promise<{ ended: true }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const f = await this.myFriendship(tx, me, friendshipId);
      if (f.status !== 'ENDED') await this.endFriendship(tx, f, 'UNFRIENDED', me);
      return { ended: true as const };
    });
  }

  /** Block: at once, both ways. Ends the friendship and any open challenge between them. */
  async block(accountId: string, friendshipId: string): Promise<{ blocked: true }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const f = await this.myFriendship(tx, me, friendshipId);
      const other = f.student_low === me ? f.student_high : f.student_low;
      if (!(await db.student_block.findUnique({ where: { blocker_student_id_blocked_student_id: { blocker_student_id: me, blocked_student_id: other } } }))) {
        await db.student_block.create({ data: { blocker_student_id: me, blocked_student_id: other } });
      }
      if (f.status !== 'ENDED') await this.endFriendship(tx, f, 'BLOCKED', me);
      return { blocked: true as const };
    });
  }

  /** Report: a reason code only. Ends the friendship at once (PM decision) and goes to the admin queue. */
  async report(accountId: string, input: { friendshipId?: string; challengeId?: string; reason: unknown }): Promise<{ reported: true }> {
    this.on();
    if (!isReportReason(input.reason)) throw new ExamInputError('Choose one of the reasons');
    const reason = input.reason;
    const me = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      let other: string;
      let friendship: any = null;
      if (input.friendshipId) {
        friendship = await this.myFriendship(tx, me, input.friendshipId);
        other = friendship.student_low === me ? friendship.student_high : friendship.student_low;
      } else if (input.challengeId) {
        const c = await db.challenge.findFirst({ where: { id: input.challengeId, OR: [{ challenger_student_id: me }, { opponent_student_id: me }] } });
        if (!c) throw new ExamNotFoundError('Challenge not found');
        other = c.challenger_student_id === me ? c.opponent_student_id : c.challenger_student_id;
        const pair = pairOf(me, other);
        friendship = await db.friendship.findFirst({ where: { student_low: pair.low, student_high: pair.high, status: { not: 'ENDED' } } });
      } else throw new ExamInputError('Say which friend or challenge this is about');
      const r = await db.safety_report.create({
        data: { reporter_student_id: me, reported_student_id: other, reason, friendship_id: friendship?.id ?? null, challenge_id: input.challengeId ?? null, status: 'OPEN' },
      });
      if (friendship && friendship.status !== 'ENDED') await this.endFriendship(tx, friendship, 'REPORTED', me);
      else await this.cancelOpenChallenges(tx, me, other);
      await this.publish(tx, 'social.report_created.v1', r.id, { reportId: r.id, reason });
      return { reported: true as const };
    });
  }

  // ── challenges ────────────────────────────────────────────────────────────

  /** Challenge an active friend in a subject: one set of ten questions neither has seen, the same for both. */
  async createChallenge(accountId: string, input: { friendshipId: string; subjectVersionId: string }, now = new Date()): Promise<{ challengeId: string }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    const units = await this.exam.listUnits(accountId);
    const unitView = units.find((u) => u.subjectVersionId === input.subjectVersionId);
    if (!unitView) throw new ExamUnavailableError('This subject is not part of your curriculum and grade');
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${me}::uuid FOR UPDATE`;
      const f = await this.myFriendship(tx, me, input.friendshipId);
      const other = f.student_low === me ? f.student_high : f.student_low;
      const why = interactionBlocked({ blockedEitherWay: await this.blockedEitherWay(db, me, other), restricted: await this.restrictedOf(db, [me, other]), self: me, other });
      if (why === 'YOU_ARE_RESTRICTED') throw new ExamNotPermittedError('Friends and challenges are not available on your account');
      if (why) throw new ExamConflictError('You cannot challenge this friend');
      const unit = await db.curriculum_subject_version.findUnique({ where: { id: input.subjectVersionId } });
      const [mine, theirs] = await Promise.all([me, other].map((s) => db.student_academic_context.findUnique({ where: { student_id: s } })));
      const openBetween = await db.challenge.count({
        where: {
          subject_id: unit.subject_id,
          status: { in: ['PENDING', 'ACTIVE'] },
          expires_at: { gt: now },
          OR: [
            { challenger_student_id: me, opponent_student_id: other },
            { challenger_student_id: other, opponent_student_id: me },
          ],
        },
      });
      const refusal = challengeRefusal({
        friendshipActive: f.status === 'ACTIVE',
        sameCohort: !!mine && !!theirs && mine.curriculum_code === theirs.curriculum_code && mine.grade_code === theirs.grade_code,
        openBetweenThem: openBetween,
        sentToday: await db.challenge.count({ where: { challenger_student_id: me, created_at: { gte: new Date(now.getTime() - 86_400_000) } } }),
      });
      if (refusal) throw new ExamConflictError(refusal);
      // A stale open challenge between them (expired) is closed first, so the one-open index does not refuse the new one.
      await db.challenge.updateMany({
        where: { subject_id: unit.subject_id, status: { in: ['PENDING', 'ACTIVE'] }, expires_at: { lte: now }, OR: [{ challenger_student_id: me, opponent_student_id: other }, { challenger_student_id: other, opponent_student_id: me }] },
        data: { status: 'EXPIRED' },
      });

      // Exposure (spec): only questions neither player has been shown.
      const pool = await loadServablePool(tx, unit, me);
      const theirsSeen = new Set<string>(
        ((await db.student_question_exposure.findMany({ where: { student_id: other, question_id: { in: pool.items.map((i: any) => i.questionId) } }, select: { question_id: true } })) as any[]).map((r) => r.question_id),
      );
      const fresh = pool.items.filter((i: any) => i.lastSeenAt === null && !theirsSeen.has(i.questionId));
      const seed = newSeed();
      let assembled;
      try {
        assembled = assemble(fresh, CHALLENGE_DESIGN, seed, WHOLE_SUBJECT);
      } catch (e) {
        if (e instanceof InsufficientBankError) {
          throw new ExamUnavailableError(`There are not yet ${SOCIAL_V1.challenge.questions} questions in ${unitView.subjectName} that neither of you has seen. Try another subject.`);
        }
        throw e;
      }
      const items = assembled.items.map((i) => ({ position: i.position, revisionId: i.revisionId, questionId: i.questionId, objectivePath: i.objectivePath, difficulty: i.difficulty, optionOrder: i.optionOrder }));
      const c = await db.challenge.create({
        data: {
          challenger_student_id: me,
          opponent_student_id: other,
          friendship_id: f.id,
          curriculum_version_id: unit.curriculum_version_id,
          grade_id: unit.grade_id,
          subject_id: unit.subject_id,
          subject_version_id: unit.id,
          status: 'PENDING',
          items: items as unknown as Prisma.InputJsonValue,
          assembly_report: { ...assembled.report, seed, freshPool: fresh.length } as unknown as Prisma.InputJsonValue,
          expires_at: new Date(now.getTime() + SOCIAL_V1.challenge.expiresHours * 3600_000),
          participants: { create: [{ student_id: me, role: 'CHALLENGER' }, { student_id: other, role: 'OPPONENT' }] },
        },
      });
      await this.publish(tx, 'social.challenge_created.v1', c.id, { challengeId: c.id });
      return { challengeId: c.id };
    });
  }

  /** The opponent accepts (and starts) or declines. */
  async respond(accountId: string, challengeId: string, accept: boolean, now = new Date()): Promise<{ assessmentId: string | null }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${me}::uuid FOR UPDATE`;
      const c = await db.challenge.findFirst({ where: { id: challengeId, opponent_student_id: me }, include: { participants: true } });
      if (!c) throw new ExamNotFoundError('Challenge not found');
      if (effectiveStatus({ status: c.status, expiresAt: c.expires_at }, now) !== 'PENDING') throw new ExamConflictError('This challenge is no longer waiting for an answer');
      if (!accept) {
        await db.challenge.update({ where: { id: c.id }, data: { status: 'DECLINED', responded_at: now } });
        await this.publish(tx, 'social.challenge_declined.v1', c.id, { challengeId: c.id });
        return { assessmentId: null };
      }
      await this.mayPlay(db, me, c.challenger_student_id);
      await db.challenge.update({ where: { id: c.id }, data: { status: 'ACTIVE', responded_at: now } });
      await this.publish(tx, 'social.challenge_accepted.v1', c.id, { challengeId: c.id });
      return { assessmentId: await this.startIn(tx, me, c) };
    });
  }

  /** Start (or resume) your own test for a challenge. The challenger may start while it waits for an answer. */
  async start(accountId: string, challengeId: string, now = new Date()): Promise<{ assessmentId: string }> {
    this.on();
    const me = await this.exam.studentFor(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      await tx.$queryRaw`SELECT id FROM student WHERE id = ${me}::uuid FOR UPDATE`;
      const c = await db.challenge.findFirst({ where: { id: challengeId, OR: [{ challenger_student_id: me }, { opponent_student_id: me }] }, include: { participants: true } });
      if (!c) throw new ExamNotFoundError('Challenge not found');
      const part = c.participants.find((p: any) => p.student_id === me);
      if (part.session_id) return { assessmentId: part.session_id as string };
      const status = effectiveStatus({ status: c.status, expiresAt: c.expires_at }, now);
      const mayStart = status === 'ACTIVE' || (status === 'PENDING' && part.role === 'CHALLENGER');
      if (!mayStart) throw new ExamConflictError(status === 'PENDING' ? 'Accept the challenge first' : 'This challenge is no longer open');
      await this.mayPlay(db, me, part.role === 'CHALLENGER' ? c.opponent_student_id : c.challenger_student_id);
      return { assessmentId: await this.startIn(tx, me, c) };
    });
  }

  // ── guardians ─────────────────────────────────────────────────────────────

  /** Friendships waiting for this guardian: only for students they hold a live guardian approval for. */
  async guardianPending(guardianAccountId: string): Promise<Array<{ approvalId: string; studentName: string | null; otherHandle: string; requestedAt: string }>> {
    this.on();
    const mine = await this.privacy.listGuardianApprovals(guardianAccountId);
    if (!mine.length) return [];
    const db = this.db.client as any;
    const rows: any[] = await db.friendship_guardian_approval.findMany({
      where: { student_id: { in: mine.map((m) => m.studentId) }, status: 'PENDING', friendship: { status: 'PENDING_GUARDIAN' } },
      include: { friendship: true },
      orderBy: { created_at: 'asc' },
    });
    const out = [];
    for (const r of rows) {
      const other = r.friendship.student_low === r.student_id ? r.friendship.student_high : r.friendship.student_low;
      out.push({ approvalId: r.id, studentName: ((m) => m?.label ?? m?.displayName ?? null)(mine.find((m) => m.studentId === r.student_id) as { label?: string; displayName: string | null } | undefined), otherHandle: await this.handleFor(db, other), requestedAt: r.created_at.toISOString() });
    }
    return out;
  }

  async guardianDecide(guardianAccountId: string, approvalId: string, approve: boolean, now = new Date()): Promise<{ friendshipStatus: string }> {
    this.on();
    const mine = await this.privacy.listGuardianApprovals(guardianAccountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const a = await db.friendship_guardian_approval.findUnique({ where: { id: approvalId }, include: { friendship: { include: { approvals: true } } } });
      if (!a || !mine.some((m) => m.studentId === a.student_id)) throw new ExamNotFoundError('Request not found');
      if (a.status !== 'PENDING' || a.friendship.status !== 'PENDING_GUARDIAN') throw new ExamConflictError('This request has already been answered');
      await db.friendship_guardian_approval.update({ where: { id: a.id }, data: { status: approve ? 'APPROVED' : 'DECLINED', decided_by_account_id: guardianAccountId, decided_at: now } });
      const next = afterGuardianDecision(a.friendship.approvals.map((x: any) => ({ status: x.id === a.id ? (approve ? 'APPROVED' : 'DECLINED') : x.status })));
      if (next === 'ACTIVE') await db.friendship.update({ where: { id: a.friendship_id }, data: { status: 'ACTIVE', activated_at: now } });
      if (next === 'ENDED') await db.friendship.update({ where: { id: a.friendship_id }, data: { status: 'ENDED', ended_at: now, ended_reason: 'GUARDIAN_DECLINED' } });
      await db.audit_event.create({
        data: { actor_account_id: guardianAccountId, action: approve ? 'social.friendship_approved_by_guardian' : 'social.friendship_declined_by_guardian', subject_type: 'student', subject_id: a.student_id, metadata: { friendshipId: a.friendship_id } },
      });
      return { friendshipStatus: next };
    });
  }

  // ── admins ────────────────────────────────────────────────────────────────

  /** The report queue. SUPER_ADMIN only until a dedicated safety role exists. Every view is audited. */
  async reports(accountId: string, status: 'OPEN' | 'RESOLVED' = 'OPEN'): Promise<any[]> {
    this.on();
    await this.mustBeSafetyAdmin(accountId);
    const db = this.db.client as any;
    const rows: any[] = await db.safety_report.findMany({ where: { status }, orderBy: { created_at: 'asc' }, take: 200 });
    await db.audit_event.create({ data: { actor_account_id: accountId, action: 'safety.reports_viewed', subject_type: 'safety_report', subject_id: status, metadata: { count: rows.length } } });
    const out = [];
    for (const r of rows) {
      out.push({
        id: r.id,
        reason: r.reason,
        status: r.status,
        resolution: r.resolution,
        createdAt: r.created_at.toISOString(),
        reporter: { studentId: r.reporter_student_id, handle: await this.handleFor(db, r.reporter_student_id) },
        reported: {
          studentId: r.reported_student_id,
          handle: await this.handleFor(db, r.reported_student_id),
          openReports: await db.safety_report.count({ where: { reported_student_id: r.reported_student_id, status: 'OPEN' } }),
          restricted: await this.isRestricted(db, r.reported_student_id),
        },
        friendshipId: r.friendship_id,
        challengeId: r.challenge_id,
      });
    }
    return out;
  }

  async resolve(accountId: string, reportId: string, resolution: ReportResolution, now = new Date()): Promise<{ resolved: true }> {
    this.on();
    if (resolution !== 'NO_ACTION' && resolution !== 'RESTRICTED') throw new ExamInputError('resolution must be NO_ACTION or RESTRICTED');
    await this.mustBeSafetyAdmin(accountId);
    return this.db.client.$transaction(async (tx: Tx) => {
      const db = tx as any;
      const r = await db.safety_report.findUnique({ where: { id: reportId } });
      if (!r) throw new ExamNotFoundError('Report not found');
      if (r.status !== 'OPEN') throw new ExamConflictError('This report is already resolved');
      await db.safety_report.update({ where: { id: r.id }, data: { status: 'RESOLVED', resolution, resolved_by_account_id: accountId, resolved_at: now } });
      if (resolution === 'RESTRICTED' && !(await this.isRestricted(db, r.reported_student_id))) {
        await db.social_restriction.create({ data: { student_id: r.reported_student_id, report_id: r.id, created_by_account_id: accountId } });
        await db.challenge.updateMany({
          where: { status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ challenger_student_id: r.reported_student_id }, { opponent_student_id: r.reported_student_id }] },
          data: { status: 'CANCELLED' },
        });
      }
      await db.audit_event.create({ data: { actor_account_id: accountId, action: 'safety.report_resolved', subject_type: 'student', subject_id: r.reported_student_id, reason_code: resolution, metadata: { reportId: r.id } } });
      return { resolved: true as const };
    });
  }

  // ── internals ─────────────────────────────────────────────────────────────

  private async challengeView(db: any, c: any, me: string, now: Date): Promise<ChallengeView> {
    const mine = c.participants.find((p: any) => p.student_id === me);
    const theirs = c.participants.find((p: any) => p.student_id !== me);
    const sessions: any[] = await db.assessment_session.findMany({
      where: { id: { in: c.participants.map((p: any) => p.session_id).filter(Boolean) } },
      include: { result: true },
    });
    const s = (p: any) => sessions.find((x) => x.id === p?.session_id) ?? null;
    const done = (x: any) => !!x && x.status !== 'IN_PROGRESS';
    let status = effectiveStatus({ status: c.status, expiresAt: c.expires_at }, now);
    if (c.status === 'ACTIVE' && done(s(mine)) && done(s(theirs))) {
      status = 'COMPLETED';
      await db.challenge.updateMany({ where: { id: c.id, status: 'ACTIVE' }, data: { status: 'COMPLETED', completed_at: now } });
    } else if (status === 'EXPIRED' && c.status !== 'EXPIRED') {
      await db.challenge.updateMany({ where: { id: c.id, status: c.status }, data: { status: 'EXPIRED' } });
    }
    const ms = s(mine);
    const ts = s(theirs);
    const result =
      status === 'COMPLETED' && ms?.result && ts?.result && ms.status === 'SUBMITTED' && ts.status === 'SUBMITTED'
        ? {
            mine: { correct: ms.result.correct, total: ms.result.total },
            theirs: { correct: ts.result.correct, total: ts.result.total },
            outcome: outcomeFor(ms.result, ts.result),
          }
        : null;
    const subject = await db.subject.findUnique({ where: { id: c.subject_id }, select: { name: true } });
    return {
      id: c.id,
      role: mine.role,
      status,
      subjectName: subject?.name ?? '',
      opponentHandle: await this.handleFor(db, theirs.student_id),
      expiresAt: c.expires_at.toISOString(),
      myAssessmentId: mine.session_id ?? null,
      myState: !ms ? 'NOT_STARTED' : ms.status === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'FINISHED',
      result,
    };
  }

  private async startIn(tx: Tx, me: string, c: any): Promise<string> {
    const db = tx as any;
    const { assessmentId } = await this.exam.createFixed(tx, me, {
      unit: { subjectVersionId: c.subject_version_id, curriculumVersionId: c.curriculum_version_id, gradeId: c.grade_id, subjectId: c.subject_id },
      blueprint: CHALLENGE_BLUEPRINT,
      seed: (c.assembly_report as any)?.seed ?? 'challenge',
      assemblyReport: { ...(c.assembly_report as object), challengeId: c.id },
      items: c.items as any[],
    });
    await db.challenge_participant.update({ where: { challenge_id_student_id: { challenge_id: c.id, student_id: me } }, data: { session_id: assessmentId } });
    return assessmentId;
  }

  private async mayPlay(db: any, me: string, other: string): Promise<void> {
    const why = interactionBlocked({ blockedEitherWay: await this.blockedEitherWay(db, me, other), restricted: await this.restrictedOf(db, [me, other]), self: me, other });
    if (why === 'YOU_ARE_RESTRICTED') throw new ExamNotPermittedError('Friends and challenges are not available on your account');
    if (why) throw new ExamConflictError('This challenge is no longer available');
  }

  private async myFriendship(tx: Tx, me: string, friendshipId: string): Promise<any> {
    const f = await (tx as any).friendship.findFirst({ where: { id: friendshipId, OR: [{ student_low: me }, { student_high: me }] } });
    if (!f) throw new ExamNotFoundError('Friend not found');
    return f;
  }

  private async endFriendship(tx: Tx, f: any, reason: 'UNFRIENDED' | 'BLOCKED' | 'REPORTED', by: string): Promise<void> {
    const db = tx as any;
    await db.friendship.update({ where: { id: f.id }, data: { status: 'ENDED', ended_at: new Date(), ended_reason: reason, ended_by_student_id: by } });
    await this.cancelOpenChallenges(tx, f.student_low, f.student_high);
    await this.publish(tx, 'social.friendship_ended.v1', f.id, { friendshipId: f.id, reason });
  }

  private async cancelOpenChallenges(tx: Tx, a: string, b: string): Promise<void> {
    await (tx as any).challenge.updateMany({
      where: { status: { in: ['PENDING', 'ACTIVE'] }, OR: [{ challenger_student_id: a, opponent_student_id: b }, { challenger_student_id: b, opponent_student_id: a }] },
      data: { status: 'CANCELLED' },
    });
  }

  private async blockedEitherWay(db: any, a: string, b: string): Promise<boolean> {
    return (
      (await db.student_block.count({
        where: { OR: [{ blocker_student_id: a, blocked_student_id: b }, { blocker_student_id: b, blocked_student_id: a }] },
      })) > 0
    );
  }

  private async restrictedOf(db: any, ids: string[]): Promise<string[]> {
    const rows: any[] = await db.social_restriction.findMany({ where: { student_id: { in: ids }, lifted_at: null }, select: { student_id: true } });
    return rows.map((r) => r.student_id);
  }

  private async isRestricted(db: any, id: string): Promise<boolean> {
    return (await this.restrictedOf(db, [id])).length > 0;
  }

  private async notRestricted(db: any, id: string): Promise<void> {
    if (await this.isRestricted(db, id)) throw new ExamNotPermittedError('Friends and challenges are not available on your account');
  }

  /** Minor status from the current age classification; no classification counts as a minor (fail closed). */
  private async isMinor(db: any, studentId: string): Promise<boolean> {
    const c = await db.age_classification.findFirst({ where: { student_id: studentId, superseded_at: null }, select: { is_minor: true } });
    return c ? c.is_minor === true : true;
  }

  private async mustBeSafetyAdmin(accountId: string): Promise<void> {
    if (!(await this.authz.curriculumRolesFor(accountId)).includes('SUPER_ADMIN')) throw new ExamNotPermittedError('Only a safety administrator may see reports');
  }

  /** The same neutral handle as on the leaderboards (Step 15), made on first need. */
  private async handleFor(db: any, studentId: string): Promise<string> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const p = await db.public_profile.findUnique({ where: { student_id: studentId }, select: { handle: true } });
      if (p) return p.handle;
      const handle = publicHandle(() => randomInt(0, 1_000_000) / 1_000_000);
      await db.$executeRaw`INSERT INTO public_profile (student_id, handle, created_at, updated_at) VALUES (${studentId}::uuid, ${handle}, now(), now()) ON CONFLICT DO NOTHING`;
    }
    throw new Error('could not create a unique public handle');
  }

  private async publish(tx: Tx, eventType: string, aggregateId: string, payload: Record<string, unknown>): Promise<void> {
    // Each of these events happens at most once per aggregate (a friendship is created and ended once, a challenge is answered once).
    await this.outbox.publish(tx, { aggregateType: 'social', aggregateId, eventType, payload, idempotencyKey: `${eventType}:${aggregateId}` });
  }
}
