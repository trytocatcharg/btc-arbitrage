/**
 * In-memory fake of the drizzle-orm (mysql2 driver) fluent query API.
 *
 * Purpose: unit-test bot services that take a drizzle `db` handle (e.g.
 * the metal trade service) without a MariaDB instance. It implements ONLY
 * the surface those services use:
 *
 *   db.select(projection?).from(table)
 *       .innerJoin(table2, cond)?          // genuine nested-loop join
 *       .where(cond)?                      // eq / inArray / and
 *       .orderBy(column)?                  // ascending
 *       .limit(n)?
 *     -> Promise<row[]>                    // thenable at every stage
 *   db.insert(table).values(row | row[])   // auto-increment `id`
 *     -> Promise<[{ insertId, affectedRows }, []]>
 *   db.update(table).set(patch).where(cond)
 *     -> Promise<[{ affectedRows }, []]>
 *   db.transaction(async (tx) => ...)      // snapshot/restore rollback
 *
 * Result tuples match the mysql2 driver shape ([ResultSetHeader, []]) that
 * `extractInsertId` / `extractAffectedRows` (apps/bot/src/db-result.ts)
 * read, so services exercising both helpers work unchanged.
 *
 * Where-clause support is duck-typed against drizzle 0.38.x internals,
 * verified empirically (see below — do NOT re-guess; re-probe after a
 * drizzle upgrade):
 *   - eq(col, value)  : SQL.queryChunks = [StringChunk(""), Column,
 *                       StringChunk(" = "), Param(value), StringChunk("")]
 *   - eq(colA, colB)  : same, with a Column instead of the Param (used by
 *                       innerJoin conditions)
 *   - inArray(col, v) : [StringChunk(""), Column, StringChunk(" in "),
 *                       Array<Param>, StringChunk("")]
 *   - and(...)        : nested SQL chunks separated by StringChunk(" and ")
 * Columns are recognized by a string `.name` plus a `.table` reference and
 * mapped back to row properties by identity scanning of the table object's
 * own enumerable properties (trades.id === the column in the condition).
 *
 * FALLBACK (documented limitation): a condition that yields zero parsed
 * predicates (e.g. gt/lt/or/raw sql) MATCHES EVERY ROW and is recorded in
 * `db.unparsedConditions`. Tests that rely on precise filtering should
 * assert `db.unparsedConditions.length === 0`. eq-on-id (the atomic
 * claim/transition path) is fully parsed and matched exactly.
 *
 * Conventions:
 *   - Rows are plain objects keyed by the schema's JS property names
 *     (camelCase: `tradeId`, `quantityBase`, ...). Seed money/decimal
 *     columns as decimal STRINGS, mirroring mysql2 decimal reads.
 *   - `id` auto-increments per table on insert (and on seed when absent).
 *   - `rows(table)` returns the LIVE row array (updates are visible).
 *   - select() with no projection returns shallow copies of the primary
 *     table's rows; with a projection map (`{ key: table.column }`) it
 *     resolves each entry against the (possibly joined) row pair.
 */
export type FakeRow = Record<string, any>;
/** A drizzle mysqlTable object (its own enumerable props are columns). */
export type FakeTable = Record<string, any>;

type ResultTuple = [{ insertId: number; affectedRows: number }, []];

interface ConditionEq {
  kind: "eq";
  col: any;
  value: unknown;
}
interface ConditionColEq {
  kind: "colEq";
  left: any;
  right: any;
}
interface ConditionIn {
  kind: "in";
  col: any;
  values: unknown[];
}
type Condition = ConditionEq | ConditionColEq | ConditionIn;

interface TableStore {
  rows: FakeRow[];
  nextId: number;
}

