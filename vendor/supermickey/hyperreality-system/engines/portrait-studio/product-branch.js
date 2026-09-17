'use strict';

/**
 * ProductPortraitBranch — 商品定妆照分支链路（独立分支模块）
 * ------------------------------------------------------------
 * 商品定妆照与角色定妆照的根本差异：商品必须"真实"，
 * 禁止凭空生成外观（虚构商品是营销片翻车头号原因）。
 * 因此商品链路是一个三段式分支，强制从真实参考图出发：
 *
 *   阶段1 reference-search  联网搜索商品真实参考图
 *      - 构建搜索任务（商品名+类目+官方/实拍关键词）
 *      - api 模式：由外部搜索服务执行并返回图片 URL 列表
 *      - spec 模式：产出搜索任务清单，由执行方（Agent/人工）
 *        完成搜索并将参考图回填 manifest
 *
 *   阶段2 processing        参考图标准化处理管线
 *      - 抠图（主体分离，去除原始背景）
 *      - 白底替换（电商级纯白底基准图）
 *      - 光影统一（匹配短片视觉系统的光位/色温/对比度）
 *      - spec 模式产出逐步处理指令；api 模式接图像处理服务
 *
 *   阶段3 stylization       风格化定妆照生成
 *      - 以处理后的白底基准图为参考图（reference binding）
 *      - 按商品 5 视角包生成最终定妆照
 *      - 全程注入短片视觉系统锚点，保证与镜头提示词风格统一
 */

const { getProductViewPackage, getServiceViewPackage } = require('./angle-catalog');

// 参考图质量门槛：低于该数量的商品标记 needsMoreReference
const MIN_REFERENCE_IMAGES = 2;

// 服务/虚拟商品品类归类（v2.10.0：无实物外观的商品走品牌履约定妆链路）
const SERVICE_CATEGORY_PATTERN = /服务|课程|培训|咨询|旅游|本地生活|到店|家政|维修|金融|保险|医疗|医美|健身|教育|软件|SaaS|APP|App|应用|平台|办公|云/;

class ProductPortraitBranch {
  /**
   * @param {Object} options
   * @param {number} options.minReferenceImages 参考图最低数量（默认 2）
   */
  constructor(options = {}) {
    this.minReferenceImages = options.minReferenceImages || MIN_REFERENCE_IMAGES;
  }

  /**
   * 规划全部商品的定妆照任务
   * @param {Object} context
   * @param {Array}  context.products     商品定义数组 [{ id, name, category, sellingPoints, materials }]
   * @param {Object} context.visualStyle  视觉系统锚点
   * @param {Object} context.sceneContext 场景上下文（供"使用场景"视角取景）
   * @returns {Array} 商品定妆照任务数组
   */
  plan(context = {}) {
    const products = this._normalizeProducts(context.products || []);
    if (products.length === 0) return [];

    const visualStyle = context.visualStyle || {};
    const sceneContext = context.sceneContext || {};

    return products.map(p => this._buildProductTask(p, visualStyle, sceneContext));
  }

  // ========== 内部方法 ==========

  _normalizeProducts(products) {
    return products
      .map(p => {
        if (typeof p === 'string') return { id: p, name: p, category: '', sellingPoints: [], materials: [] };
        return {
          id: p.id || p.productId || p.name || '',
          name: p.name || p.id || p.productId || '',
          category: p.category || p.类目 || '',
          sellingPoints: p.sellingPoints || p.卖点 || [],
          materials: p.materials || (p.productHero && p.productHero.materials) || [],
          heroImageId: p.heroImageId || (p.productHero && p.productHero.heroImageId) || null,
          // 【SKU一致性】颜色/外观配置/型号变体透传（统一SKU锚点解析用，多源字段兼容）
          skuColor: p.skuColor || p.color || (p.productHero && (p.productHero.skuColor || p.productHero.color)) || '',
          appearance: p.appearance || p.trim || p.modelVariant || (p.productHero && p.productHero.appearance) || '',
          // 【珍妮纺织机对接】情报档案的商品图 manifest 透传（预填搜图阶段用）
          referenceManifest: p.referenceManifest || p.reference_manifest || null
        };
      })
      .filter(p => p.name);
  }

