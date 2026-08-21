'use strict';

/**
 * JennyLoomEngine — 珍妮纺织机·数据挖掘引擎（总控）
 * ------------------------------------------------------------
 * SuperMickey 全链路的情报层（Stage -2），把散落的商品信息
 * 纺成结构化的《商品情报档案》，供下游各环节消费。
 *
 * 流水线（五 Agent 串行，信封传递，站站过闸）：
 *   A1 商品情报采集员  → 身份事实 + 商品图
 *   A2 用户评价矿工    → 称赞/吐槽/原话/场景
 *   A3 竞品侦察员      → 竞品画像 + 差异化空位
 *   A4 交叉验证官      → 置信度定级 + 无源清洗 + 优缺点签发
 *   A5 档案装订员      → 档案装订 + 六张摘要卡 + 落盘
 *
 * 双模运行：
 *   spec 模式：plan() 产出三份《任务书》，由执行方（Agent/人工）检索回填，
 *              再调 assemble() 完成验证与装订
 *   api 模式：  run() 全自动，需注入 executor(stage, plan) 异步函数执行检索
 *
 * 调用纪律：
 *   - 主链路松耦合：dossier.load() 命中即用；未命中才跑流水线
 *   - 永不阻塞主流程：本引擎任何异常都应被调用方捕获降级
 */

const Envelope = require('./pipeline/message-envelope');
const { EvidenceLedger } = require('./pipeline/evidence-ledger');
const { validateHandoff } = require('./pipeline/handoff-validator');
const { DossierStore } = require('./pipeline/dossier-store');
const { ProductInfoCollector } = require('./agents/product-info-collector');
const { ReviewMiner } = require('./agents/review-miner');
const { CompetitorScout } = require('./agents/competitor-scout');
const { CrossVerifier } = require('./agents/cross-verifier');
const { DossierBinder } = require('./agents/dossier-binder');

class JennyLoomEngine {
  /**
   * @param {object} [opts]
   * @param {string} [opts.mode] spec | api（默认 spec）
   * @param {string} [opts.storeRoot] 档案仓库根目录
   * @param {number} [opts.staleAfterDays] 档案过期天数（默认 30）
   * @param {number} [opts.competitorCap] 竞品上限（默认 3）
   * @param {function} [opts.executor] api 模式的检索执行器 async (stage, plan) => raw
   */
  constructor(opts = {}) {
    this.mode = opts.mode === 'api' ? 'api' : 'spec';
    this.store = new DossierStore({ root: opts.storeRoot, staleAfterDays: opts.staleAfterDays });
    this.executor = opts.executor || null;
    this.a1 = new ProductInfoCollector(opts);
    this.a2 = new ReviewMiner(opts);
    this.a3 = new CompetitorScout(opts);
    this.a4 = new CrossVerifier(opts);
    this.a5 = new DossierBinder({ store: this.store });
  }

