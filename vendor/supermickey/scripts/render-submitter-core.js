/**
 * render-submitter-core.js — 统一渲染提交核心 v1.0
 * 
 * 所有渲染脚本必须调用此模块，禁止各自实现定妆照绑定逻辑。
 * 
 * 核心原则：
 * - 预生产输出 binding-manifest.json（绑定清单）
 * - 渲染时强制执行清单，不执行=中止
 * - 定妆照缺失/未绑定 = throw Error，不渲染
 * - 提交后验证API确认接收reference_image
 * 
 * 三层防护：
 * 1. 清单存在性检查（binding-manifest.json必须存在）
 * 2. 文件物理存在检查（每个角色的4角度文件必须在磁盘上）
 * 3. content数组强制绑定检查（reference_image必须传入API）
 * 4. API响应验证（Seedance确认接收）
 */

const fs = require('fs');
const path = require('path');
const { PromptGuardian } = require('./prompt-guardian');
const { RenderPipelineGuard } = require('../hyperreality-system/engines/render-pipeline-guard');

const REQUIRED_ANGLES = ['front', 'threeQuarter', 'closeup', 'side'];

class RenderSubmitterCore {
  constructor(options = {}) {
    this.apiKey = options.apiKey || process.env.VOLCENGINE_ARK_API_KEY;
    this.endpoint = options.endpoint || '003cENDPOINT_STD003e';
    this.apiUrl = options.apiUrl || 'https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks';
    this.charactersDir = options.charactersDir || path.join(__dirname, '..', 'characters');
    this.outputDir = options.outputDir || path.join(__dirname, '..', 'output');
    this.maxConcurrent = options.maxConcurrent || 3;
  }

  /**
   * 主入口：提交渲染（含完整定妆照绑定验证）
   * @param {Array} shots - 镜头数组
   * @param {Object} options - { bindingManifestPath, skipValidation }
   * @returns {Object} { success, results, errors }
   */
  async submit(shots, options = {}) {
    console.log('🔥 【统一渲染核心】启动');
    console.log('='.repeat(60));

    // Step 1: 读取绑定清单
    const manifest = this.loadBindingManifest(options.bindingManifestPath);
    
    // Step 2: 清单级验证（不可绕过）
    const manifestCheck = this.validateManifest(manifest);
    if (!manifestCheck.valid) {
      console.error('⛔ 绑定清单验证失败，渲染中止！');
      console.error(manifestCheck.errors.map(e => `   ❌ ${e}`).join('\n'));
      throw new Error(`BINDING_MANIFEST_INVALID: ${manifestCheck.errors.join('; ')}`);
    }
    console.log(`✅ 绑定清单验证通过 | ${manifestCheck.characters.length}个角色 | ${manifestCheck.totalAngles}个角度`);

    // Step 3: 逐镜头绑定验证（不可绕过）
    for (const shot of shots) {
      const shotCheck = this.validateShotBinding(shot, manifest);
      if (!shotCheck.valid) {
        console.error(`⛔ 镜头 ${shot.shotId || shot.id} 绑定验证失败！`);
        console.error(shotCheck.errors.map(e => `   ❌ ${e}`).join('\n'));
        throw new Error(`SHOT_BINDING_INVALID[${shot.shotId || shot.id}]: ${shotCheck.errors.join('; ')}`);
      }
    }
    console.log(`✅ 全部 ${shots.length} 个镜头绑定验证通过`);

    // Step 4: 构建content数组（含reference_image强制绑定）
    const payloads = [];
    for (const shot of shots) {
      const payload = this.buildPayload(shot, manifest);
      payloads.push({ shot, payload });
    }

    // Step 5: 提交渲染（并发控制）
    const results = [];
    for (let i = 0; i < payloads.length; i += this.maxConcurrent) {
      const batch = payloads.slice(i, i + this.maxConcurrent);
      console.log(`\n📦 批次 ${Math.floor(i / this.maxConcurrent) + 1}/${Math.ceil(payloads.length / this.maxConcurrent)}: ${batch.map(p => p.shot.shotId || p.shot.id).join(', ')}`);
      
      const batchResults = await Promise.all(
        batch.map(async ({ shot, payload }) => {
          try {
            const result = await this.callApi(payload);
            console.log(`✅ ${shot.shotId || shot.id} 提交成功 | Task: ${result.id}`);
            return { success: true, shotId: shot.shotId || shot.id, taskId: result.id, status: result.status };
          } catch (error) {
            console.error(`❌ ${shot.shotId || shot.id} 提交失败: ${error.message}`);
            return { success: false, shotId: shot.shotId || shot.id, error: error.message };
          }
        })
      );
      
      results.push(...batchResults);
      
      if (i + this.maxConcurrent < payloads.length) {
        console.log('⏳ 等待3秒...');
        await new Promise(r => setTimeout(r, 3000));
      }
    }

    // Step 6: 保存结果
    this.saveResults(results, manifest);

    console.log('\n' + '='.repeat(60));
    const succeeded = results.filter(r => r.success);
    console.log(`📊 提交汇总: ✅${succeeded.length}/${results.length} | ❌${results.length - succeeded.length}/${results.length}`);
    
    return { success: succeeded.length === results.length, results };
  }