  /**
   * 【v2.10.0 新增】商品类型判定：服务/虚拟/软件类无实物外观，
   * 走"品牌视觉+履约场景"定妆链路（不强制抠图白底）
   */
  _productKind(product = {}) {
    if (product.assetType) {
      return /service|virtual|brand/i.test(product.assetType) ? 'service' : 'physical';
    }
    return SERVICE_CATEGORY_PATTERN.test(String(product.category || '')) ? 'service' : 'physical';
  }

  _buildProductTask(product, visualStyle, sceneContext) {
    const kind = this._productKind(product);
    return {
      taskType: 'product',
      productKind: kind, // physical 实物链路 | service 品牌履约链路
      productId: product.id,
      productName: product.name,
      heroImageId: product.heroImageId,
      branch: 'product-portrait-branch',
      stages: {
        referenceSearch: this._buildReferenceSearchStage(product, kind),
        processing: this._buildProcessingStage(product, visualStyle, kind),
        stylization: this._buildStylizationStage(product, visualStyle, sceneContext, kind)
      },
      status: 'pending'
    };
  }

  /**
   * 阶段1：联网搜索真实参考图（实物=商品实拍；服务=官方品牌物料/界面/门店/人员实拍）
   */
  _buildReferenceSearchStage(product, kind = 'physical') {
    const base = product.name;
    const category = product.category || '';
    const queries = kind === 'service'
      ? [
          `${base} 官方 品牌 物料`.trim(),
          `${base} 官方界面 截图`.trim(),
          `${base} 门店 实拍`.trim()
        ]
      : [
          `${base} ${category} 官方产品图`.trim(),
          `${base} 实拍 高清`.trim(),
          `${base} 白底图`.trim()
        ];
    // 【珍妮纺织机对接】情报档案已带商品图 manifest 时，预填参考图：
    // 免重复检索，执行方仅需核对图片真实性与型号一致性
    const manifest = product.referenceManifest || product.reference_manifest || null;
    const prefilled = manifest && Array.isArray(manifest.reference_images) && manifest.reference_images.length > 0
      ? manifest.reference_images
      : (manifest && Array.isArray(manifest.referenceImages) ? manifest.referenceImages : []);
    if (prefilled.length > 0) {
      return {
        stage: 'reference-search',
        executor: 'prefilled', // 情报档案预填，免外部检索
        prefilledFrom: manifest.product_id ? `商品情报档案 ${manifest.product_id}` : '商品情报档案',
        queries,
        minImages: this.minReferenceImages,
        requirements: [
          '核对预填参考图的真实性（禁止 AI 生成图/概念图冒充）',
          '系列化产品逐张核对型号标识与发售信息，剔除同系列旧款/近似款',
          '同SKU核验：全部参考图必须为同一颜色/外观配置SKU；官方图集含多SKU（多颜色/多配置版本）时按目标SKU过滤，剔除异色/异配置图，禁止异色SKU图进入生成参考',
          '预填图不足或核对不通过时，按 queries 补检'
        ],
        referenceImages: prefilled.map(img => ({
          url: img.url, source: img.source || '', angle: img.angle || '',
          localPath: img.localPath || null
        })),
        status: 'pending'
      };
    }
    return {
      stage: 'reference-search',
      executor: 'external', // spec 模式下由 Agent/人工执行联网搜索
      queries,
      minImages: this.minReferenceImages,
      requirements: [
        kind === 'service'
          ? '必须为官方真实物料（官网/官方社媒/官方App界面/门店实拍），禁止 AI 生成图/概念图冒充'
          : '必须为真实商品图，禁止 AI 生成图/概念图/渲染图冒充',
        '优先官方渠道图（官网/旗舰店/官方社媒）',
        '分辨率不低于 800px 短边',
        '覆盖至少两个不同角度/场景',
        // 【v2.8.1】系列化产品型号甄别：检索词必须含目标型号全名，
        // 逐张核对型号标识/发售时间，剔除同系列旧款/近似款
        '系列化产品必须甄别型号版本：检索词含目标型号全名，逐张核对型号标识与发售信息，剔除同系列旧款/近似款',
        // 【SKU一致性】参考图集必须同SKU：颜色/外观配置不一致的图一律剔除，
        // 否则生成模型会以异色参考图为视觉主导，压过文字锚点造成颜色漂移
        '同SKU核验：全部参考图必须为同一颜色/外观配置SKU；官方图集含多SKU（多颜色/多配置版本）时按目标SKU过滤，剔除异色/异配置图，禁止异色SKU图进入生成参考'
      ],
      referenceImages: [], // 执行后回填：[{ url, source, angle, localPath }]
      status: 'pending'
    };
  }

