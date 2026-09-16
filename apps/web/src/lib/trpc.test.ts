// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";

const fakeTrpc = vi.hoisted(() => ({
  access: { me: { query: vi.fn() } },
  accounts: { auth: { guestEnter: { mutate: vi.fn() } } },
  auth: { loginAs: { mutate: vi.fn() } },
}));

vi.mock("@trpc/client", () => ({
  createTRPCClient: vi.fn(() => fakeTrpc),
  httpBatchLink: vi.fn(() => ({})),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function loadSessionModule() {
  vi.resetModules();
  return import("./trpc");
}

beforeEach(() => {
  localStorage.clear();
  fakeTrpc.access.me.query.mockReset();
  fakeTrpc.accounts.auth.guestEnter.mutate.mockReset();
  fakeTrpc.auth.loginAs.mutate.mockReset();
});

describe("PC 身份切换竞态", () => {
  it("旧令牌校验迟到失败时保留并发写入的新正式令牌", async () => {
    const session = await loadSessionModule();
    const validation = deferred<never>();
    fakeTrpc.access.me.query.mockReturnValueOnce(validation.promise);
    fakeTrpc.accounts.auth.guestEnter.mutate.mockResolvedValue({ token: "mock-guest-should-not-run" });

    session.setToken("old-token");
    const guestAttempt = session.ensureGuestSession();
    await vi.waitFor(() => expect(fakeTrpc.access.me.query).toHaveBeenCalledTimes(1));

    session.setToken("new-formal-token");
    validation.reject(new Error("旧令牌已失效"));
    await guestAttempt;

    expect(session.getToken()).toBe("new-formal-token");
    expect(session.isGuest()).toBe(false);
    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();
  });

  it("正式登录期间丢弃已在途的游客响应，并原子清除游客标记", async () => {
    const session = await loadSessionModule();
    const guest = deferred<{ token: string }>();
    const login = deferred<{ token: string }>();
    fakeTrpc.accounts.auth.guestEnter.mutate.mockReturnValueOnce(guest.promise);
    fakeTrpc.auth.loginAs.mutate.mockReturnValueOnce(login.promise);

    const guestAttempt = session.ensureGuestSession();
    await vi.waitFor(() => expect(fakeTrpc.accounts.auth.guestEnter.mutate).toHaveBeenCalledTimes(1));
    const formalAttempt = session.ensureDemoLogin("MEM-001");
    await vi.waitFor(() => expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(1));

    guest.resolve({ token: "mock-late-guest-token" });
    await guestAttempt;
    expect(session.getToken()).toBeNull();
    expect(session.isGuest()).toBe(false);

    login.resolve({ token: "mock-formal-token" });
    await formalAttempt;
    expect(session.getToken()).toBe("mock-formal-token");
    expect(session.isGuest()).toBe(false);
  });

  it("正式登录已开始时不再发起新的游客请求", async () => {
    const session = await loadSessionModule();
    const login = deferred<{ token: string }>();
    fakeTrpc.auth.loginAs.mutate.mockReturnValueOnce(login.promise);

    const formalAttempt = session.ensureDemoLogin("MEM-001");
    await vi.waitFor(() => expect(fakeTrpc.auth.loginAs.mutate).toHaveBeenCalledTimes(1));
    await session.ensureGuestSession();
    expect(fakeTrpc.accounts.auth.guestEnter.mutate).not.toHaveBeenCalled();

    login.resolve({ token: "mock-formal-token" });
    await formalAttempt;
    expect(session.getToken()).toBe("mock-formal-token");
    expect(session.isGuest()).toBe(false);
  });

  it("正式令牌写入会清除既有游客标记", async () => {
    const session = await loadSessionModule();
    localStorage.setItem("workloom:workloom-im:b-pc:access-token", "mock-guest-token");
    localStorage.setItem("workloom:workloom-im:b-pc:guest", "1");
    fakeTrpc.auth.loginAs.mutate.mockResolvedValueOnce({ token: "mock-formal-token" });

    await session.ensureDemoLogin("MEM-001");

    expect(session.getToken()).toBe("mock-formal-token");
    expect(session.isGuest()).toBe(false);
  });
});