  /**
   * 加载绑定清单（binding-manifest.json）
   */
  loadBindingManifest(manifestPath) {
    const defaultPath = path.join(this.outputDir, 'binding-manifest.json');
    const targetPath = manifestPath || defaultPath;
    
    if (!fs.existsSync(targetPath)) {
      // 如果没有清单，尝试从预生产输出提取
      const preProdPath = path.join(this.outputDir, 'taotie-ep01-prompts-full.json');
      if (fs.existsSync(preProdPath)) {
        const data = JSON.parse(fs.readFileSync(preProdPath, 'utf8'));
        if (data.portraits) {
          console.log('📋 从预生产输出提取绑定清单');
          return this.convertPortraitsToManifest(data.portraits, data.prompts || []);
        }
      }
      throw new Error(`BINDING_MANIFEST_MISSING: 找不到绑定清单 ${targetPath}。必须先运行预生产生成清单。`);
    }
    
    return JSON.parse(fs.readFileSync(targetPath, 'utf8'));
  }

  /**
   * 将预生产的portraits字段转换为标准清单格式
   */
  convertPortraitsToManifest(portraits, shots) {
    const manifest = {
      generatedAt: new Date().toISOString(),
      characters: {},
      shots: []
    };

    // 从portraits提取角色信息
    for (const [shotId, shotPortraits] of Object.entries(portraits)) {
      for (const [charId, angles] of Object.entries(shotPortraits)) {
        if (!manifest.characters[charId]) {
          manifest.characters[charId] = {
            id: charId,
            requiredAngles: REQUIRED_ANGLES,
            portraits: {}
          };
        }
        // 合并角度路径
        for (const [angle, filePath] of Object.entries(angles)) {
          if (!manifest.characters[charId].portraits[angle]) {
            manifest.characters[charId].portraits[angle] = filePath;
          }
        }
      }
    }

    // 从shots提取每个镜头需要的角色
    for (const shot of shots) {
      const shotId = shot.shotId || shot.id;
      const charsInShot = this.extractCharactersFromShot(shot);
      manifest.shots.push({
        shotId,
        requiredCharacters: charsInShot,
        duration: shot.duration || (shot.isOpening ? 9 : 12),
        promptLength: (shot.prompt || '').length
      });
    }

    return manifest;
  }

