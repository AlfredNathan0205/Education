/** One tombstone per line, as `erasure tombstones` prints them. Blank lines are ignored; anything else stops. */
export function parseTombstones(text: string): Array<{ subjectType: string; subjectId: string; accountIds: string[] }> {
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (!line) continue;
    let v: any;
    try {
      v = JSON.parse(line);
    } catch {
      throw new Error(`line ${i + 1} is not JSON`);
    }
    if ((v?.subjectType !== 'STUDENT' && v?.subjectType !== 'ACCOUNT') || typeof v.subjectId !== 'string') throw new Error(`line ${i + 1} is not a tombstone`);
    const accountIds = Array.isArray(v.accountIds) ? v.accountIds.filter((a: unknown) => typeof a === 'string') : [];
    out.push({ subjectType: v.subjectType, subjectId: v.subjectId, accountIds });
  }
  return out;
}
