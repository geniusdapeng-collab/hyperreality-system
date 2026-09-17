// hyperreality-system/engines/rendering-engine/rendering-engine.js
// Rendering Engine - 渲染引擎(Layer 3)
// 复用现有系统 Seedance 渲染核心,适配超级小香宝数据格式
// 版本:v1.0.0 | 日期:2026-06-08

const fs = require('fs');
const path = require('path');
const { GlobalNegativePromptInjector } = require('../../systems/global-negative-prompts');

// 复用现有系统的渲染提交核心
const RENDER_CORE_PATH = path.join(__dirname, '../../../scripts/render-submitter-core.js');
let RenderSubmitterCore;
try {
  RenderSubmitterCore = require(RENDER_CORE_PATH).RenderSubmitterCore;
} catch (e) {
  console.warn(`[RenderingEngine] 无法加载现有渲染核心: ${e.message}`);
  console.warn('[RenderingEngine] 将使用内置模拟模式');
}

class RenderingEngine {
  constructor(options = {}) {
    this.config = {
      apiKey: options.apiKey || process.env.VOLCENGINE_ARK_API_KEY,
      // 【v2.1.4-fix13-审计修复】endpoint 从环境变量读取,消除硬编码
      // 【P1-25 修复】默认改 null,未配置时显式报错,避免凭据泄漏+跨账号不可用
      endpoint: options.endpoint || process.env.VOLCENGINE_ARK_ENDPOINT || null,
      apiUrl: options.apiUrl || 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      maxConcurrent: options.maxConcurrent || 3,
      charactersDir: options.charactersDir || path.join(__dirname, '../../../characters'),
      outputDir: options.outputDir || process.env.OUTPUT_DIR || './output/super-mickey-output',
      ...options
    };

    this.logs = [];
    this.maxLogs = options.maxLogs || 10000; // 【v2.1.6-fix-bug54】限制最大日志数
    this.negativePromptInjector = new GlobalNegativePromptInjector();
    this._initSubmitter();
  }

  _initSubmitter() {
    if (RenderSubmitterCore) {
      this.submitter = new RenderSubmitterCore({
        apiKey: this.config.apiKey,
        endpoint: this.config.endpoint,
        apiUrl: this.config.apiUrl,
        charactersDir: this.config.charactersDir,
        outputDir: this.config.outputDir,
        maxConcurrent: this.config.maxConcurrent
      });
    } else {
      this.submitter = null;
    }
  }