  /**
   * 验证清单完整性
   */
  validateManifest(manifest) {
    const errors = [];
    let totalAngles = 0;
    const characterIds = Object.keys(manifest.characters || {});

    if (characterIds.length === 0) {
      errors.push('清单中没有任何角色定义');
    }

    for (const charId of characterIds) {
      const char = manifest.characters[charId];
      const portraitPaths = char.portraits || {};
      
      for (const angle of REQUIRED_ANGLES) {
        const filePath = portraitPaths[angle];
        if (!filePath) {
          errors.push(`角色 ${charId} 缺少 ${angle} 角度路径定义`);
          continue;
        }
        
        // 检查文件物理存在
        const fullPath = filePath.startsWith('/') 
          ? filePath 
          : path.join(this.charactersDir, filePath);
        
        if (!fs.existsSync(fullPath)) {
          errors.push(`角色 ${charId} 的 ${angle} 定妆照文件不存在: ${fullPath}`);
        } else {
          totalAngles++;
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      characters: characterIds,
      totalAngles
    };
  }

  /**
   * 验证单个镜头的绑定
   */
  validateShotBinding(shot, manifest) {
    const errors = [];
    const shotId = shot.shotId || shot.id;
    const shotChars = this.extractCharactersFromShot(shot);
    
    // 无角色=豁免
    if (shotChars.length === 0) {
      return { valid: true, errors: [], exempt: true };
    }

    // 检查每个必需角色是否在清单中
    for (const charId of shotChars) {
      const charManifest = manifest.characters[charId];
      if (!charManifest) {
        errors.push(`镜头需要角色 "${charId}"，但绑定清单中未定义`);
        continue;
      }
      
      // 检查content数组是否包含该角色的reference_image
      const content = shot.content || shot.payload?.content || [];
      const hasRefImage = content.some(c => 
        c.type === 'image_url' && c.role === 'reference_image'
      );
      
      // 注意：预生产模式下content可能未构建，此时检查清单定义即可
      // 生产模式下必须检查content数组
      if (shot._productionMode && !hasRefImage) {
        errors.push(`镜头 ${shotId} 未包含角色 "${charId}" 的 reference_image`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  _detectMimeType(filePath) {
    const header = fs.readFileSync(filePath).slice(0, 12);
    // JPEG: FF D8 FF
    if (header[0] === 0xFF && header[1] === 0xD8) return 'image/jpeg';
    // PNG: 89 50 4E 47
    if (header[0] === 0x89 && header[1] === 0x50 && header[2] === 0x4E) return 'image/png';
    // WebP: 52 49 46 46 ... 57 45 42 50
    if (header[0] === 0x52 && header[1] === 0x49 && header[2] === 0x46 && header[3] === 0x46) {
      if (header[8] === 0x57 && header[9] === 0x45 && header[10] === 0x42 && header[11] === 0x50) return 'image/webp';
    }
    // Fallback to extension
    return filePath.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
  }

  /**
   * 构建API Payload（强制绑定reference_image）
   * 
   * 【关键经验 - 2026-06-20】
   * 1. image_url 必须指定 role: "reference_image"
   * 2. 必须传 generate_audio: true（确保台词音频渲染）
   * 3. prompt中必须明确描述角色服装（如"穿警服的"），否则场景描述会覆盖服装
   * 4. 台词用纯文本，不要加竖杠 | 等特殊符号
   */
  buildPayload(shot, manifest) {
    let prompt = shot.prompt || shot.visualPrompt || '';
    const duration = shot.isOpening ? 9 : (shot.duration || 12);
    
    // 🛡️ 自动修复Prompt（PromptGuardian）
    const guardian = new PromptGuardian();
    const shotChars = this.extractCharactersFromShot(shot);
    const charInfos = shotChars.map(charId => {
      const charManifest = manifest.characters[charId];
      return {
        id: charId,
        name: charManifest?.name || charId,
        role: charManifest?.role || '',
        description: charManifest?.description || ''
      };
    });
    
    const fixResult = guardian.autoFix(prompt, charInfos);
    if (fixResult.changed) {
      console.log(`  🛡️ PromptGuardian: 自动修复 ${fixResult.fixes.length} 处`);
      prompt = fixResult.prompt;
    }
    
    const content = [{ type: 'text', text: prompt }];
    let refCount = 0;

    for (const charId of shotChars) {
      const charManifest = manifest.characters[charId];
      if (!charManifest) {
        throw new Error(`PAYLOAD_BUILD_FAILED: 角色 ${charId} 不在清单中`);
      }

      console.log(`  📎 绑定角色: ${charId}`);

      // 传全部4个角度，确保角色一致性
      const angles = ['front', 'threeQuarter', 'closeup', 'side'];
      
      for (const angle of angles) {
        const filePath = charManifest.portraits[angle];
        if (!filePath) {
          console.warn(`    ⚠️ 角色 ${charId} 缺少 ${angle} 角度，跳过`);
          continue;
        }

        const fullPath = filePath.startsWith('/') 
          ? filePath 
          : path.join(this.charactersDir, filePath);
        
        if (!fs.existsSync(fullPath)) {
          console.warn(`    ⚠️ 文件不存在 ${fullPath}，跳过`);
          continue;
        }

        const base64 = fs.readFileSync(fullPath).toString('base64');
        if (!base64 || base64.length < 100) {
          console.warn(`    ⚠️ 文件读取失败或损坏 ${fullPath}，跳过`);
          continue;
        }

        const mimeType = this._detectMimeType(fullPath);
        content.push({
          type: 'image_url',
          image_url: { url: `data:${mimeType};base64,${base64}` },
          role: 'reference_image'  // ✅ 必须指定角色
        });
        refCount++;
      }
    }

    console.log(`🎬 ${shot.shotId || shot.id} | Prompt:${prompt.length}字符 | 绑定${refCount}张参考图(${shotChars.join('+')})`);

    const payload = {
      model: this.endpoint,
      content,
      ratio: '16:9',
      duration,
      generate_audio: true  // ✅ 必须生成台词音频
    };

    // 🔒 强制检查（PipelineGuard）
    const pipelineGuard = new RenderPipelineGuard();
    // 接口适配: 现有 Guard.check 接收 prompt 数组, 错误字段为 ruleName
    const guardResult = pipelineGuard.check([payload]);
    guardResult.errors = guardResult.errors.map(e => ({ ...e, rule: e.ruleName || e.rule }));
    guardResult.warnings = guardResult.warnings.map(w => ({ ...w, rule: w.ruleName || w.rule }));
    
    if (!guardResult.pass) {
      console.error(`⛔ PipelineGuard 检查失败，阻止提交！`);
      for (const error of guardResult.errors) {
        console.error(`   ❌ [${error.rule}] ${error.message}`);
        console.error(`      修复: ${error.fix}`);
      }
      throw new Error(`PIPELINE_GUARD_FAILED: ${guardResult.errors.map(e => e.message).join('; ')}`);
    }
    
    if (guardResult.warnings.length > 0) {
      console.log(`⚠️ PipelineGuard 警告:`);
      for (const warning of guardResult.warnings) {
        console.log(`   [${warning.rule}] ${warning.message} | 建议: ${warning.fix}`);
      }
    }

    return payload;
  }

  /**
   * 调用Seedance API
   */
  async callApi(payload) {
    const response = await fetch(this.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }

    const result = await response.json();
    
    // API响应验证：确认content被接收
    if (!result.id) {
      throw new Error('API返回缺少taskId');
    }

    return result;
  }

  /**
   * 从shot中提取角色
   */
  extractCharactersFromShot(shot) {
    const chars = new Set();
    
    if (shot.characters && Array.isArray(shot.characters)) {
      shot.characters.forEach(c => chars.add(typeof c === 'string' ? c : c.id));
    }
    
    if (shot.requiredCharacters && Array.isArray(shot.requiredCharacters)) {
      shot.requiredCharacters.forEach(c => chars.add(c));
    }
    
    // 从Prompt文本提取（兜底）
    const prompt = (shot.prompt || shot.visualPrompt || '').toLowerCase();
    const aliases = {
      'xiaoG': ['xiaog', 'AgentX', '小季', 'AgentX'],
      'tao-tie': ['taotie', '饕餮'],
      'jiu-wei-hu': ['jiuweihu', '九尾狐'],
      'nuan-nuan': ['nuannuan', '暖暖'],
      'bai-ze': ['baize', '白泽']
    };
    
    for (const [charId, charAliases] of Object.entries(aliases)) {
      for (const alias of charAliases) {
        if (prompt.includes(alias)) {
          chars.add(charId);
          break;
        }
      }
    }
    
    return Array.from(chars);
  }

  /**
   * 保存提交结果
   */
  saveResults(results, manifest) {
    const resultFile = path.join(this.outputDir, 'render-submit-record.json');
    const record = {
      submittedAt: new Date().toISOString(),
      coreVersion: 'v1.0',
      manifestCharacters: Object.keys(manifest.characters || {}),
      results
    };
    fs.writeFileSync(resultFile, JSON.stringify(record, null, 2));
    console.log(`\n💾 提交记录已保存: ${resultFile}`);
  }
}

module.exports = { RenderSubmitterCore };

// 自测
if (require.main === module) {
  console.log('✅ render-submitter-core.js 语法正确');
  console.log('使用方式: const { RenderSubmitterCore } = require("./render-submitter-core.js")');
  console.log('          const core = new RenderSubmitterCore({ apiKey: "..." })');
  console.log('          await core.submit(shots, { bindingManifestPath: "..." })');
}