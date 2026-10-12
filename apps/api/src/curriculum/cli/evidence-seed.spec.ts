import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CurriculumConflictError } from '../curriculum.errors';
import { SeedFileError, parseSeedFile, runEvidenceSeed } from './evidence-seed';

const real = JSON.parse(readFileSync(join(__dirname, '../../../../../docs/curriculum/icse-g8-2026-27-evidence.json'), 'utf8'));

describe('the committed ICSE Grade 8 evidence file', () => {
  const seed = parseSeedFile(real);
  it('parses and covers exactly the four launch subjects', () => {
    expect(seed.units.map((u) => u.subjectCode)).toEqual(['PHYSICS', 'CHEMISTRY', 'BIOLOGY', 'MATHEMATICS']);
    expect(seed.versionLabel).toBe('2026-27');
  });
  it('has at least two references per subject and every reference fits the column limits', () => {
    for (const u of seed.units) {
      expect(u.references.length).toBeGreaterThanOrEqual(2);
      for (const r of u.references) {
        expect(r.sourceTitle.length).toBeLessThanOrEqual(500);
        expect(r.locator.length).toBeLessThanOrEqual(255);
      }
    }
  });
  it('never claims the canonical cisce.org copy was compared', () => {
    for (const u of seed.units) for (const r of u.references) expect(r.locator).toMatch(/not yet compared/);
  });
});

describe('parseSeedFile', () => {
  const ok = () => JSON.parse(JSON.stringify(real));
  it.each([
    ['non-object', 'x'],
    ['no units', { ...ok(), units: [] }],
  ])('rejects %s', (_l, v) => expect(() => parseSeedFile(v)).toThrow(SeedFileError));
  it('rejects a reference without a locator, a non-http url, a bad date, a duplicate subject', () => {
    const a = ok(); a.units[0].references[0].locator = '';
    expect(() => parseSeedFile(a)).toThrow(SeedFileError);
    const b = ok(); b.units[0].references[0].sourceUrl = 'ftp://x';
    expect(() => parseSeedFile(b)).toThrow(/http/);
    const c = ok(); c.units[0].references[0].retrievedAt = 'yesterday';
    expect(() => parseSeedFile(c)).toThrow(SeedFileError);
    const d = ok(); d.units[1].subjectCode = 'PHYSICS';
    expect(() => parseSeedFile(d)).toThrow(/duplicate/);
  });
});

describe('runEvidenceSeed', () => {
  const seed = parseSeedFile(real);
  it('creates each unit and its references, and says the pack is not verified', async () => {
    const admin = {
      createSubjectVersion: jest.fn().mockResolvedValue({ id: 'sv', revision: 1 }),
      addEvidenceReference: jest.fn().mockResolvedValue({ referenceId: 'r' }),
    };
    const report = await runEvidenceSeed(seed, 'editor-1', admin as never);
    expect(admin.createSubjectVersion).toHaveBeenCalledTimes(4);
    expect(admin.addEvidenceReference).toHaveBeenCalledTimes(8);
    expect(admin.createSubjectVersion.mock.calls[0][0]).toBe('editor-1');
    expect(report.every((l) => /NOT verified/.test(l))).toBe(true);
  });
  it('skips a unit that already exists whole, without adding references to it', async () => {
    const admin = {
      createSubjectVersion: jest.fn().mockRejectedValue(new CurriculumConflictError('exists')),
      addEvidenceReference: jest.fn(),
    };
    const report = await runEvidenceSeed(seed, 'e', admin as never);
    expect(admin.addEvidenceReference).not.toHaveBeenCalled();
    expect(report.every((l) => /skipped/.test(l))).toBe(true);
  });
  it('propagates other errors, such as a missing role', async () => {
    const admin = { createSubjectVersion: jest.fn().mockRejectedValue(new Error('no role')), addEvidenceReference: jest.fn() };
    await expect(runEvidenceSeed(seed, 'e', admin as never)).rejects.toThrow('no role');
  });
});