  log(stage, message) {
    const entry = { stage, message, timestamp: Date.now() };
    this.logs.push(entry);
    // 🆕 限制日志数量
    if (this.logs.length > this.maxLogs) {
      this.logs = this.logs.slice(-Math.floor(this.maxLogs * 0.5)); // 截断一半
    }
    console.log(`[${stage}] ${message}`);
  }
  /**
   * 主入口:渲染镜头
   * @param {Array} prompts - 制作引擎输出的 Prompts 数组
   * @param {Object} options - { skipValidation, dryRun }
   * @returns {Object} { success, results, errors }
   */
  async render(prompts, options = {}) {
    const startTime = Date.now();
    this.log('RENDER', '🎬 RenderingEngine 启动 | Seedance API');
    this.log('RENDER', `   渲染: ${prompts.length} 个镜头`);
    this.log('RENDER', `   模式: ${this.submitter ? 'API' : '模拟'}`);
    this.log('RENDER', `   并发: ${this.config.maxConcurrent}`);

    const result = {
      success: false,
      submitted: 0,
      failed: 0,
      results: [],
      errors: [],
      timing: {}
    };

    // 【修复 P0-1】shots 提升到 try 外声明，catch 块才能安全引用
    let shots = [];

    try {
      // 检查 API 密钥和 endpoint
      if (!this.config.apiKey && !options.dryRun) {
        throw new Error('VOLCENGINE_ARK_API_KEY 未设置,无法渲染');
      }
      if (!this.config.endpoint && !options.dryRun) {
        throw new Error('VOLCENGINE_ARK_ENDPOINT 未设置,无法渲染');
      }

      // 【P1-24 修复】过滤空/无效 prompt,避免单坏镜头拖垮整批
      const validPrompts = prompts.filter(p => p && typeof p.prompt === 'string' && p.prompt.length > 50);
      if (validPrompts.length === 0) {
        throw new Error('无有效 prompt(所有 prompt 为空或长度不足50字符)');
      }
      if (validPrompts.length < prompts.length) {
        this.log('RENDER', `⚠️ 过滤掉 ${prompts.length - validPrompts.length} 个无效 prompt`);
      }

      // 构建渲染数据结构(兼容现有系统)
      shots = validPrompts.map(p => this._convertToShotFormat(p));

      // 🆕 【v2.1.6-fix】注入全局负面提示词
      for (const shot of shots) {
        const isOpening = shot.sceneType === 'opening' || shot.shotId?.match(/^(SC|S)00/);
        const negativePrompt = isOpening
          ? this.negativePromptInjector.generateForOpeningShot({ maxLength: 250 })
          : this.negativePromptInjector.generateForContentShot({ maxLength: 300 });
        shot.negativePrompt = negativePrompt;
        if (shot.prompt && !shot.prompt.includes('【负面约束】')) {
          // 【修复 P1-1】先为负面词预留空间截断主 prompt，再拼接，总量不超限
          shot.prompt = this._enforcePromptLimit(shot.prompt, negativePrompt.length + 1);
          shot.prompt = `${shot.prompt}\n${negativePrompt}`;
        } else if (shot.prompt) {
          shot.prompt = this._enforcePromptLimit(shot.prompt, 0);
        }
      }
      this.log('RENDER', `🛡️ 已注入全局负面提示词 (${shots.length} 镜头)`);

      // 【2026-07-17 修复】Layer 3 创意指数 → 渲染质感后缀（色彩/质感/特效/氛围）
      const creativeStyleSuffix = this._buildCreativeStyleSuffix(options.creativeIntensity);
      if (creativeStyleSuffix) {
        for (const shot of shots) {
          if (shot.prompt) shot.prompt = `${shot.prompt}\n${creativeStyleSuffix}`;
        }
        this.log('RENDER', `🎨 创意指数 ${options.creativeIntensity.intensity} 质感后缀已注入 (${shots.length} 镜头)`);
      }

      if (options.dryRun) {
        // 模拟模式:只验证不提交
        this.log('RENDER', '⚠️ 模拟模式:验证数据但不提交 API');
        result.results = shots.map(s => ({
          success: true,
          shotId: s.shotId,
          taskId: `SIMULATED-${s.shotId}`,
          status: 'simulated'
        }));
        result.submitted = shots.length;
        result.success = true;
      } else if (this.submitter) {
        // 真实 API 模式
        this.log('RENDER', '🔥 提交 Seedance API 渲染...');

        // 生成绑定清单(从 prompts 的 imageRefs 提取)
        const manifest = await this._generateBindingManifest(prompts); // 【v2.1.6-fix-bug53】改为await
        // 【P2-21 修复】改为异步 IO,避免阻塞事件循环
        const manifestPath = path.join(this.config.outputDir, 'binding-manifest.json');
        const fsp = require('fs').promises;
        try {
          await fsp.mkdir(this.config.outputDir, { recursive: true });
          await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
          const stats = await fsp.stat(manifestPath);
          if (stats.size === 0) {
            throw new Error(`清单文件写入后大小为0: ${manifestPath}`);
          }
        } catch (e) {
          throw new Error(`清单文件操作失败: ${e.message}`);
        }

        // 【P1-18 修复】给 submit 调用加外层超时，防止 Seedance 提交永久挂起
        // 【审计修复】固定2分钟与分批提交耗时模型不匹配:
        // submitter 按 maxConcurrent(默认3)分批，每批 = API往返 + 3秒间隔，
        // 镜头数较多时(如21镜头=7批)总耗时可超2分钟被误杀。改为按批次数动态计算。
        const batchCount = Math.ceil(shots.length / (this.config.maxConcurrent || 3));
        const SUBMIT_TIMEOUT = Math.max(120000, batchCount * 45000); // 每批预算45s(API+间隔)，下限2分钟
        const submitPromise = this.submitter.submit(shots, {
          bindingManifestPath: manifestPath,
          skipValidation: options.skipValidation
        });
        const { SafePromise } = require('../../utils/safe-promise');
        const submitResult = await SafePromise.withTimeout(
          submitPromise,
          SUBMIT_TIMEOUT,
          'RenderSubmit'
        ); // 【v2.1.6-fix-bug44+49】SafePromise 安全包装,防止悬空 rejection 和同步异常

        result.results = submitResult.results;
        result.submitted = submitResult.results.filter(r => r.success).length;
        result.failed = submitResult.results.filter(r => !r.success).length;
        result.success = submitResult.success;

      } else {
        // 【P0-10 修复】无提交器时显式失败,不再返回 mock 假成功
        this.log('RENDER', '❌ 渲染核心未加载(render-submitter-core.js缺失),无法真实渲染');
        result.success = false;
        result.degraded = true;
        result.mode = 'mock';
        result.errors.push('RenderSubmitterCore 未加载');
        result.results = shots.map(s => ({
          success: false,
          shotId: s.shotId,
          taskId: null,
          status: 'mock',
          error: '渲染核心未加载'
        }));
        result.submitted = 0;
        result.failed = shots.length;
        this.log('RENDER', `❌ 渲染失败: 0/${prompts.length} 成功 (RenderSubmitterCore未加载)`);
      }

      result.timing.total = Date.now() - startTime;
      this.log('RENDER', `✅ 渲染完成: ${result.submitted}/${prompts.length} 成功`);
      this.log('RENDER', `   耗时: ${result.timing.total}ms`);

    } catch (error) {
      // 【P2-22 修复】异常时填充失败 results,避免 failed=0 误导
      result.success = false;
      result.errors.push({ stage: 'RENDER', message: error.message });
      if (!result.results || result.results.length === 0) {
        result.results = (shots || []).map(s => ({
          shotId: s.shotId, success: false, status: 'error', error: error.message
        }));
        result.failed = result.results.length;
      }
      this.log('RENDER', `❌ 渲染失败: ${error.message}`);
    }

    return result;
  }

