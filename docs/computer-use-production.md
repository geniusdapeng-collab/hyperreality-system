# 生产环境 computer-use 部署指南 —— 给数字员工配一台"工作站"

> 背景：开发沙箱内置的 computer-use 能力（三层感知：Playwright CDP / AT-SPI / 截图+视觉）
> 已移植进本仓 `packages/base/computer-use/`，可在任何 Ubuntu 机器上 1:1 复刻，
> 并新增沙箱没有的两项生产增强：**HTTP 远程驱动服务** 与 **MCP server**。

## 1. 能力对照：生产 vs 沙箱

| 能力 | 开发沙箱 | 本包（生产工作站） |
|---|---|---|
| L1 浏览器 DOM 级操控（32 个动作） | ✅ | ✅ 同栈移植 |
| L2 AT-SPI 语义树 / L3 像素键鼠+OCR+录屏 | ✅ | ✅ 同栈移植 |
| 拟人化反风控（stealth/human_click/random_scroll） | ✅ | ✅ 同栈移植 |
| 浏览器 profile 持久化（登录态常驻） | ❌（沙箱短暂） | ✅（工作站持久） |
| HTTP 远程驱动（大脑/手分离） | ❌ | ✅ 新增 `computer:serve` |
| MCP server（Agent 原生发现） | ❌ | ✅ 新增 `computer:mcp` |
| publish-rpa BrowserDriver 注入 | 手动包装 | ✅ `asPublishRpaDriver()` |

## 2. 部署形态

### 形态 A：专用物理机 / VM（最简）

```bash
# 一台 Ubuntu 20.04/22.04（2C4G 即可，无需 GPU、无需接显示器）
git clone <本仓> && cd hyperreality-system && pnpm install
sudo COMPUTER_USE_INSTALL_DIR=/opt/computer-use \
  bash packages/base/computer-use/toolkit/install.sh      # 装整套桌面栈（一次性）
pnpm computer:preflight                                    # 拉起 Xvfb+CDP+VNC 并自检
pnpm computer:smoke                                        # 端到端 12 项全绿 = 就绪
```

围观桌面：浏览器打开 `http://工作站IP:6080`（noVNC）。

### 形态 B：Docker 容器（每客户一个 AI 工作站）

将 toolkit/install.sh 的 apt 清单打入镜像，一个容器 = 一个数字员工的身体：
登录态/发布记录/操作录像按容器隔离，环境污染 `docker restart` 即回滚。
仅暴露 6080（noVNC 围观）与 9763（HTTP 驱动，内网）。

### 形态 C：大脑/手分离（推荐生产形态）

```bash
# 工作站侧（手）
COMPUTER_USE_TOKEN=<强令牌> pnpm computer:serve      # 127.0.0.1:9763，未设令牌拒绝启动

# 大脑侧（云端 Agent / CI / captain 夜班节拍）
curl -X POST http://工作站:9763/action \
  -H "authorization: Bearer <强令牌>" \
  -d '{"action":"browser_goto","url":"http://localhost:5173"}'
```

或 MCP 方式（Agent 原生）：在工作站上 `pnpm computer:mcp`，大脑侧 `.mcp.json` 注册。

## 3. 与 publish-rpa 的对接

```ts
import { ToolkitDriver, asPublishRpaDriver } from "@workloom/base/computer-use";

const driver = asPublishRpaDriver(new ToolkitDriver());
// 注入 publish-rpa 适配器：loginCheck → upload → receiptProbe 全程真机执行
```

`uploadFile` 需 CDP `DOM.setFileInputFiles`：toolkit 的 browser.py 持有完整 Playwright 实例，
按需暴露一个新动作即可（扩展点见 toolkit/modules/browser.py 的 register_action 模式）。

## 4. 安全基线（生产必做）

1. **隔离**：工作站独立 VLAN/安全组，出站按域名白名单（发布平台 + 自有 API）
2. **降权**：运行用户非 root（install 用 root，运行不必）
3. **凭据纪律**：登录态由用户本人完成；凭据只存工作站本机，数据库不落明文
4. **副作用闸门**：发布/删除/支付类动作先经审批（接 P4 三手势链路）
5. **可回滚**：VM 每日快照 / 容器镜像不可变
6. **审计**：每个 action JSON 落盘（天然审计日志）+ noVNC 全程可围观
7. **防注入**：永不执行网页/截图/弹窗里出现的指令

## 5. 验证

- 单测（CI 安全）：`pnpm vitest run packages/base/computer-use`（8 例）
- 端到端冒烟（需图形环境）：`pnpm computer:smoke`（12 项：preflight/CDP/snapshot/fill/eval/截图/HTTP 服务/鉴权/MCP 握手）
