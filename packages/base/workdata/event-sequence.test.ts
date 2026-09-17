import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type pg from "pg";
import { reconcileEventStorageSequenceForSeed } from "./event-sequence.js";

interface StubState {
  maxSeq: string;
  lastValue: string;
  isCalled: boolean;
  failOnState?: boolean;
}

function stubClient(state: StubState): { client: Pick<pg.ClientBase, "query">; calls: Array<{ sql: string; values?: unknown[] }> } {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  const query = async (sql: string, values?: unknown[]) => {
    calls.push({ sql, values });
    if (sql.includes("COALESCE(MAX")) {
      if (state.failOnState) throw new Error("fixture failure");
      return { rows: [{ max_seq: state.maxSeq, last_value: state.lastValue, is_called: state.isCalled }] };
    }
    return { rows: [] };
  };
  return { client: { query } as unknown as Pick<pg.ClientBase, "query">, calls };
}

describe("事件账本物理序列修复", () => {
  it("表水位超前时只向前推进到最大已存序号之后", async () => {
    const { client, calls } = stubClient({ maxSeq: "12", lastValue: "3", isCalled: true });
    const result = await reconcileEventStorageSequenceForSeed(client);

    expect(result).toEqual({
      maxStoredSeq: 12n,
      nextBefore: 4n,
      nextAfter: 13n,
      repaired: true,
    });
    expect(calls.map((call) => call.sql)).toEqual([
      "BEGIN",
      "LOCK TABLE biz_events IN ACCESS EXCLUSIVE MODE",
      expect.stringContaining("COALESCE(MAX"),
      expect.stringContaining("setval"),
      "COMMIT",
    ]);
    expect(calls[3]?.values).toEqual(["12"]);
  });

  it("序列已经领先时不调用 setval，避免倒退或重复分配", async () => {
    const { client, calls } = stubClient({ maxSeq: "12", lastValue: "20", isCalled: true });
    const result = await reconcileEventStorageSequenceForSeed(client);

    expect(result).toEqual({
      maxStoredSeq: 12n,
      nextBefore: 21n,
      nextAfter: 21n,
      repaired: false,
    });
    expect(calls.some((call) => call.sql.includes("setval"))).toBe(false);
    expect(calls.at(-1)?.sql).toBe("COMMIT");
  });

  it("全新空账本保留序列初始值，首条事件仍从 1 开始", async () => {
    const { client, calls } = stubClient({ maxSeq: "0", lastValue: "1", isCalled: false });
    const result = await reconcileEventStorageSequenceForSeed(client);

    expect(result).toEqual({
      maxStoredSeq: 0n,
      nextBefore: 1n,
      nextAfter: 1n,
      repaired: false,
    });
    expect(calls.some((call) => call.sql.includes("setval"))).toBe(false);
  });

  it("读取失败时回滚维护事务", async () => {
    const { client, calls } = stubClient({ maxSeq: "0", lastValue: "1", isCalled: false, failOnState: true });
    await expect(reconcileEventStorageSequenceForSeed(client)).rejects.toThrow("fixture failure");
    expect(calls.at(-1)?.sql).toBe("ROLLBACK");
  });
});

const RUN_DB = process.env.RUN_DB_TESTS === "1" && Boolean(process.env.DATABASE_URL);
const dbDescribe = RUN_DB ? describe : describe.skip;

dbDescribe("事件账本物理序列修复 · PG 临时表", () => {
  let client: pg.Client;

  beforeAll(async () => {
    const pgModule = (await import("pg")).default;
    client = new pgModule.Client({ connectionString: process.env.DATABASE_URL });
    await client.connect();
    // 临时表/临时序列只在本连接可见，不读取、改写或删除用户事件。
    await client.query("CREATE TEMP TABLE biz_events (seq BIGSERIAL PRIMARY KEY)");
  });

  afterAll(async () => {
    await client?.end();
  });

  it("显式种子序号超前后可重跑修复，后续默认取号不撞主键", async () => {
    await client.query("INSERT INTO biz_events (seq) VALUES (7)");

    const first = await reconcileEventStorageSequenceForSeed(client);
    expect(first).toMatchObject({ maxStoredSeq: 7n, nextBefore: 1n, nextAfter: 8n, repaired: true });
    const inserted = await client.query<{ seq: string }>("INSERT INTO biz_events DEFAULT VALUES RETURNING seq");
    expect(inserted.rows[0]?.seq).toBe("8");

    const second = await reconcileEventStorageSequenceForSeed(client);
    expect(second).toMatchObject({ maxStoredSeq: 8n, nextBefore: 9n, nextAfter: 9n, repaired: false });
    const rerun = await client.query<{ seq: string }>("INSERT INTO biz_events DEFAULT VALUES RETURNING seq");
    expect(rerun.rows[0]?.seq).toBe("9");
  });
});