  /**
   * 【修复 P1-1】渲染边界长度强制：提交 Seedance 前的最后一道闸
   * 主 prompt 超限 → 按句边界截断（不硬切半个句子）；
   * 负面提示词注入前，先为主 prompt 预留负面词空间，确保总量不超限。
   */
  _enforcePromptLimit(prompt, reserveForNegative = 0) {
    const PromptLengthConfig = require('../../config/prompt-length.js');
    const hardMax = PromptLengthConfig.HARD_MAX - reserveForNegative;
    if (typeof prompt !== 'string' || prompt.length <= hardMax) return prompt;

    // 优先在句号/换行处截断，保住完整语义单元
    const window = prompt.slice(0, hardMax);
    const lastSentenceEnd = Math.max(
      window.lastIndexOf('。'),
      window.lastIndexOf('\n'),
      window.lastIndexOf('；')
    );
    const cutPoint = lastSentenceEnd > hardMax * 0.7 ? lastSentenceEnd + 1 : hardMax;
    const truncated = prompt.slice(0, cutPoint);
    this.log('RENDER', `⚠️ prompt 超限(${prompt.length}>${hardMax})，句边界截断至 ${truncated.length} 字符`);
    return truncated;
  }

  /**
   * 【2026-07-17 新增】把创意指数的渲染层配置编译为 prompt 质感后缀
   */
  _buildCreativeStyleSuffix(ci) {
    const r = ci?.engineConfigs?.renderingEngine;
    if (!r) return '';
    const parts = [];
    if (r.colorGrading === 'cinematic') parts.push('电影级色彩分级，冷暖对比，电影LUT质感');
    if (r.textureQuality === 'filmic') parts.push('胶片颗粒质感，光学柔光');
    if (r.vfxLevel === 'enhanced') parts.push('适度光效粒子，环境互动光斑');
    if (r.atmosphereLevel === 'rich') parts.push('丰富氛围层次，体积光与空气感');
    // 附带引擎生成的指令文本（去标签，截断防爆长度）
    if (r.creativeInstructions) {
      parts.push(String(r.creativeInstructions).replace(/\[\[?|\]\]?/g, '').slice(0, 200));
    }
    return parts.length ? `【风格质感】${parts.join('，')}` : '';
  }

  /**
   * 转换为现有系统兼容的 shot 格式
   * v6.37-P0: 适配新字段结构
   */
  _convertToShotFormat(prompt) {
    return {
      shotId: prompt.shotId,
      id: prompt.shotId, // 兼容现有系统
      prompt: prompt.prompt,
      duration: prompt.duration ?? 15, //
      isOpening: this._isOpeningShot(prompt), // 【v2.1.6-fix-bug55】配置化判定,支持多种格式
      // 定妆照引用(v6.37-P0: 优先读标准 portraits 字段,兜底 characterRef)
      // 【P2-20 修复】25字段标准是 portraits,characterRef 为兼容兜底
      referenceImages: this._parseCharacterRef(
        prompt.fields?.portraits || prompt.portraits || prompt.characterRef
      ),
      // 字符数
      promptLength: prompt.promptCharCount || (typeof prompt.prompt === 'string' ? prompt.prompt.length : 0) || 0,
      // v6.37-P0: 保留新字段用于调试
      mood: prompt.mood,
      camera: prompt.camera,
      lighting: prompt.lighting
    };
  }

