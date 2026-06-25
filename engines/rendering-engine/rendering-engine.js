// hyperreality-system/engines/rendering-engine/rendering-engine.js
// Rendering Engine - 渲染引擎（Layer 3）
// 复用现有系统 Seedance 渲染核心，适配超现实系统数据格式
// 版本：v1.0.0 | 日期：2026-06-08

const fs = require('fs');
const path = require('path');

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
      // 【v2.1.4-fix13-审计修复】endpoint 从环境变量读取，消除硬编码
      endpoint: options.endpoint || process.env.VOLCENGINE_ARK_ENDPOINT || 'ep-20260518004622-jp46s',
      apiUrl: options.apiUrl || 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks',
      maxConcurrent: options.maxConcurrent || 3,
      charactersDir: options.charactersDir || path.join(__dirname, '../../../characters'),
      outputDir: options.outputDir || '/tmp/hyperreality-output',
      ...options
    };

    this.logs = [];
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
    console.log(`[${stage}] ${message}`);
  }

  /**
   * 主入口：渲染镜头
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

    try {
      // 检查 API 密钥
      if (!this.config.apiKey && !options.dryRun) {
        throw new Error('VOLCENGINE_ARK_API_KEY 未设置，无法渲染');
      }

      // 构建渲染数据结构（兼容现有系统）
      const shots = prompts.map(p => this._convertToShotFormat(p));

      if (options.dryRun) {
        // 模拟模式：只验证不提交
        this.log('RENDER', '⚠️ 模拟模式：验证数据但不提交 API');
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

        // 生成绑定清单（从 prompts 的 imageRefs 提取）
        const manifest = this._generateBindingManifest(prompts);
        const manifestPath = path.join(this.config.outputDir, 'binding-manifest.json');
        if (!fs.existsSync(this.config.outputDir)) {
          fs.mkdirSync(this.config.outputDir, { recursive: true });
        }
        fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

        // 调用现有系统的提交核心
        const submitResult = await this.submitter.submit(shots, {
          bindingManifestPath: manifestPath,
          skipValidation: options.skipValidation
        });

        result.results = submitResult.results;
        result.submitted = submitResult.results.filter(r => r.success).length;
        result.failed = submitResult.results.filter(r => !r.success).length;
        result.success = submitResult.success;

      } else {
        // 无提交器，模拟
        this.log('RENDER', '⚠️ 无提交器，使用模拟模式');
        result.results = shots.map(s => ({
          success: true,
          shotId: s.shotId,
          taskId: `MOCK-${s.shotId}`,
          status: 'mock'
        }));
        result.submitted = shots.length;
        result.success = true;
      }

      result.timing.total = Date.now() - startTime;
      this.log('RENDER', `✅ 渲染完成: ${result.submitted}/${prompts.length} 成功`);
      this.log('RENDER', `   耗时: ${result.timing.total}ms`);

    } catch (error) {
      result.success = false;
      result.errors.push({
        stage: 'RENDER',
        message: error.message
      });
      this.log('RENDER', `❌ 渲染失败: ${error.message}`);
    }

    return result;
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
      duration: prompt.duration || 12, // 使用实际时长
      isOpening: prompt.shotId === 'S00' || prompt.shotId === 'SC00',
      // 定妆照引用（v6.37-P0: 从 characterRef 解析）
      referenceImages: this._parseCharacterRef(prompt.characterRef),
      // 字符数
      promptLength: prompt.promptCharCount || prompt.length || 0,
      // v6.37-P0: 保留新字段用于调试
      mood: prompt.mood,
      camera: prompt.camera,
      lighting: prompt.lighting
    };
  }
  
  /**
   * v6.37-P0: 解析 characterRef 字符串为 image 引用数组
   * 同时提取实际的目录名（从路径中）
   */
  _parseCharacterRef(characterRef) {
    if (!characterRef || characterRef === 'NONE') return [];
    
    const refs = [];
    const parts = characterRef.split(' | ');
    
    for (const part of parts) {
      const match = part.match(/(.+?):\s*(.+)/);
      if (match) {
        const charName = match[1].trim();
        const paths = match[2].split(',').map(p => p.trim());
        
        paths.forEach(path => {
          const angleMatch = path.match(/-(\w+)\.png$/);
          // 从路径提取实际目录名，如 image://characters/chen-zhuo/front.png → chen-zhuo
          const dirMatch = path.match(/characters\/([^\/]+)\//);
          const charDir = dirMatch ? dirMatch[1] : charName;
          
          refs.push({
            characterId: charName,      // 显示名（如"示例角色"）
            characterDir: charDir,      // 实际目录名（如"chen-zhuo"）
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
  _generateBindingManifest(prompts) {
    const characters = {};
    const shots = [];
    const REQUIRED_ANGLES = ['front', 'threeQuarter', 'closeup', 'side'];

    for (const prompt of prompts) {
      const shotId = prompt.shotId;
      const charsInShot = [];

      // v1.2.7-fix-A1: 从 characterRef 解析，而非读不存在的 imageRefs
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

          // v1.2.7-fix-A2: 自动扫描 portraits 目录，补全4角度
          // 使用 characterDir（实际目录名，如 chen-zhuo）而非 characterId（显示名，如示例角色）
          const charDirPath = path.join(this.config.charactersDir, ref.characterDir || charId);
          const portraitsDir = path.join(charDirPath, 'portraits');
          
          if (fs.existsSync(portraitsDir)) {
            const files = fs.readdirSync(portraitsDir);
            for (const angle of REQUIRED_ANGLES) {
              // 查找匹配角度的文件（支持前缀，如 chen-zhuo-front.png）
              const matchedFile = files.find(f => f.includes(`-${angle}.png`) || f === `${angle}.png`);
              if (matchedFile) {
                // 生成包含角色目录的完整相对路径，如 chen-zhuo/portraits/chen-zhuo-front.png
                const relativePath = path.join(ref.characterDir || charId, 'portraits', matchedFile);
                characters[charId].portraits[angle] = relativePath;
                console.log(`[BindingManifest] 角色 ${charId} ${angle}: ${relativePath}`);
              }
            }
          }
          
          // 如果 portraits 目录不存在，尝试直接查找 charDir
          if (!fs.existsSync(portraitsDir)) {
            const files = fs.readdirSync(charDirPath).filter(f => f.endsWith('.png') || f.endsWith('.jpg'));
            for (const angle of REQUIRED_ANGLES) {
              const matchedFile = files.find(f => f.includes(`-${angle}.png`) || f === `${angle}.png`);
              if (matchedFile) {
                // 生成包含角色目录的完整相对路径
                const relativePath = path.join(ref.characterDir || charId, matchedFile);
                characters[charId].portraits[angle] = relativePath;
                console.log(`[BindingManifest] 角色 ${charId} ${angle}: ${relativePath}`);
              }
            }
          }
        }

        // 添加从characterRef解析的路径（如果扫描没找到）
        if (ref.path && ref.angle) {
          if (!characters[charId].portraits[ref.angle]) {
            characters[charId].portraits[ref.angle] = ref.path;
          }
        }
      }

      shots.push({
        shotId,
        requiredCharacters: charsInShot,
        duration: prompt.duration || 12,
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

    // v1.2.7-fix-A5: 优先复用 submitter 的状态查询（如果存在）
    if (typeof this.submitter.queryStatus === 'function') {
      try {
        return await this.submitter.queryStatus(taskIds);
      } catch (e) {
        console.warn(`[RenderingEngine] submitter.queryStatus 失败: ${e.message}`);
      }
    }

    // v1.2.7-fix-A5: 直接调用 Seedance API 查询（修复端点和 taskId）
    // 查询端点 = 创建端点 + /{taskId}
    const baseUrl = this.config.apiUrl.replace(/\/$/, '');

    try {
      const results = await Promise.all(
        taskIds.map(async taskId => {
          try {
            // v1.2.7-fix-A5: taskId 拼入 URL，使用 GET 方法
            const queryUrl = `${baseUrl}/${taskId}`;
            const response = await fetch(queryUrl, {
              method: 'GET',
              headers: {
                'Authorization': `Bearer ${this.config.apiKey}`,
                'Content-Type': 'application/json'
              }
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

      // 汇总状态
      const allDone = results.every(r => r.status === 'succeeded' || r.status === 'failed');
      const anyFailed = results.some(r => r.status === 'failed');

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
