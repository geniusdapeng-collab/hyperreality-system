import { describe, expect, it } from "vitest";
import {
  assertBundleCompatibility,
  INDUSTRY_CONTRACT_VERSION,
  isWorkLoomReservedRoute,
  parseBundleManifest,
  parseWorkforcePreset,
  parseWorkforcePresets,
  satisfiesCompatibility,
} from "./index.js";

const manifest = {
  schemaVersion: "workloom.bundle/v1",
  name: "@workloom/example",
  version: "1.2.3",
  workloom: {
    industry: "example",
    displayName: "示例行业",
    description: "用于验证契约",
    status: "stable",
    owner: "WorkLoom",
    compatibility: { base: ">=0.1.0 <1.0.0", ui: ">=0.1.0 <1.0.0", contract: "2.0.0" },
    provides: { presets: [], fences: [], skills: [], schemas: [], ui: [], serviceFront: [], seeds: [] },
    ui: {
      schemaVersion: "workloom.bundle.ui/v1",
      terminology: {}, navigation: { slots: [] }, home: { widgets: [] }, objects: [], workflows: [],
      serviceFront: { enabled: false, identityPolicy: "disabled", tabs: [], services: [] },
      theme: { brand: {} }, permissions: [], experiments: [],
    },
  },
};

describe("行业包契约", () => {
  it("破坏性约束收紧发布为 2.x，并拒绝伪装兼容旧契约的清单", () => {
    expect(INDUSTRY_CONTRACT_VERSION).toBe("2.0.0");
    const legacy = structuredClone(manifest) as Record<string, any>;
    legacy.workloom.compatibility.contract = "1.0.0";
    expect(() => parseBundleManifest(legacy)).toThrow();
  });

  it("公共页面、身份入口与历史 P 编号共用受保护路由事实源", () => {
    for (const route of ["/approvals", "/approvals/export", "/login", "/dev/tools", "/p24", "/p8/agent/1"]) {
      expect(isWorkLoomReservedRoute(route)).toBe(true);
    }
    expect(isWorkLoomReservedRoute("/p10")).toBe(false);
    expect(isWorkLoomReservedRoute("/hotel-operations")).toBe(false);
  });

  it("解析完整三端投影并拒绝重复语义路由", () => {
    expect(parseBundleManifest(manifest).workloom.industry).toBe("example");
    const invalid: Record<string, any> = structuredClone(manifest);
    invalid.workloom.ui.navigation.slots = [
      { capabilityId: "example.one", title: "入口一", route: "/industry/one", group: "operations", icon: "report", clients: ["pc"], permissions: [] },
      { capabilityId: "example.two", title: "入口二", route: "/industry/one", group: "operations", icon: "report", clients: ["pc"], permissions: [] },
    ];
    expect(() => parseBundleManifest(invalid)).toThrow();
  });

  it("客户端行业术语白名单只接受行业整词，并拒绝平台保留记号", () => {
    const withTerms = structuredClone(manifest) as Record<string, any>;
    withTerms.workloom.ui.safeTerms = ["WiFi", "OCC", "RevPAR", "Wi-Fi"];
    expect(parseBundleManifest(withTerms).workloom.ui.safeTerms).toEqual(["WiFi", "OCC", "RevPAR", "Wi-Fi"]);

    for (const term of ["SELECT", "orderStatus", "private_field", "A", "TOOLONGLATINTOKENVALUE", " 带空格"]) {
      const invalid = structuredClone(manifest) as Record<string, any>;
      invalid.workloom.ui.safeTerms = [term];
      expect(() => parseBundleManifest(invalid), `应拒绝 ${term}`).toThrow();
    }

    const tooMany = structuredClone(manifest) as Record<string, any>;
    tooMany.workloom.ui.safeTerms = Array.from({ length: 41 }, (_, i) => `TERM${i}`);
    expect(() => parseBundleManifest(tooMany)).toThrow();
  });

  it("兼容范围失败关闭", () => {
    expect(satisfiesCompatibility("0.3.0", ">=0.1.0 <1.0.0")).toBe(true);
    expect(satisfiesCompatibility("1.0.0", ">=0.1.0 <1.0.0")).toBe(false);
    expect(() => assertBundleCompatibility(parseBundleManifest(manifest), { base: "1.0.0", ui: "0.1.0" })).toThrow("兼容性校验失败");
  });

  it("组合主包只接受不重复、非自身的精确版本依赖", () => {
    const valid = structuredClone(manifest) as Record<string, any>;
    valid.workloom.dependencies = [
      { bundleId: "hotel", version: "1.0.0" },
      { bundleId: "ai-video", version: "2.1.0" },
    ];
    expect(parseBundleManifest(valid).workloom.dependencies).toEqual(valid.workloom.dependencies);

    const duplicate = structuredClone(valid) as Record<string, any>;
    duplicate.workloom.dependencies.push({ bundleId: "hotel", version: "2.0.0" });
    expect(() => parseBundleManifest(duplicate)).toThrow(/组合依赖重复/);

    const self = structuredClone(manifest) as Record<string, any>;
    self.workloom.dependencies = [{ bundleId: "example", version: "1.2.3" }];
    expect(() => parseBundleManifest(self)).toThrow(/不能依赖自身/);

    const range = structuredClone(manifest) as Record<string, any>;
    range.workloom.dependencies = [{ bundleId: "hotel", version: ">=1.0.0" }];
    expect(() => parseBundleManifest(range)).toThrow(/精确语义版本/);
  });

  it("通用资产槽显式覆盖管线、资料库、分群默认值与连接器，并拒绝目录或越界路径", () => {
    const valid = structuredClone(manifest) as Record<string, any>;
    Object.assign(valid.workloom.provides, {
      pipelines: ["pipelines/经营闭环.yml"],
      library: ["library/行业方法.md"],
      segmentDefaults: ["segment-defaults.yml"],
      connectors: ["connectors/connectors.json"],
    });
    expect(parseBundleManifest(valid).workloom.provides).toMatchObject(valid.workloom.provides);

    const directory = structuredClone(valid) as Record<string, any>;
    directory.workloom.provides.library = ["library/"];
    expect(() => parseBundleManifest(directory)).toThrow();

    const traversal = structuredClone(valid) as Record<string, any>;
    traversal.workloom.provides.connectors = ["../connectors.json"];
    expect(() => parseBundleManifest(traversal)).toThrow();
  });

  it("行业导航不能占用公共路由或借用其他包的能力与权限", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.permissions = ["hotel.orders.read"];
    invalid.workloom.ui.navigation.slots = [{
      capabilityId: "hotel.orders",
      title: "订单经营",
      route: "/approvals/export",
      group: "operations",
      icon: "document",
      clients: ["pc"],
      permissions: ["hotel.orders.read"],
    }];
    expect(() => parseBundleManifest(invalid)).toThrow(/自身命名空间|不得覆盖基座路由/);
  });

  it("行业导航只能引用共享分组与图标注册表", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.navigation.slots = [{
      capabilityId: "example.orders", title: "订单经营", route: "/orders",
      group: "横向顶栏", icon: "custom-svg", clients: ["pc"], permissions: [],
    }];
    expect(() => parseBundleManifest(invalid)).toThrow();
  });

  it("行业只能覆盖品牌白名单字段", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.theme.brand.danger = "#000";
    expect(() => parseBundleManifest(invalid)).toThrow();
  });

  it("服务前台适配器必须使用受约束标识，且未声明时保持通用基座", () => {
    expect(parseBundleManifest(manifest).workloom.ui.serviceFront.adapterId).toBeUndefined();
    const valid = structuredClone(manifest) as Record<string, any>;
    valid.workloom.ui.serviceFront.enabled = true;
    valid.workloom.ui.serviceFront.identityPolicy = "phone";
    valid.workloom.ui.serviceFront.adapterId = "example.service-front-v1";
    expect(parseBundleManifest(valid).workloom.ui.serviceFront.adapterId).toBe("example.service-front-v1");

    const invalid = structuredClone(valid) as Record<string, any>;
    invalid.workloom.ui.serviceFront.adapterId = "../../hotel";
    expect(() => parseBundleManifest(invalid)).toThrow(/能力标识格式不正确/);
  });

  it("巡检无基座默认；启用时必须显式声明受约束适配器标识", () => {
    expect(parseBundleManifest(manifest).workloom.ui.inspection).toBeUndefined();

    const enabled = structuredClone(manifest) as Record<string, any>;
    enabled.workloom.ui.inspection = { enabled: true, adapterId: "example.inspection-v1" };
    expect(parseBundleManifest(enabled).workloom.ui.inspection).toEqual({
      enabled: true,
      adapterId: "example.inspection-v1",
    });

    const missingAdapter = structuredClone(manifest) as Record<string, any>;
    missingAdapter.workloom.ui.inspection = { enabled: true };
    expect(() => parseBundleManifest(missingAdapter)).toThrow();

    const disabledWithAdapter = structuredClone(manifest) as Record<string, any>;
    disabledWithAdapter.workloom.ui.inspection = { enabled: false, adapterId: "example.inspection-v1" };
    expect(() => parseBundleManifest(disabledWithAdapter)).toThrow();
  });

  it("用户可见名称不能直接释放英文代码字段", () => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.navigation.slots = [{
      capabilityId: "example.orders", title: "order_status", route: "/orders",
      group: "operations", icon: "report", clients: ["pc"], permissions: [],
    }];
    expect(() => parseBundleManifest(invalid)).toThrow(/必须包含中文/);
  });

  it.each(["订单 workspace_id", "订单 workspaceId"])("含中文也不能夹带底层字段：%s", (title) => {
    const invalid = structuredClone(manifest) as Record<string, any>;
    invalid.workloom.ui.navigation.slots = [{
      capabilityId: "example.orders", title, route: "/orders",
      group: "operations", icon: "report", clients: ["pc"], permissions: [],
    }];
    expect(() => parseBundleManifest(invalid)).toThrow(/不得混入底层/);
  });
});

