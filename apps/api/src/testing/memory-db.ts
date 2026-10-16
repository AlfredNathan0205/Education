/**
 * Test helper (unit tests only): a small in-memory stand-in for the Prisma client. It understands the filters the
 * Step 20 services use (equality, null, in, not, lt/lte/gt/gte, OR, AND, compound unique keys) and rolls a
 * transaction back when its callback throws. It is not Postgres: CHECKs, triggers and real concurrency are covered by
 * the real-database integration tests.
 */
type Row = Record<string, any>;

function eq(a: any, b: any): boolean {
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  if (typeof a === 'bigint' || typeof b === 'bigint') return a !== null && a !== undefined && b !== null && b !== undefined && BigInt(a) === BigInt(b);
  return a === b;
}
const num = (v: any) => (v instanceof Date ? v.getTime() : typeof v === 'bigint' ? Number(v) : v);

function cond(v: any, c: any): boolean {
  if (c === null) return v === null || v === undefined;
  if (c instanceof Date || typeof c !== 'object' || Array.isArray(c)) return eq(v, c);
  return Object.entries(c).every(([op, x]: [string, any]) => {
    switch (op) {
      case 'in':
        return (x as any[]).some((y) => eq(v, y));
      case 'notIn':
        return !(x as any[]).some((y) => eq(v, y));
      case 'not':
        return x === null ? v !== null && v !== undefined : !cond(v, x);
      case 'lt':
        return v !== null && v !== undefined && num(v) < num(x);
      case 'lte':
        return v !== null && v !== undefined && num(v) <= num(x);
      case 'gt':
        return v !== null && v !== undefined && num(v) > num(x);
      case 'gte':
        return v !== null && v !== undefined && num(v) >= num(x);
      default:
        // A relation filter (for example `purpose: { code }`): the helper ignores it; tests mock those services.
        return true;
    }
  });
}

export function matches(row: Row, where: any = {}): boolean {
  return Object.entries(where ?? {}).every(([k, c]: [string, any]) => {
    if (k === 'OR') return (c as any[]).some((w) => matches(row, w));
    if (k === 'AND') return (c as any[]).every((w) => matches(row, w));
    if (k === 'NOT') return !matches(row, c);
    // Compound unique key, e.g. subject_type_subject_id: { subject_type, subject_id }.
    if (c && typeof c === 'object' && !(c instanceof Date) && !Array.isArray(c) && !(k in row) && Object.keys(c).every((f) => !['in', 'not', 'lt', 'lte', 'gt', 'gte', 'notIn'].includes(f)) && k.includes('_') && Object.keys(c).length > 1) {
      return matches(row, c);
    }
    return cond(row[k], c);
  });
}

function apply(row: Row, data: Row): void {
  for (const [k, v] of Object.entries(data)) {
    if (v && typeof v === 'object' && 'increment' in v) row[k] = (row[k] ?? 0) + v.increment;
    else row[k] = v;
  }
}

function pick(row: Row, select?: Record<string, boolean>): Row {
  if (!select) return { ...row };
  const out: Row = {};
  for (const [k, on] of Object.entries(select)) if (on === true) out[k] = row[k];
  return out;
}

export interface MemoryDbOptions {
  /** Unique columns per table (single or compound); a duplicate insert throws P2002 like Prisma. */
  unique?: Record<string, string[][]>;
  /** Defaults per table, applied on create. */
  defaults?: Record<string, () => Row>;
}

export function memoryDb(opts: MemoryDbOptions = {}) {
  let n = 0;
  let tables: Record<string, Row[]> = {};
  const t = (name: string) => (tables[name] ??= []);
  const uuid = () => {
    const h = (++n).toString(16).padStart(12, '0');
    return `00000000-0000-4000-8000-${h}`;
  };
  const checkUnique = (table: string, row: Row, except?: Row) => {
    for (const cols of opts.unique?.[table] ?? []) {
      if (t(table).some((r) => r !== except && cols.every((c) => row[c] !== undefined && row[c] !== null && eq(r[c], row[c])))) {
        throw Object.assign(new Error(`Unique constraint failed on ${table}(${cols.join(',')})`), { code: 'P2002' });
      }
    }
  };
  const sortRows = (rows: Row[], orderBy: any) => {
    const list = Array.isArray(orderBy) ? orderBy : orderBy ? [orderBy] : [];
    return list.length
      ? [...rows].sort((a, b) => {
          for (const o of list) {
            const [k, dir] = Object.entries(o)[0] as [string, string];
            const d = num(a[k]) < num(b[k]) ? -1 : num(a[k]) > num(b[k]) ? 1 : 0;
            if (d) return dir === 'desc' ? -d : d;
          }
          return 0;
        })
      : rows;
  };
  const model = (table: string) => ({
    findMany: jest.fn(async (a: any = {}) => {
      const rows = sortRows(t(table).filter((r) => matches(r, a.where)), a.orderBy);
      return (a.take ? rows.slice(0, a.take) : rows).map((r) => pick(r, a.select));
    }),
    findFirst: jest.fn(async (a: any = {}) => {
      const r = sortRows(t(table).filter((x) => matches(x, a.where)), a.orderBy)[0];
      return r ? pick(r, a.select) : null;
    }),
    findUnique: jest.fn(async (a: any) => {
      const r = t(table).find((x) => matches(x, a.where));
      return r ? pick(r, a.select) : null;
    }),
    count: jest.fn(async (a: any = {}) => t(table).filter((r) => matches(r, a.where)).length),
    create: jest.fn(async ({ data, select }: any) => {
      const row = { id: uuid(), ...(opts.defaults?.[table]?.() ?? {}), ...data };
      checkUnique(table, row);
      t(table).push(row);
      return pick(row, select);
    }),
    update: jest.fn(async ({ where, data }: any) => {
      const r = t(table).find((x) => matches(x, where));
      if (!r) throw Object.assign(new Error(`No ${table} row to update`), { code: 'P2025' });
      apply(r, data);
      return { ...r };
    }),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const rows = t(table).filter((x) => matches(x, where));
      for (const r of rows) apply(r, data);
      return { count: rows.length };
    }),
    upsert: jest.fn(async ({ where, create, update }: any) => {
      const r = t(table).find((x) => matches(x, where));
      if (r) {
        apply(r, update);
        return { ...r };
      }
      const row = { id: uuid(), ...create };
      checkUnique(table, row);
      t(table).push(row);
      return { ...row };
    }),
    delete: jest.fn(async ({ where }: any) => {
      const i = t(table).findIndex((x) => matches(x, where));
      if (i < 0) throw Object.assign(new Error(`No ${table} row to delete`), { code: 'P2025' });
      return t(table).splice(i, 1)[0];
    }),
    deleteMany: jest.fn(async ({ where }: any = {}) => {
      const keep = t(table).filter((r) => !matches(r, where));
      const count = t(table).length - keep.length;
      tables[table] = keep;
      return { count };
    }),
  });
  const models: Record<string, ReturnType<typeof model>> = {};
  const client: any = new Proxy(
    {
      get tables() {
        return tables;
      },
      uuid,
      seed(table: string, rows: Row[]) {
        for (const r of rows) t(table).push({ id: uuid(), ...r });
        return rows;
      },
      rows(table: string): Row[] {
        return t(table);
      },
      $transaction: async (fn: any) => {
        const snapshot = structuredClone(tables);
        try {
          return await fn(client);
        } catch (e) {
          tables = snapshot;
          throw e;
        }
      },
    } as any,
    { get: (target, prop: string) => (prop in target ? target[prop] : (models[prop] ??= model(prop))) },
  );
  return client;
}