  // 【v2.1.6-fix-bug55】配置化片头判定，支持多种ID格式
  _isOpeningShot(prompt) {
    const shotId = prompt.shotId || '';
    return /^(S00|SC00|OP|opening|intro)/i.test(shotId) ||
      prompt.sceneType === 'opening' ||
      prompt.isOpening === true;
  }

  /**
   * v6.37-P0: 解析 characterRef 字符串为 image 引用数组
   * 同时提取实际的目录名(从路径中)
   */
  _parseCharacterRef(characterRef) {
    if (!characterRef || characterRef === 'NONE') return [];

    const refs = [];
    // 【v2.1.6-fix-bug57】支持多种分隔符:; 、 ; 、 | 、 ,
    const parts = characterRef.split(/\s*[,;|]\s*/).filter(Boolean);

    for (const part of parts) {
      const match = part.match(/(.+?):\s*(.+)/);
      if (match) {
        const charName = match[1].trim();
        const paths = match[2].split(',').map(p => p.trim());

        paths.forEach(path => {
          const angleMatch = path.match(/-(\w+)\.png$/);
          // 从路径提取实际目录名,如 image://characters/example-character/front.png → example-character
          const dirMatch = path.match(/characters\/([^\/]+)\//);
          const charDir = dirMatch ? dirMatch[1] : charName;

          refs.push({
            characterId: charName,      // 显示名(如"示例角色")
            characterDir: charDir,      // 实际目录名(如"example-character")
            path: path,
            angle: angleMatch ? angleMatch[1] : 'unknown'
          });
        });
      }
    }

    return refs;
  }

  /**
   * 生成绑定清单
   * v1.2.7-fix-A2: 从 characterRef 解析 + 自动扫描 portraits 目录补全4角度
   */
  async _generateBindingManifest(prompts) { // 【v2.1.6-fix-bug53】改为async，避免同步IO阻塞事件循环
    const characters = {};
    const shots = [];
    const REQUIRED_ANGLES = ['front', 'threeQuarter', 'closeup', 'side'];

    for (const prompt of prompts) {
      const shotId = prompt.shotId;
      const charsInShot = [];

      // v1.2.7-fix-A1: 从 characterRef 解析,而非读不存在的 imageRefs
      const refs = this._parseCharacterRef(prompt.characterRef);

      for (const ref of refs) {
        const charId = ref.characterId;
        if (!charsInShot.includes(charId)) {
          charsInShot.push(charId);
        }

        if (!characters[charId]) {
          characters[charId] = {
            id: charId,
            name: charId,
            requiredAngles: REQUIRED_ANGLES,
            portraits: {}
          };

          // v1.2.7-fix-A2: 自动扫描 portraits 目录,补全4角度
          const charDirPath = path.join(this.config.charactersDir, ref.characterDir || charId);
          const portraitsDir = path.join(charDirPath, 'portraits');

          // 【v2.1.6-fix-bug53】异步IO，避免阻塞事件循环
          const fsp = require('fs').promises;
          try {
            await fsp.access(portraitsDir);
            const files = await fsp.readdir(portraitsDir);
            for (const angle of REQUIRED_ANGLES) {
              const matchedFile = files.find(f => f.includes(`-${angle}.png`) || f === `${angle}.png`);
              if (matchedFile) {
                const relativePath = path.join(ref.characterDir || charId, 'portraits', matchedFile);
                characters[charId].portraits[angle] = relativePath;
                console.log(`[BindingManifest] 角色 ${charId} ${angle}: ${relativePath}`);
              }
            }
          } catch (e) {
            // portraits 目录不存在，尝试直接查找 charDir
            try {
              await fsp.access(charDirPath);
              const files = (await fsp.readdir(charDirPath)).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
              for (const angle of REQUIRED_ANGLES) {
                const matchedFile = files.find(f => f.includes(`-${angle}.png`) || f === `${angle}.png`);
                if (matchedFile) {
                  const relativePath = path.join(ref.characterDir || charId, matchedFile);
                  characters[charId].portraits[angle] = relativePath;
                  console.log(`[BindingManifest] 角色 ${charId} ${angle}: ${relativePath}`);
                }
              }
            } catch (e2) {
              console.warn(`[BindingManifest] 读取角色目录失败: ${charDirPath} - ${e2.message}`);
            }
          }
        }

        // 添加从characterRef解析的路径(如果扫描没找到)
        if (ref.path && ref.angle) {
          if (!characters[charId].portraits[ref.angle]) {
            characters[charId].portraits[ref.angle] = ref.path;
          }
        }
      }

      shots.push({
        shotId,
        requiredCharacters: charsInShot,
        duration: prompt.duration ?? 15, //
        promptLength: prompt.promptCharCount || (typeof prompt.prompt === 'string' ? prompt.prompt.length : 0) || 0
      });
    }

    return {
      generatedAt: new Date().toISOString(),
      characters,
      shots
    };
  }

  /**
   * 查询渲染状态
   */
  /**
   * 查询渲染状态
   * v1.2.7-fix-A5: 修复端点和 taskId 传递
   */
  async queryStatus(taskIds) {
    if (!this.submitter || !taskIds || taskIds.length === 0) {
      return { status: 'unknown', tasks: [] };
    }

    // v1.2.7-fix-A5: 优先复用 submitter 的状态查询(如果存在)
    if (typeof this.submitter.queryStatus === 'function') {
      try {
        return await this.submitter.queryStatus(taskIds);
      } catch (e) {
        console.warn(`[RenderingEngine] submitter.queryStatus 失败: ${e.message}`);
      }
    }

    // v1.2.7-fix-A5: 直接调用 Seedance API 查询(修复端点和 taskId)
    // 查询端点 = 创建端点 + /{taskId}
    const baseUrl = this.config.apiUrl.replace(/\/$/, '');

    try {
      const results = await Promise.all(
        taskIds.map(async taskId => {
          try {
            // v1.2.7-fix-A5: taskId 拼入 URL,使用 GET 方法
            const queryUrl = `${baseUrl}/${taskId}`;
            const response = await fetch(queryUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json'
              },
              // 【P1-18 修复】添加 AbortSignal.timeout,防止 Seedance 查询永久挂起
              signal: AbortSignal.timeout(15000)
            });

            if (!response.ok) {
              const errText = await response.text().catch(() => '');
              return { taskId, status: 'error', error: `HTTP ${response.status}: ${errText.substring(0, 200)}` };
            }

            const data = await response.json();
            // Seedance API 返回的 status 字段
            const apiStatus = data.status || data.state || 'unknown';
            return { taskId, status: apiStatus, response: data };
          } catch (e) {
            return { taskId, status: 'error', error: e.message };
          }
        })
      );

      // 【P1-19 修复】任务状态判定支持更多终态变体,避免永久 in_progress
      const TERMINAL_OK = new Set(['succeeded', 'success', 'completed', 'done']);
      const TERMINAL_FAIL = new Set(['failed', 'failure', 'error', 'canceled', 'cancelled', 'timeout', 'rejected']);
      const isTerminal = (s) => TERMINAL_OK.has(s) || TERMINAL_FAIL.has(s);

      const allDone = results.every(r => isTerminal(r.status));
      const anyFailed = results.some(r => TERMINAL_FAIL.has(r.status));

      return {
        status: allDone ? (anyFailed ? 'partial_failure' : 'completed') : 'in_progress',
        tasks: results
      };
    } catch (e) {
      return { status: 'error', error: e.message, tasks: [] };
    }
  }

  /**
   * 生成渲染报告
   */
  generateReport(renderResult) {
    return {
      engine: 'RenderingEngine',
      version: '1.0.0',
      success: renderResult.success,
      summary: {
        total: renderResult.results.length,
        submitted: renderResult.submitted,
        failed: renderResult.failed,
        successRate: renderResult.results.length > 0
          ? Math.round((renderResult.submitted / renderResult.results.length) * 100)
          : 0
      },
      tasks: renderResult.results.map(r => ({
        shotId: r.shotId,
        taskId: r.taskId,
        status: r.status || (r.success ? 'submitted' : 'failed'),
        error: r.error || null
      })),
      timing: renderResult.timing,
      errors: renderResult.errors
    };
  }
}

module.exports = { RenderingEngine };