const workforcePreset = {
  preset_key: "operations-coordinator",
  name: "经营协调官",
  version: "v1.0",
  kind: "coordinator",
  description: "协调任务、证据与人工裁决。",
  readonly: false,
  night_shift: true,
  high_risk: false,
  fence_bindings: ["R1"],
  coverage: [{ eventPrefix: "operations.", label: "经营协调" }],
  skills: ["task-orchestration"],
  tools: [{ name: "operations.task.write", access: "write", desc: "写入受控任务" }],
  prompt: { role: "你是经营协调官。" },
};

describe("数字员工岗位契约", () => {
  it("解析完整岗位，并把历史 event_prefix 规范为统一字段", () => {
    const legacy = structuredClone(workforcePreset) as Record<string, any>;
    legacy.coverage = [{ event_prefix: "operations.", label: "经营协调" }];
    expect(parseWorkforcePreset(legacy).coverage).toEqual([
      { eventPrefix: "operations.", label: "经营协调" },
    ]);
  });

  it("缺少 coverage 时失败关闭", () => {
    const invalid = structuredClone(workforcePreset) as Record<string, any>;
    delete invalid.coverage;
    expect(() => parseWorkforcePreset(invalid)).toThrow(/coverage/);
  });

  it("缺少 night_shift 时失败关闭，不允许运行时猜默认值", () => {
    const invalid = structuredClone(workforcePreset) as Record<string, any>;
    delete invalid.night_shift;
    expect(() => parseWorkforcePreset(invalid)).toThrow(/night_shift/);
  });

  it("同一 Bundle 重复认领事件前缀时失败关闭", () => {
    const duplicate = structuredClone(workforcePreset) as Record<string, any>;
    duplicate.preset_key = "delivery-coordinator";
    expect(() => parseWorkforcePresets([workforcePreset, duplicate]))
      .toThrow(/事件前缀 operations\. 已由岗位 operations-coordinator 认领/);
  });

  it("写岗位必须同时具备围栏、覆盖与写工具，只读岗位不得带写工具", () => {
    const missingFence = structuredClone(workforcePreset) as Record<string, any>;
    missingFence.fence_bindings = [];
    expect(() => parseWorkforcePreset(missingFence)).toThrow(/必须绑定围栏/);

    const readOnly = structuredClone(workforcePreset) as Record<string, any>;
    readOnly.readonly = true;
    expect(() => parseWorkforcePreset(readOnly)).toThrow(/只读岗位不得声明写工具/);
  });
});