  /**
   * 阶段2：参考图标准化处理管线（实物=抠图/白底/光影；服务=裁切规范化/光影，不强制白底）
   */
  _buildProcessingStage(product, visualStyle, kind = 'physical') {
    const pipeline = kind === 'service'
      ? [
          {
            step: 'crop_normalize',
            name: '裁切规范化',
            instruction: `将${product.name}品牌物料/界面/门店图裁切为统一构图比例，主体居中，保留真实场景信息，禁止抠图去背景（服务场景需保留环境证据）`
          },
          {
            step: 'lighting_unify',
            name: '光影统一',
            instruction: this._buildLightingInstruction(visualStyle)
          }
        ]
      : [
          {
            step: 'matting',
            name: '主体抠图',
            instruction: `将${product.name}主体从参考图背景中精确分离，边缘无锯齿无残留，透明底 PNG；【v2.10.1】透明通道素材（带 alpha 的 PNG/WebP）须先按 alpha 合成白底再抠图，禁止直接读取 RGB 通道（透明区 RGB 为脏数据）`
          },
          {
            step: 'white_base',
            name: '白底替换',
            instruction: '替换为纯白背景（#FFFFFF），商品居中，占画面比例 70%-80%，电商基准图规范'
          },
          {
            step: 'lighting_unify',
            name: '光影统一',
            instruction: this._buildLightingInstruction(visualStyle)
          }
        ];
    return {
      stage: 'processing',
      dependsOn: 'reference-search',
      pipeline,
      outputBaseImage: null, // 执行后回填：处理完成的基准图路径
      status: 'pending'
    };
  }

  _buildLightingInstruction(visualStyle) {
    const parts = ['统一光影至短片视觉系统'];
    if (visualStyle.lighting) parts.push(`光位与质感对齐：${visualStyle.lighting}`);
    if (visualStyle.tone) parts.push(`色温色调对齐：${visualStyle.tone}`);
    parts.push('保留商品真实材质反射特性，禁止磨平材质细节');
    return parts.join('；');
  }

  /**
   * 阶段3：风格化定妆照生成（实物=商业摄影5视角；服务=品牌履约5视角）
   */
  _buildStylizationStage(product, visualStyle, sceneContext, kind = 'physical') {
    const views = kind === 'service' ? getServiceViewPackage() : getProductViewPackage();
    // 【SKU一致性】全角度统一SKU锚点：定妆照的 N 张图是同一商品的不同角度，
    // 颜色/外观配置/关键细节禁止任何漂移
    const skuAnchor = this._resolveSkuAnchor(product, kind);
    return {
      stage: 'stylization',
      dependsOn: 'processing',
      referenceBinding: 'outputBaseImage', // 强制绑定处理后的基准图，禁止无参考生成
      skuAnchor: skuAnchor.text, // 统一SKU锚点（闸机核验与生成后QA的判定基准）
      portraits: views.map(view => ({
        portraitId: `${product.id || product.name}-${view.id}`,
        view: view.id,
        viewName: view.name,
        purpose: view.purpose,
        priority: view.priority,
        prompt: this._buildProductPrompt(product, view, visualStyle, sceneContext, kind, skuAnchor),
        status: 'pending',
        outputFile: null
      })),
      status: 'pending'
    };
  }

