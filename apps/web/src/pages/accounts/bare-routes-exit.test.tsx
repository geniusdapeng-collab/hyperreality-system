import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import InviteAccept from "./InviteAccept";
import Login from "./Login";

/**
 * bare 路由（不挂左侧主导航）必须自带可见返回/退出出口。
 * 台账《STATE-UI-CLOSE-AFFORDANCE》：打开后只能靠浏览器后退的页面按未完成处理。
 */
describe("bare 路由页面的可见出口", () => {
  it("登录页提供返回经营首页的可见出口（游客浮标直达路径）", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/login"]}>
        <Login />
      </MemoryRouter>,
    );
    expect(html).toContain("返回经营首页");
  });

  it("邀请接受页除登录入口外提供返回应用出口", () => {
    const html = renderToStaticMarkup(
      <MemoryRouter initialEntries={["/invite"]}>
        <InviteAccept />
      </MemoryRouter>,
    );
    expect(html).toContain("返回经营首页");
    expect(html).toContain("去登录");
  });

  it("开发矩阵页自带返回经营主页出口，且路由仍受双重开关守卫", () => {
    const matrix = readFileSync(new URL("../dev/DevMatrix.tsx", import.meta.url), "utf8");
    expect(matrix).toContain("返回经营主页");
    const app = readFileSync(new URL("../../App.tsx", import.meta.url), "utf8");
    expect(app).toContain("import.meta.env.DEV && import.meta.env.VITE_ENABLE_UI_DIAGNOSTICS === \"true\"");
  });
});
