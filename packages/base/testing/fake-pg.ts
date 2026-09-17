/**
 * testing · 内存假 pg（单测隔离用；不进生产出口）
 *
 * 纪律：只模拟「被测代码真实发出的 SQL」——按 SQL 文本（空白归一化）注册 handler，
 * 未注册的 SQL 直接抛错（防静默假阳性）。各包测试自行注册自己链路的 handler。
 */
export interface FakeRow {
  [key: string]: unknown;
}

export interface FakeResult {
  rows: FakeRow[];
  rowCount?: number | null;
}

export type FakeHandler = (params: unknown[], db: FakeDb, sql: string) => FakeResult;

export function normalizeSql(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export class FakeDb {
  readonly tables = new Map<string, FakeRow[]>();
  private readonly handlers: Array<{ pattern: RegExp; handle: FakeHandler }> = [];

  table(name: string): FakeRow[] {
    let t = this.tables.get(name);
    if (!t) { t = []; this.tables.set(name, t); }
    return t;
  }

  /** 注册 SQL handler（pattern 作用于空白归一化后的 SQL 文本） */
  on(pattern: RegExp, handle: FakeHandler): this {
    this.handlers.push({ pattern, handle });
    return this;
  }

  async query<T = FakeRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<{ rows: T[]; rowCount?: number | null }> {
    const sql = normalizeSql(text);
    for (const h of this.handlers) {
      if (h.pattern.test(sql)) return h.handle(params, this, sql) as { rows: T[]; rowCount?: number | null };
    }
    throw new Error(`FakeDb: 未模拟的 SQL → ${sql.slice(0, 120)}`);
  }
}

/** 自增 id 序列模拟（bigserial 列） */
export function nextSerial(db: FakeDb, table: string, field = "id"): number {
  const rows = db.table(table);
  const max = rows.reduce((m, r) => Math.max(m, Number(r[field] ?? 0)), 0);
  return max + 1;
}