  /**
   * 【SKU一致性】统一SKU锚点解析：颜色/外观配置/关键细节三元组。
   * 通用能力——任何商品（多颜色/多配置/系列化）都必须先把"唯一SKU"钉死，
   * 再允许分角度生成；锚点冲突时锚点优先于参考图。
   */
  _resolveSkuAnchor(product, kind = 'physical') {
    const parts = [];
    const color = product.skuColor || product.color || '';
    if (color) parts.push(`颜色=${color}`);
    const appearance = product.appearance || product.trim || product.modelVariant || '';
    if (appearance) parts.push(`外观配置=${appearance}`);
    const materials = (product.materials && product.materials.length) ? product.materials.join('、') : '';
    if (kind !== 'service' && materials) parts.push(`关键细节=${materials}`);
    if (kind === 'service' && materials) parts.push(`品牌识别=${materials}`);
    if (parts.length === 0) parts.push('以处理后基准图为唯一SKU外观来源');
    return {
      text: parts.join('；'),
      block: `SKU锚点：${parts.join('；')}；唯一SKU，全角度/全场景颜色与外观配置禁止漂移；` +
        `参考图与SKU锚点冲突时（如异色/异配置SKU图）以SKU锚点为准，禁止跟随参考图漂移`
    };
  }

  _buildProductPrompt(product, view, visualStyle, sceneContext, kind = 'physical', skuAnchor = null) {
    const sections = [
      `【商品定妆照】${product.name} — ${view.name}`,
      `商品：${product.name}${product.category ? `（${product.category}）` : ''}`
    ];
    if (kind === 'service') {
      const identifiers = (product.materials && product.materials.length) ? product.materials.join('、') : '品牌色/LOGO/官方界面';
      sections.push(`视觉识别锚点：${identifiers}`);
    } else {
      const materials = (product.materials && product.materials.length) ? product.materials.join('、') : '商品真实材质';
      sections.push(`材质锚点：${materials}`);
    }
    // 【SKU一致性】统一SKU锚点注入每张定妆照 prompt，异色/异配置漂移的硬性约束
    if (skuAnchor && skuAnchor.block) sections.push(skuAnchor.block);
    sections.push(`构图：${view.framing}`);
    if ((view.id === 'in_context' || view.id === 'service_scene' || view.id === 'user_context') && sceneContext.typicalScene) {
      sections.push(`场景：${sceneContext.typicalScene}`);
    }
    const styleParts = [];
    if (visualStyle.renderStyle) styleParts.push(visualStyle.renderStyle);
    if (visualStyle.tone) styleParts.push(`色调：${visualStyle.tone}`);
    if (visualStyle.lighting) styleParts.push(`光影：${visualStyle.lighting}`);
    if (styleParts.length) sections.push(`视觉系统：${styleParts.join('，')}`);
    sections.push(kind === 'service'
      ? '约束：以处理后的官方基准物料为唯一视觉参考，品牌视觉/界面/场景 100% 忠于官方实物，禁止虚构界面与品牌元素，商业摄影级品质'
      : '约束：以处理后的白底基准图为唯一外观参考，商品外观/LOGO/配色 100% 忠于实物，禁止虚构细节，商业摄影级品质');
    return sections.join('\n');
  }