  /** 由商品输入推导 product_id（确定性，同人同档） */
  static deriveProductId(input = {}) {
    const prefix = ProductInfoCollector.idPrefix(input);
    const tail = String(`${input.brand || ''}|${input.name || ''}|${input.model || ''}`)
      .split('').reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) >>> 0), 7).toString(36).toUpperCase();
    return `${prefix}-${tail}`.slice(0, 24);
  }

  /** 档案是否可用（存在且未过期）；forceRefresh 时视为不可用 */
  reusable(productId, forceRefresh = false) {
    if (forceRefresh || !this.store.exists(productId)) return false;
    const loaded = this.store.load(productId);
    return Boolean(loaded && !loaded.stale);
  }

  /**
   * Phase 1：产出采集任务书（A1/A2/A3 三份）
   * @param {object} input { name, brand?, category?, model? }
   */
  plan(input = {}) {
    if (!input.name) throw new Error('[JennyLoom] 缺商品名 name');
    const traceId = Envelope.newTraceId(JennyLoomEngine.deriveProductId(input));

    const planA1 = this.a1.plan(input);
    const planA2 = this.a2.plan({ ...input, sellingPointCandidates: input.sellingPointCandidates || [] });
    const planA3 = this.a3.plan({ name: input.name, category: input.category || '其他', price_band: input.price_band });

    return {
      trace_id: traceId,
      product_id: JennyLoomEngine.deriveProductId(input),
      mode: this.mode,
      plans: { A1: planA1, A2: planA2, A3: planA3 },
      fillback_note: '执行方按各任务书 fillback_format 回填后，调用 engine.assemble(trace_id, input, { A1: rawA1, A2: rawA2, A3: rawA3 })',
      discipline: planA1.discipline.concat(planA2.discipline, planA3.discipline)
    };
  }

  /**
   * Phase 2：回填数据 → 五站流水线 → 档案 + 摘要卡
   * @param {string} traceId
   * @param {object} input 原始商品输入
   * @param {object} rawByAgent { A1, A2, A3 } 执行方回填数据（允许缺站，缺站记 gap）
   */
  assemble(traceId, input = {}, rawByAgent = {}) {
    const ledger = new EvidenceLedger();
    const envelopes = [];
    const stageGaps = [];
    const errors = [];
    let prevChecksum = null;

    const pass = (stage, agent, payload) => {
      const env = Envelope.create({
        traceId, stage, agent, mode: this.mode, payload,
        evidenceRefs: ledger._entries.map(e => e.id),
        prevChecksum
      });
      const check = Envelope.verify(env);
      if (!check.ok) throw new Error(`[JennyLoom] 信封校验失败 @${stage}: ${check.issues.join('；')}`);
      const gate = validateHandoff(stage, payload);
      if (!gate.ok) throw new Error(`[JennyLoom] 出站闸机拦截 @${stage}: ${gate.hardFailures.join('；')}`);
      stageGaps.push(...gate.gaps);
      prevChecksum = env.checksum;
      envelopes.push({ stage, envelope_id: env.envelope_id, checksum: env.checksum, gaps: gate.gaps.length });
      return env;
    };

    // ===== A1 商品情报采集（硬依赖：身份事实缺失则全线停摆）=====
    let a1Out;
    try {
      a1Out = this.a1.distill(rawByAgent.A1 || {}, { input, ledger });
      if (!a1Out.identity.name) a1Out.identity.name = input.name;
      pass('A1_COLLECT', 'ProductInfoCollector', {
        identity: a1Out.identity,
        image_candidates: a1Out.image_candidates,
        official_selling_points: a1Out.identity.official_selling_points
      });
    } catch (e) {
      errors.push({ stage: 'A1_COLLECT', message: e.message, fatal: true });
      return { ok: false, trace_id: traceId, errors, envelopes };
    }

    // ===== A2 评价挖掘（软依赖：缺站记 gap 继续）=====
    let a2Out = { praise_points: [], pain_points: [], verbatim: [], scenarios: [], review_count: 0, gaps: ['A2 缺站：无评价数据'] };
    if (rawByAgent.A2) {
      try {
        a2Out = this.a2.distill(rawByAgent.A2, { input, ledger });
        pass('A2_MINE', 'ReviewMiner', a2Out);
      } catch (e) {
        errors.push({ stage: 'A2_MINE', message: e.message });
        a2Out.gaps = [`A2 执行异常：${e.message}`];
      }
    } else {
      stageGaps.push('[A2_MINE] 缺站：未回填评价数据');
    }

    // ===== A3 竞品侦察（软依赖）=====
    let a3Out = { competitors: [], differentiation: { our_opening: [], crowded_points: [], weakness_openings: [] }, gaps: ['A3 缺站：无竞品数据'] };
    if (rawByAgent.A3) {
      try {
        a3Out = this.a3.distill(rawByAgent.A3, {
          input: {
            category: a1Out.identity.category,
            price_band: a1Out.identity.price_band,
            sellingPointCandidates: input.sellingPointCandidates
              || a1Out.identity.official_selling_points.map(p => typeof p === 'string' ? p : p.point)
          },
          ledger
        });
        pass('A3_SCOUT', 'CompetitorScout', a3Out);
      } catch (e) {
        errors.push({ stage: 'A3_SCOUT', message: e.message });
        a3Out.gaps = [`A3 执行异常：${e.message}`];
      }
    } else {
      stageGaps.push('[A3_SCOUT] 缺站：未回填竞品数据');
    }

    // ===== A4 交叉验证（必经站）=====
    const a4Out = this.a4.verify({ a1: a1Out, a2: a2Out, a3: a3Out }, { ledger });
    pass('A4_VERIFY', 'CrossVerifier', {
      verified: a4Out.verified,
      pros: a4Out.pros,
      cons: a4Out.cons,
      verification_report: a4Out.verification_report
    });

    // ===== A5 装订（必经站）=====
    const productId = JennyLoomEngine.deriveProductId(input);
    const a5Out = this.a5.bind({
      productId,
      verified: a4Out.verified,
      pros: a4Out.pros,
      cons: a4Out.cons,
      visual: a1Out,
      ledger,
      reviewMeta: { review_count: a2Out.review_count, cleaned: a2Out.cleaned },
      gaps: [...a1Out.gaps, ...a2Out.gaps, ...a3Out.gaps, ...a4Out.gaps, ...stageGaps]
    });
    pass('A5_BIND', 'DossierBinder', { dossier: a5Out.dossier, cards: a5Out.cards });

    return {
      ok: true,
      trace_id: traceId,
      product_id: productId,
      dossier: a5Out.dossier,
      cards: a5Out.cards,
      saved: a5Out.saved,
      validation: a5Out.validation,
      verification_report: a4Out.verification_report,
      envelopes,
      errors
    };
  }

  /**
   * api 模式一键跑通（需注入 executor）
   * @param {object} input 商品输入
   */
  async run(input = {}) {
    if (this.mode !== 'api' || typeof this.executor !== 'function') {
      throw new Error('[JennyLoom] api 模式运行需注入 executor(stage, plan) 执行器');
    }
    const planOut = this.plan(input);
    const rawByAgent = {};
    for (const stage of ['A1', 'A2', 'A3']) {
      try {
        rawByAgent[stage] = await this.executor(stage, planOut.plans[stage]);
      } catch (e) {
        // 单站执行失败不阻断（assemble 内部有缺站逻辑）
        rawByAgent[stage] = null;
      }
    }
    return this.assemble(planOut.trace_id, input, rawByAgent);
  }

  /**
   * 主链路入口：复用优先，未命中返回 null 由调用方决定跑流水线
   * @returns {{dossier, cards, stale, reused} | null}
   */
  consume(input = {}, opts = {}) {
    const productId = opts.productId || JennyLoomEngine.deriveProductId(input);
    const loaded = this.store.load(productId);
    if (!loaded) return null;
    const SummaryCards = require('./contracts/summary-cards');
    return {
      dossier: loaded.dossier,
      cards: SummaryCards.makeAllCards(loaded.dossier),
      stale: loaded.stale,
      reused: true
    };
  }
}

module.exports = { JennyLoomEngine };
