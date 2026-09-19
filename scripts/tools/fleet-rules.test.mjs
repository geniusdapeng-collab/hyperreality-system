import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRepo, diffFleet, knownFleet, layerForFleetRepo } from "./fleet-rules.mjs";
import { injectGate } from "./provision-protocol.mjs";

describe("WorkLoom 仓识别", () => {
  it("按 manifest schemaVersion 识别", () => {
    const verdict = classifyRepo({ manifestText: JSON.stringify({ schemaVersion: "workloom.product/v1", productId: "p", role: "industry" }) });
    assert.equal(verdict.isWorkloom, true);
    assert.equal(verdict.productId, "p");
  });

  it("退化为 base-sync state 与 bundle schema 识别", () => {
    assert.equal(classifyRepo({ baseSyncText: JSON.stringify({ baseRepo: "workloom-ai/workloom-im" }) }).isWorkloom, true);
    assert.equal(classifyRepo({ bundleText: JSON.stringify({ schemaVersion: "workloom.bundle/v1" }) }).isWorkloom, true);
    assert.equal(classifyRepo({ manifestText: "{ not json" }).isWorkloom, false);
  });
});

describe("舰队差分", () => {
  it("区分已纳管 / 新仓 / 无关仓", () => {
    const known = knownFleet("workloom-ai/workloom-im", { children: [{ repo: "workloom-ai/workloom-hotel" }] });
    const diff = diffFleet({
      repos: ["workloom-ai/workloom-im", "workloom-ai/workloom-hotel", "workloom-ai/WorkLoom-growth", "other/x"],
      classifications: {
        "workloom-ai/workloom-im": { isWorkloom: true },
        "workloom-ai/workloom-hotel": { isWorkloom: true },
        "workloom-ai/WorkLoom-growth": { isWorkloom: true, reason: "product.manifest.json" },
        "other/x": { isWorkloom: false },
      },
      known,
    });
    assert.deepEqual(diff.known.sort(), ["workloom-ai/workloom-hotel", "workloom-ai/workloom-im"]);
    assert.deepEqual(diff.newWorkloom.map((item) => item.repo), ["workloom-ai/WorkLoom-growth"]);
    assert.deepEqual(diff.unrelated, ["other/x"]);
  });

  it("layer 解析大小写不敏感（新仓 WorkLoom-growth）", () => {
    const map = { "workloom-growth": "growth" };
    assert.equal(layerForFleetRepo("workloom-ai/WorkLoom-growth", map), "growth");
  });
});

describe("门禁注入", () => {
  it("已有 static-gate 时插入到行业包治理之前", () => {
    const yaml = "stages:\n    - name: 依赖安装（frozen lockfile）\n      script: x\n    - name: 产品身份与行业包治理\n      script: y\n";
    const { content, changed, mode } = injectGate(yaml);
    assert.equal(changed, true);
    assert.equal(mode, "static-gate");
    assert.ok(content.indexOf("协议门禁") < content.indexOf("产品身份与行业包治理"));
  });

  it("Python 栈（无该 stage）时新增独立流水线", () => {
    const yaml = ".py-gate: &py_gate\n  name: py-gate\n  stages:\n    - name: 测试\n      script: pytest\n\nmain:\n  push:\n    - *py_gate\n\n\"**\":\n  pull_request:\n    - *py_gate\n";
    const { content, changed, mode } = injectGate(yaml);
    assert.equal(changed, true);
    assert.equal(mode, "standalone");
    assert.ok(content.includes("*protocol_gate"));
  });

  it("已注入时幂等", () => {
    const yaml = "stages:\n    - name: 协议门禁（提交规范 + 并发冲突）\n      script: x\n";
    assert.equal(injectGate(yaml).changed, false);
  });
});

