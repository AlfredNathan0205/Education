import { InvalidIdentifierError, maskIdentifier, normalizeIdentifier } from './identifier';

describe('normalizeIdentifier', () => {
  it('lower-cases and trims emails', () => {
    expect(normalizeIdentifier('EMAIL', '  Student@Example.COM ')).toBe('student@example.com');
  });

  it('rejects malformed emails', () => {
    for (const bad of ['', 'plain', 'a@b', '@x.com', 'a b@x.com', 'a@@x.com']) {
      expect(() => normalizeIdentifier('EMAIL', bad)).toThrow(InvalidIdentifierError);
    }
  });

  it('rejects over-long emails', () => {
    expect(() => normalizeIdentifier('EMAIL', `${'a'.repeat(320)}@x.com`)).toThrow(
      InvalidIdentifierError,
    );
  });

  it('normalizes phone numbers to E.164 by stripping separators', () => {
    expect(normalizeIdentifier('PHONE', '+971 50 123-4567')).toBe('+971501234567');
    expect(normalizeIdentifier('PHONE', '+91 (98765) 43210')).toBe('+919876543210');
  });

  it('rejects phone numbers without a leading + or with bad length', () => {
    for (const bad of ['0501234567', '+0123456789', '+12345', '+1234567890123456', 'abc']) {
      expect(() => normalizeIdentifier('PHONE', bad)).toThrow(InvalidIdentifierError);
    }
  });

  it('rejects non-string input', () => {
    expect(() => normalizeIdentifier('EMAIL', undefined as unknown as string)).toThrow(
      InvalidIdentifierError,
    );
  });
});

describe('maskIdentifier', () => {
  it('never reveals the full identifier', () => {
    expect(maskIdentifier('EMAIL', 'student@example.com')).toBe('s***@example.com');
    expect(maskIdentifier('PHONE', '+971501234567')).toBe('+971****67');
  });
});
