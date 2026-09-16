import { describe, expect, it } from "vitest";
import { appRouter } from "./router.js";

describe("三端访问权威路由面", () => {
  it("挂载 access.me，且匿名请求失败关闭", async () => {
    const caller = appRouter.createCaller({
      session: null,
      identity: null,
      partnerIdentity: null,
      headers: new Headers(),
    });

    await expect(caller.access.me()).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });
});