export interface FakeDrizzleDb {
  select(projection?: Record<string, unknown>): FakeSelect;
  insert(table: FakeTable): FakeInsert;
  update(table: FakeTable): FakeUpdate;
  transaction<T>(fn: (tx: FakeDrizzleDb) => Promise<T>): Promise<T>;
  /** Live view of a table's rows (seeded + inserted, updates applied). */
  rows(table: FakeTable): FakeRow[];
  /** Append rows to a table (assigns auto-increment ids when absent). */
  seed(table: FakeTable, rows: FakeRow[]): void;
  /** Conditions that failed to parse and fell back to match-all. */
  readonly unparsedConditions: unknown[];
}

const isSql = (x: any): boolean =>
  x != null && typeof x === "object" && Array.isArray(x.queryChunks);
const isStringChunk = (x: any): boolean =>
  x?.constructor?.name === "StringChunk";
const isParam = (x: any): boolean => x?.constructor?.name === "Param";
const isColumn = (x: any): boolean =>
  x != null &&
  typeof x === "object" &&
  !isSql(x) &&
  typeof x.name === "string" &&
  x.table != null;

/** column object -> row property name, resolved by identity against the
 * table object's own enumerable properties (cached per table). */
const columnPropCache = new WeakMap<FakeTable, Map<any, string>>();
function columnProp(col: any): string | undefined {
  const table = col.table as FakeTable;
  let map = columnPropCache.get(table);
  if (!map) {
    map = new Map();
    for (const [prop, value] of Object.entries(table)) {
      if (isColumn(value)) map.set(value, prop);
    }
    columnPropCache.set(table, map);
  }
  return map.get(col);
}

/** Flatten nested SQL (and(...) nests sub-conditions as SQL chunks). */
function flattenChunks(sql: any): any[] {
  const out: any[] = [];
  for (const chunk of sql.queryChunks ?? []) {
    if (isSql(chunk)) out.push(...flattenChunks(chunk));
    else out.push(chunk);
  }
  return out;
}

const stringChunkText = (chunk: any): string => {
  const value = chunk.value;
  return Array.isArray(value) ? value.join("") : String(value ?? "");
};

/** Parse a drizzle SQL where/join condition into flat predicates. Returns
 * null when nothing parseable was found (caller applies the match-all
 * fallback). Only eq/inArray/and are supported — see module docstring. */
function parseConditions(cond: unknown): Condition[] | null {
  if (cond == null) return [];
  if (!isSql(cond)) return null;
  const chunks = flattenChunks(cond);
  const out: Condition[] = [];
  for (let i = 0; i < chunks.length - 1; i += 1) {
    const col = chunks[i];
    if (!isColumn(col)) continue;
    const op = chunks[i + 1];
    if (!isStringChunk(op)) continue;
    const operand = chunks[i + 2];
    const opText = stringChunkText(op);
    if (opText === " = ") {
      if (isParam(operand)) {
        out.push({ kind: "eq", col, value: operand.value });
      } else if (isColumn(operand)) {
        out.push({ kind: "colEq", left: col, right: operand });
      }
    } else if (opText === " in " && Array.isArray(operand)) {
      out.push({
        kind: "in",
        col,
        values: operand.map((p) => (isParam(p) ? p.value : p)),
      });
    }
  }
  return out.length > 0 ? out : null;
}

/** One candidate row set: table object -> row (1 entry pre-join, 2 post). */
type Candidate = Map<FakeTable, FakeRow>;

function readColumn(candidate: Candidate, col: any): unknown {
  const prop = columnProp(col);
  if (prop === undefined) return undefined;
  return candidate.get(col.table as FakeTable)?.[prop];
}

class FakeSelect implements PromiseLike<FakeRow[]> {
  private primary?: FakeTable;
  private join?: { table: FakeTable; cond: unknown };
  private cond?: unknown;
  private orderCol?: any;
  private limitN?: number;

  constructor(
    private readonly db: FakeDrizzleDbImpl,
    private readonly projection?: Record<string, unknown>,
  ) {}

