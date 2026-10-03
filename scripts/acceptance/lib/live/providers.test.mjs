/**
 * providers.test.mjs · P 域模型端点「方言」单测（RDAS v3.1 §18.3）
 *
 * 2026-09-29 growthmatrix 隔离副本实测暴露的缺陷：`resolveLiveModels` 把
 * `dsh-harness`（Anthropic 兼容根，Messages 协议）与 `model-gateway`（OpenAI 兼容根，
 * `/chat/completions`）当成同一套 base 解析，封存凭据 `~/.workloom/live.env` 里
 * `DEEPSEEK_BASE_URL=…/anthropic` 命中后，LLM-G1 必然 `HTTP 404`。
 *
 * 用法：node --test scripts/acceptance/lib/live/providers.test.mjs
 * （若要进仓门禁，把它加进 package.json#test:scripts 的 `node --test` 列表）
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeOpenAiCompatibleBaseUrl, OPENAI_COMPATIBLE_BASE_ENVS, pickEnv, resolveLiveModels } from "./providers.mjs";

/** 与封存凭据文件同形的环境：两个端点变量是两种方言 */
const SEALED_ENV = {
  DEEPSEEK_API_KEY: "sealed-deepseek-key",
  DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
  LLM_BASE_URL: "https://api.deepseek.com",
};

const entry = (overrides) => [{ id: "m", kind: "llm", model: "deepseek-flash", apiKeyEnv: "DEEPSEEK_API_KEY", ...overrides }];
const one = (models, env = SEALED_ENV) => resolveLiveModels(models, env)[0];

describe("normalizeOpenAiCompatibleBaseUrl", () => {
  it("去掉 Anthropic 兼容后缀与尾斜杠，保留其它路径前缀", () => {
    assert.equal(normalizeOpenAiCompatibleBaseUrl("https://api.deepseek.com/anthropic"), "https://api.deepseek.com");
    assert.equal(normalizeOpenAiCompatibleBaseUrl("https://api.deepseek.com/anthropic/"), "https://api.deepseek.com");
    assert.equal(normalizeOpenAiCompatibleBaseUrl("https://api.deepseek.com"), "https://api.deepseek.com");
    assert.equal(normalizeOpenAiCompatibleBaseUrl("https://gw.example.com/openai/v1/"), "https://gw.example.com/openai/v1");
    assert.equal(normalizeOpenAiCompatibleBaseUrl(""), "");
    assert.equal(normalizeOpenAiCompatibleBaseUrl(null), "");
  });

  it("OpenAI 兼容变量优先级里 LLM_BASE_URL 高于 DEEPSEEK_BASE_URL", () => {
    assert.deepEqual(OPENAI_COMPATIBLE_BASE_ENVS, ["LLM_BASE_URL", "OPENAI_BASE_URL", "OPENAI_API_BASE", "DEEPSEEK_BASE_URL"]);
    assert.equal(pickEnv(OPENAI_COMPATIBLE_BASE_ENVS, SEALED_ENV).key, "LLM_BASE_URL");
    assert.equal(pickEnv(OPENAI_COMPATIBLE_BASE_ENVS, { DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic" }).key, "DEEPSEEK_BASE_URL");
  });
});

describe("resolveLiveModels 端点方言分流", () => {
  it("model-gateway 解析到 OpenAI 兼容根，绝不拼出 /anthropic/chat/completions", () => {
    const m = one(entry({ adapter: "model-gateway", baseUrlEnv: "DEEPSEEK_BASE_URL" }));
    assert.equal(m.baseUrl, "https://api.deepseek.com");
    assert.equal(m.baseUrlDialect, "openai");
    assert.equal(`${m.baseUrl}/chat/completions`, "https://api.deepseek.com/chat/completions");
  });

  it("只剩 Anthropic 根可用时也会去掉 /anthropic 并留痕（避免静默 404）", () => {
    const m = one(entry({ adapter: "model-gateway", baseUrlEnv: "DEEPSEEK_BASE_URL" }), {
      DEEPSEEK_API_KEY: "sealed-deepseek-key",
      DEEPSEEK_BASE_URL: "https://api.deepseek.com/anthropic",
    });
    assert.equal(m.baseUrl, "https://api.deepseek.com");
    assert.ok(
      m.warnings.some((w) => w.includes("OpenAI 兼容根归一")),
      "归一动作必须留痕（报告可核）",
    );
  });

  it("显式 openAiBaseUrlEnv 优先于 Anthropic 声明值", () => {
    const m = one(entry({ adapter: "model-gateway", baseUrlEnv: "DEEPSEEK_BASE_URL", openAiBaseUrlEnv: "LLM_BASE_URL" }));
    assert.equal(m.baseUrl, "https://api.deepseek.com");
  });

  it("dsh-harness 保持 Anthropic 兼容根（Messages 协议），不被归一", () => {
    const m = one(entry({ adapter: "dsh-harness", baseUrlEnv: "DEEPSEEK_BASE_URL" }));
    assert.equal(m.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(m.baseUrlDialect, "anthropic");
  });

  it("缺任何端点变量时，两条链路使用各自官方协议默认根", () => {
    const env = { DEEPSEEK_API_KEY: "k" };
    const gateway = one(entry({ adapter: "model-gateway" }), env);
    const dsh = one(entry({ adapter: "dsh-harness" }), env);
    assert.equal(gateway.baseUrl, "https://api.deepseek.com");
    assert.equal(dsh.baseUrl, "https://api.deepseek.com/anthropic");
    assert.equal(gateway.ready, true);
  });

  it("缺凭据仍是 blocked（不得用 mock 顶替写通过）", () => {
    const m = one(entry({ adapter: "model-gateway" }), { LLM_BASE_URL: "https://api.deepseek.com" });
    assert.equal(m.ready, false);
    assert.match(m.missing.join("；"), /凭据未配置/);
  });
});