  /**
   * 【v2.9.0 新增】风格化闸机（可执行，非声明）
   * stylization 启动前必须调用：真实参考图未回填/数量不足/来源未核验 → 阻断。
   * 此前 referenceBinding 只是 spec 文本声明，执行方跳过阶段1 凭空生成时
   * 没有任何代码能拦截——本闸机补上这一层。
   * @param {object} task plan() 产出的商品定妆照任务
   * @returns {{ready:boolean, blocked:boolean, reasons:string[]}}
   */
  checkStylizationReady(task = {}) {
    const reasons = [];
    const stages = task.stages || task; // 兼容 stages 嵌套与平铺两种任务结构
    const search = stages.referenceSearch || {};
    const images = Array.isArray(search.referenceImages) ? search.referenceImages : [];
    if (images.length < this.minReferenceImages) {
      reasons.push(`真实参考图不足：${images.length}/${this.minReferenceImages}（阶段1 reference-search 未完成回填）`);
    }
    const noSource = images.filter(i => !i.source);
    if (noSource.length > 0) {
      reasons.push(`${noSource.length} 张参考图缺来源标注（须可溯源至官网/官方社媒/官方旗舰店）`);
    }
    const aiLike = images.filter(i => i.aiGenerated === true);
    if (aiLike.length > 0) {
      reasons.push('参考图含 AI 生成图：禁止以生成图/概念图冒充真实商品图');
    }
    const processing = stages.processing || {};
    if (reasons.length === 0 && !processing.outputBaseImage) {
      reasons.push('阶段2 基准图未产出（outputBaseImage 未回填）：先完成抠图/白底/光影统一');
    }
    // 【SKU一致性闸机】stylization 必须带统一SKU锚点，且每张定妆照 prompt 必须绑定同一锚点。
    // 缺锚点 = 无法防止多SKU（颜色/外观配置）漂移，阻断。
    const stylization = stages.stylization || {};
    const anchor = stylization.skuAnchor || '';
    const portraits = Array.isArray(stylization.portraits) ? stylization.portraits : [];
    if (!anchor) {
      reasons.push('SKU锚点缺失：stylization 阶段未产出统一SKU锚点（颜色/外观配置/关键细节），无法防止多SKU漂移');
    } else {
      const unbound = portraits.filter(p => {
        const t = String(p.prompt || '');
        return !t.includes('SKU锚点') || !t.includes(anchor);
      });
      if (unbound.length > 0) {
        reasons.push(`${unbound.length} 张定妆照 prompt 未绑定统一SKU锚点（${unbound.map(p => p.portraitId || p.view).join('、')}），存在颜色/外观漂移风险`);
      }
    }
    return { ready: reasons.length === 0, blocked: reasons.length > 0, reasons };
  }

  /**
   * 【SKU一致性】生成后全量QA步骤：逐张（禁止抽样）核对主色与外观配置。
   * 定妆照 N 张 = 同一商品的不同角度；任何一张主色/配置偏离SKU锚点即判不合格，
   * 绑定SKU锚点重新生成，全部通过后方可交付。
   * @param {object} task plan() 产出的商品定妆照任务
   * @returns {object} consistency-qa 阶段任务（执行方生成完成后逐张执行）
   */
  buildConsistencyQaStep(task = {}) {
    const stages = task.stages || task;
    const stylization = stages.stylization || {};
    return {
      stage: 'consistency-qa',
      dependsOn: 'stylization',
      skuAnchor: stylization.skuAnchor || '',
      rules: [
        '逐张核对（禁止抽样）：每张定妆照的主色/外观配置/关键细节必须与SKU锚点一致',
        '主色偏离SKU锚点（如锚点为深色系而出图为红色系）→ 该张判不合格，绑定SKU锚点与基准图重新生成',
        '同一张图内出现多SKU特征混搭（颜色/轮毂/饰件不一致）→ 判不合格重新生成',
        '全部通过后定妆照环节方可交付；QA结果逐张记录，禁止只写"抽查通过"'
      ],
      status: 'pending'
    };
  }
}

module.exports = { ProductPortraitBranch, MIN_REFERENCE_IMAGES };