  from(table: FakeTable): this {
    this.primary = table;
    return this;
  }
  innerJoin(table: FakeTable, cond: unknown): this {
    this.join = { table, cond };
    return this;
  }
  where(cond: unknown): this {
    this.cond = cond;
    return this;
  }
  orderBy(col: any): this {
    this.orderCol = col;
    return this;
  }
  limit(n: number): this {
    this.limitN = n;
    return this;
  }

  then<TResult1 = FakeRow[], TResult2 = never>(
    onfulfilled?: ((value: FakeRow[]) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<FakeRow[]> {
    if (!this.primary) throw new Error("fake-drizzle: select() without from()");
    let candidates: Candidate[] = this.db
      .storeRows(this.primary)
      .map((row) => new Map<FakeTable, FakeRow>([[this.primary!, row]]));

    if (this.join) {
      const { table, cond } = this.join;
      const conds = this.db.parseOrFallback(cond);
      const colEqs = conds.filter(
        (c): c is ConditionColEq => c.kind === "colEq",
      );
      const joined: Candidate[] = [];
      for (const left of candidates) {
        for (const rightRow of this.db.storeRows(table)) {
          const candidate: Candidate = new Map(left);
          candidate.set(table, rightRow);
          const ok = colEqs.every(
            ({ left: l, right: r }) =>
              readColumn(candidate, l) === readColumn(candidate, r),
          );
          if (ok) joined.push(candidate);
        }
      }
      candidates = joined;
    }

    if (this.cond !== undefined) {
      const conds = this.db.parseOrFallback(this.cond);
      candidates = candidates.filter((candidate) =>
        conds.every((cond) => {
          if (cond.kind === "eq") {
            return readColumn(candidate, cond.col) === cond.value;
          }
          if (cond.kind === "in") {
            return cond.values.includes(readColumn(candidate, cond.col));
          }
          return true; // colEq predicates belong to join conditions
        }),
      );
    }

    if (this.orderCol !== undefined) {
      const col = this.orderCol;
      candidates = [...candidates].sort((a, b) => {
        const av = readColumn(a, col) as any;
        const bv = readColumn(b, col) as any;
        return av < bv ? -1 : av > bv ? 1 : 0;
      });
    }

    if (this.limitN !== undefined) candidates = candidates.slice(0, this.limitN);

    return candidates.map((candidate) => {
      if (!this.projection) return { ...candidate.get(this.primary!) };
      const out: FakeRow = {};
      for (const [key, ref] of Object.entries(this.projection)) {
        out[key] = isColumn(ref) ? readColumn(candidate, ref) : undefined;
      }
      return out;
    });
  }
}

class FakeInsert {
  constructor(
    private readonly db: FakeDrizzleDbImpl,
    private readonly table: FakeTable,
  ) {}

  /** drizzle's values() is the terminal of the chain; returns the mysql2
   * [ResultSetHeader, FieldPacket[]] tuple shape. */
  async values(rowOrRows: FakeRow | FakeRow[]): Promise<ResultTuple> {
    const rows = Array.isArray(rowOrRows) ? rowOrRows : [rowOrRows];
    const store = this.db.tableStore(this.table);
    let insertId = 0;
    for (const row of rows) {
      const stored: FakeRow = { ...row };
      if (stored.id == null) {
        stored.id = store.nextId;
      }
      store.nextId = Math.max(store.nextId, Number(stored.id) + 1);
      if (insertId === 0) insertId = Number(stored.id);
      store.rows.push(stored);
    }
    return [{ insertId, affectedRows: rows.length }, []];
  }
}

class FakeUpdate implements PromiseLike<ResultTuple> {
  private patch: FakeRow = {};
  private cond?: unknown;

  constructor(
    private readonly db: FakeDrizzleDbImpl,
    private readonly table: FakeTable,
  ) {}

  set(patch: FakeRow): this {
    this.patch = patch;
    return this;
  }
  where(cond: unknown): this {
    this.cond = cond;
    return this;
  }

  then<TResult1 = ResultTuple, TResult2 = never>(
    onfulfilled?: ((value: ResultTuple) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private async execute(): Promise<ResultTuple> {
    const conds = this.db.parseOrFallback(this.cond);
    let affectedRows = 0;
    for (const row of this.db.storeRows(this.table)) {
      const candidate: Candidate = new Map([[this.table, row]]);
      const ok = conds.every((cond) => {
        if (cond.kind === "eq") {
          return readColumn(candidate, cond.col) === cond.value;
        }
        if (cond.kind === "in") {
          return cond.values.includes(readColumn(candidate, cond.col));
        }
        return true;
      });
      if (ok) {
        Object.assign(row, this.patch);
        affectedRows += 1;
      }
    }
    return [{ insertId: 0, affectedRows }, []];
  }
}

class FakeDrizzleDbImpl implements FakeDrizzleDb {
  private readonly stores = new Map<FakeTable, TableStore>();
  readonly unparsedConditions: unknown[] = [];

  constructor(seedEntries?: Array<[FakeTable, FakeRow[]]>) {
    for (const [table, rows] of seedEntries ?? []) this.seed(table, rows);
  }

  tableStore(table: FakeTable): TableStore {
    let store = this.stores.get(table);
    if (!store) {
      store = { rows: [], nextId: 1 };
      this.stores.set(table, store);
    }
    return store;
  }

  storeRows(table: FakeTable): FakeRow[] {
    return this.tableStore(table).rows;
  }

  /** Parse a condition; on an unparseable (but present) condition, record
   * it and fall back to match-all (documented module limitation). */
  parseOrFallback(cond: unknown): Condition[] {
    const parsed = parseConditions(cond);
    if (parsed === null) {
      this.unparsedConditions.push(cond);
      return [];
    }
    return parsed;
  }

  select(projection?: Record<string, unknown>): FakeSelect {
    return new FakeSelect(this, projection);
  }
  insert(table: FakeTable): FakeInsert {
    return new FakeInsert(this, table);
  }
  update(table: FakeTable): FakeUpdate {
    return new FakeUpdate(this, table);
  }

  rows(table: FakeTable): FakeRow[] {
    return this.storeRows(table);
  }

  seed(table: FakeTable, rows: FakeRow[]): void {
    const store = this.tableStore(table);
    for (const row of rows) {
      const stored: FakeRow = { ...row };
      if (stored.id == null) stored.id = store.nextId;
      store.nextId = Math.max(store.nextId, Number(stored.id) + 1);
      store.rows.push(stored);
    }
  }

  /** Runs fn against a facade over the same stores. On throw, restores a
   * shallow per-table snapshot (rows inserted are dropped; patches applied
   * to pre-existing rows are rolled back at the top level only — nested
   * objects such as `raw` are shared, matching how services replace raw
   * wholesale via set()). */
  async transaction<T>(fn: (tx: FakeDrizzleDb) => Promise<T>): Promise<T> {
    const snapshot = new Map<FakeTable, TableStore>();
    for (const [table, store] of this.stores) {
      snapshot.set(table, {
        rows: store.rows.map((row) => ({ ...row })),
        nextId: store.nextId,
      });
    }
    try {
      return await fn(this);
    } catch (error) {
      this.stores.clear();
      for (const [table, store] of snapshot) this.stores.set(table, store);
      throw error;
    }
  }
}

/** Create an in-memory fake drizzle db. Seed with
 * `createFakeDrizzleDb([[trades, [...rows]], [tradeLegs, [...rows]]])` or
 * `db.seed(table, rows)`. Cast at the call site:
 * `db as unknown as MetalTradeContext["db"]`. */
export function createFakeDrizzleDb(
  seedEntries?: Array<[FakeTable, FakeRow[]]>,
): FakeDrizzleDb {
  return new FakeDrizzleDbImpl(seedEntries);
}
