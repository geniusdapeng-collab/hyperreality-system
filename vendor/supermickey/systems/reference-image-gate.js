/**
 * reference-image-gate.js — 定妆照强制提交闸机 v1.1
 * 
 * 最严格的硬拦截机制 + 多角色全角度支持：
 * - 含角色的镜头，不传对应角色的全部定妆照 → 完全无法提交渲染
 * - 支持任意数量角色同框（小G+N神兽 / N神兽 / 任意组合）
 * - 每个角色必须传全部4角度（front, threeQuarter, closeup, side）
 * - 三层防护：预生产预警 → 渲染前置硬拦截 → API最终防线
 */

const fs = require('fs');
const path = require('path');

// 全局常量
// v3.0-fix: 扩展为8角度定妆照支持
const REQUIRED_ANGLES = ['front', 'threeQuarter', 'closeup', 'side'];
const V3_ANGLES = ['front_fullbody', 'three_quarter', 'face_closeup', 'side_profile', 'back_fullbody', 'action_running', 'action_sitting', 'hand_detail'];
const ALL_VALID_ANGLES = [...REQUIRED_ANGLES, ...V3_ANGLES];

class ReferenceImageGate {
  constructor(options = {}) {
    this.mode = options.mode || 'pre-production'; // 'production' | 'pre-production'
    this.requiredCharacters = options.requiredCharacters || [];
    this.charactersDir = options.charactersDir || path.join(__dirname, '..', 'characters');
    
    // 硬拦截规则（不可协商）
    this.rules = {
      roleRequired: true,           // 必须有 role: reference_image
      minimumAngles: ['front'],      // 至少包含 front 角度
      validImage: true,              // 图片必须有效
      characterIdMatch: true,        // 角色ID必须匹配
      seedanceBindFormat: true,      // v6.2-patch120: 必须使用 @image 格式绑定
      productionMode: 'HARD_BLOCK',  // 生产模式：硬拦截
      preProductionMode: 'WARN_AND_LOG' // 预生产模式：警告+记录
    };
    
    // 必需角度（优先级排序）
    // v3.0-fix: 支持新旧两种角度格式
    this.requiredAngles = ['front', 'threeQuarter', 'closeup', 'side', 'front_fullbody', 'three_quarter', 'face_closeup', 'side_profile', 'back_fullbody', 'action_running', 'action_sitting', 'hand_detail'];
  }

  /**
   * 主入口：验证 shots 数组
   * @param {Array} shots - 镜头数组
   * @returns {Object} { passed, errors, warnings, details }
   */
  validate(shots) {
    const errors = [];
    const warnings = [];
    const details = [];
    
    for (const shot of shots) {
      const result = this.validateShot(shot);
      
      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings);
      }
      details.push({
        shotId: shot.id || shot.shotId,
        ...result
      });
    }
    
    const passed = errors.length === 0;
    
    return {
      passed,
      errors,
      warnings,
      details,
      summary: this.generateSummary(passed, errors, warnings)
    };
  }

  /**
   * 验证单个镜头
   */
  validateShot(shot) {
    const errors = [];
    const warnings = [];
    const characterChecks = [];
    
    // 1. 识别镜头中的角色
    const charactersInShot = this.extractCharacters(shot);
    
    // 2. 无角色的镜头 → 豁免
    if (charactersInShot.length === 0) {
      return {
        passed: true,
        errors,
        warnings: [{ type: 'exempt', message: '纯环境镜头，无角色，跳过定妆照检查' }],
        characterChecks
      };
    }
    
    // 3. 检查 content 数组 + 绑定定妆照字段（v6.6.3-fix: 支持中文标准字段）
    const content = shot.content || shot.prompt?.content || [];
    let referenceImages = this.extractReferenceImages(content);
    
    // 补充从 绑定定妆照 字段提取（Stage 16 标准化输出格式）
    if (Array.isArray(shot.绑定定妆照) && shot.绑定定妆照.length > 0) {
      const fromBind = shot.绑定定妆照.map(item => ({
        role: 'reference_image',
        image_url: { url: item.路径 || item.path || item.url || '' },
        characterId: item.角色ID || item.characterId || item.character || '',
        angle: item.角度 || item.angle || '',
        valid: !!(item.路径 || item.path || item.url)
      }));
      referenceImages = referenceImages.concat(fromBind);
    }
    
    // 4. 逐角色检查
    for (const charId of charactersInShot) {
      const check = this.validateCharacter(charId, referenceImages, shot);
      characterChecks.push(check);
      
      if (!check.passed) {
        const blockMsg = this.generateBlockMessage(shot, charId, check);
        
        if (this.mode === 'production') {
          // 生产模式：硬拦截
          errors.push({
            type: 'HARD_BLOCK',
            shotId: shot.id || shot.shotId,
            characterId: charId,
            message: blockMsg,
            fixSteps: check.fixSteps
          });
        } else {
          // 预生产模式：警告
          warnings.push({
            type: 'WARN',
            shotId: shot.id || shot.shotId,
            characterId: charId,
            message: blockMsg,
            fixSteps: check.fixSteps
          });
        }
      }
    }
    
    return {
      passed: errors.length === 0,
      errors,
      warnings,
      characterChecks
    };
  }

  /**
   * 角色ID归一化：处理脚本生成阶段与角色系统阶段的ID不一致问题
   * 例如：taotie → tao-tie
   */
  normalizeCharId(id) {
    if (!id) return id;
    const idLower = String(id).toLowerCase();
    const map = { 'taotie': 'tao-tie' };
    return map[idLower] || idLower;
  }

  /**
   * 从镜头中提取角色ID
   */
  extractCharacters(shot) {
    const characters = new Set();
    
    // 从 shot.characters 字段提取
    if (shot.characters && Array.isArray(shot.characters)) {
      shot.characters.forEach(c => characters.add(typeof c === 'string' ? c : c.id));
    }
    
    // 从 shot.characterRoles 提取
    if (shot.characterRoles && Array.isArray(shot.characterRoles)) {
      shot.characterRoles.forEach(c => characters.add(typeof c === 'string' ? c : c.id));
    }
    
    // 从 Prompt 文本中提取（兜底）
    const promptText = this.getPromptText(shot);
    if (promptText) {
      this.requiredCharacters.forEach(charId => {
        if (promptText.includes(charId) || promptText.includes(this.camelToKebab(charId))) {
          characters.add(charId);
        }
      });
    }
    
    // v6.7.0-fix: 归一化角色ID，消除脚本阶段与角色系统阶段的不一致
    return Array.from(characters).map(c => this.normalizeCharId(c));
  }

  /**
   * 从 content 数组中提取 reference_image
   */
  extractReferenceImages(content) {
    if (!Array.isArray(content)) return [];
    
    return content
      .filter(item => item.role === 'reference_image')
      .map(item => ({
        role: item.role,
        url: item.image_url?.url || '',
        // 🔥 v6.2-patch50-fix: 优先使用显式声明的characterId和angle
        characterId: item.characterId || item.image_url?.characterId || this.extractCharacterIdFromUrl(item.image_url?.url || ''),
        angle: item.angle || undefined,
        valid: this.isValidImageUrl(item.image_url?.url)
      }));
  }

  /**
   * 验证单个角色的定妆照
   * 核心逻辑：检查 content 数组中是否包含该角色的全部角度 reference_image
   * v3.0-fix: 支持新旧两种角度格式（旧4角度 + 新8角度）
   * 物理文件检查降级为警告（不拦截）
   */
  validateCharacter(charId, referenceImages, shot) {
    const issues = [];
    const fixSteps = [];
    
    // v6.5.0-fix: promptText 声明移到顶部，避免在 if 分支未声明时引用错误
    const promptText = this.getPromptText(shot) || '';
    
    // 1. 检查是否有该角色的 reference_image
    const normalizedCharId = this.normalizeCharId(charId);
    const charRefs = referenceImages.filter(ref => 
      this.normalizeCharId(ref.characterId) === normalizedCharId
    );
    
    if (charRefs.length === 0) {
      issues.push(`缺少角色 "${charId}" 的 reference_image`);
      fixSteps.push(`确认 content 数组中包含 ${charId} 的 reference_image`);
    } else {
      // 2. 检查 reference_image 是否有效
      const validRefs = charRefs.filter(ref => ref.valid);
      if (validRefs.length === 0) {
        issues.push(`角色 "${charId}" 的 reference_image 无效（base64为空或损坏）`);
        fixSteps.push(`重新缓存角色 ${charId} 的定妆照`);
      }
      
      // 3. 【v6.2-patch120】Seedance 2.0 角色绑定规范检查
      const hasSeedanceBind = promptText.includes('@image');
      const hasOldFormat = promptText.includes('图片1') || promptText.includes('图片2') || promptText.includes('严格参考');
      
      if (!hasSeedanceBind) {
        if (hasOldFormat) {
          issues.push(`角色 "${charId}" 使用旧版绑定格式（"图片1"），必须更新为 Seedance 2.0 官方 @image 格式`);
          fixSteps.push(`将 Prompt 中的 "图片1" 改为 "@image1"，并确保格式为：@image1 作为${charId}角色形象参考`);
        } else {
          issues.push(`角色 "${charId}" 缺少 Seedance 2.0 官方 @image 绑定引用`);
          fixSteps.push(`在 Prompt 中显式添加：@image1 作为${charId}角色形象参考`);
        }
      }
      
      // 4. 【核心】检查该角色的角度覆盖
      // v3.0-fix: 支持新旧两种角度格式
      const charRefAngles = this.extractReferenceImageAngles(charId, referenceImages);
      
      // 检查是否覆盖旧4角度
      const missingOldAngles = REQUIRED_ANGLES.filter(a => !charRefAngles.includes(a));
      // 检查是否覆盖新8角度（至少要有4个核心角度）
      const v3CoreAngles = ['front_fullbody', 'three_quarter', 'face_closeup', 'side_profile'];
      const hasV3Core = v3CoreAngles.filter(a => charRefAngles.includes(a)).length >= 4;
      
      // 如果旧4角度不全，且新8角度核心4个也不全，则报错
      if (missingOldAngles.length > 0 && !hasV3Core) {
        issues.push(`角色 "${charId}" 缺少角度: ${missingOldAngles.join(', ')} (或新8角度核心4个)`);
        fixSteps.push(`为 ${charId} 传入缺失角度: ${missingOldAngles.join(', ')}`);
      }
    }
    
    // 4. 【警告】检查物理文件是否存在（不拦截，仅提示）
    const missingFileAngles = [];
    for (const angle of REQUIRED_ANGLES) {
      if (!this.checkAngleExists(charId, angle)) {
        missingFileAngles.push(angle);
      }
    }
    
    return {
      characterId: charId,
      passed: issues.length === 0,
      issues,
      fixSteps,
      referenceCount: charRefs.length,
      seedanceBindFormat: {
        hasSeedanceBind: promptText.includes('@image'),
        hasOldFormat: promptText.includes('图片1') || promptText.includes('图片2'),
        promptText: promptText.substring(0, 200) + '...'  // 记录前200字符用于调试
      },
      missingFileAngles: missingFileAngles.length > 0 ? missingFileAngles : undefined
    };
  }

  /**
   * 检查指定角度的定妆照文件是否存在
   * 支持多种命名格式：
   * - 旧4角度: xiaoG-front.png, xiaoG-threeQuarter.png, xiaoG-closeup.png, xiaoG-side.png
   * - 新8角度: xiaoG-portrait-front_fullbody.png, xiaoG-portrait-three_quarter.png, etc.
   * - 混合: xiaoG-front_fullbody.png, xiaoG-three_quarter.png (无前缀)
   */
  checkAngleExists(charId, angle) {
    const portraitDir = path.join(this.charactersDir, charId, 'portraits');
    
    // v6.6.3-fix: 递归检查子目录（uniform/casual等风格子目录）
    const checkDir = (dir) => {
      // 1. 精确匹配旧格式
      const exactNames = [
        `${charId}-${angle}.png`,
        `${charId}-${angle}.jpg`,
        `${this.camelToKebab(charId)}-${angle}.png`,
        `${this.camelToKebab(charId)}-${angle}.jpg`
      ];
      
      for (const name of exactNames) {
        if (fs.existsSync(path.join(dir, name))) {
          return true;
        }
      }
      
      // 2. 新8角度格式（带-portrait-前缀）
      const v3PortraitNames = [
        `${charId}-portrait-${angle}.png`,
        `${charId}-portrait-${angle}.jpg`,
        `${this.camelToKebab(charId)}-portrait-${angle}.png`,
        `${this.camelToKebab(charId)}-portrait-${angle}.jpg`
      ];
      
      for (const name of v3PortraitNames) {
        if (fs.existsSync(path.join(dir, name))) {
          return true;
        }
      }
      
      // 3. 新8角度格式（无前缀）
      const v3Names = [
        `${charId}-${angle}_fullbody.png`,
        `${charId}-${angle}_profile.png`,
        `${charId}-${angle}_closeup.png`,
        `${charId}-${angle}_running.png`,
        `${charId}-${angle}_sitting.png`,
        `${charId}-${angle}_detail.png`,
        `${this.camelToKebab(charId)}-${angle}_fullbody.png`,
        `${this.camelToKebab(charId)}-${angle}_profile.png`,
        `${this.camelToKebab(charId)}-${angle}_closeup.png`,
        `${this.camelToKebab(charId)}-${angle}_running.png`,
        `${this.camelToKebab(charId)}-${angle}_sitting.png`,
        `${this.camelToKebab(charId)}-${angle}_detail.png`
      ];
      
      for (const name of v3Names) {
        if (fs.existsSync(path.join(dir, name))) {
          return true;
        }
      }
      
      // 4. 模糊匹配：任何包含角度关键词的文件
      try {
        const files = fs.readdirSync(dir);
        
        // 旧格式模糊匹配
        const pattern = new RegExp(`${charId}.*-${angle}\.(png|jpg|jpeg)`, 'i');
        const kebabPattern = new RegExp(`${this.camelToKebab(charId)}.*-${angle}\.(png|jpg|jpeg)`, 'i');
        
        // 新格式模糊匹配（支持 -portrait- 前缀）
        const v3Patterns = [
          new RegExp(`${charId}.*-portrait-${angle}\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_fullbody\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_quarter\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_closeup\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_profile\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_running\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_sitting\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${charId}.*-${angle}_detail\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-portrait-${angle}\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_fullbody\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_quarter\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_closeup\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_profile\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_running\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_sitting\.(png|jpg|jpeg)`, 'i'),
          new RegExp(`${this.camelToKebab(charId)}.*-${angle}_detail\.(png|jpg|jpeg)`, 'i')
        ];
        
        for (const file of files) {
          if (pattern.test(file) || kebabPattern.test(file)) {
            return true;
          }
          for (const v3Pattern of v3Patterns) {
            if (v3Pattern.test(file)) {
              return true;
            }
          }
        }
      } catch (e) {
        // 目录不存在或无法读取
      }
      
      return false;
    };
    
    // 先检查主目录
    if (checkDir(portraitDir)) return true;
    
    // v6.6.3-fix: 递归检查子目录（uniform/casual等）
    try {
      const entries = fs.readdirSync(portraitDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const subDir = path.join(portraitDir, entry.name);
          if (checkDir(subDir)) return true;
        }
      }
    } catch (e) {
      // 目录不存在
    }
    
    return false;
  }

  /**
   * 检查缺少哪些角度
   * v3.0-fix: 支持新旧两种角度格式
   */
  checkMissingAngles(charId) {
    const missing = [];
    // 检查旧4角度
    for (const angle of REQUIRED_ANGLES) {
      if (!this.checkAngleExists(charId, angle)) {
        missing.push(angle);
      }
    }
    // 如果旧4角度全缺，检查新8角度核心4个
    if (missing.length === 4) {
      const v3Core = ['front_fullbody', 'three_quarter', 'face_closeup', 'side_profile'];
      let hasV3 = false;
      for (const angle of v3Core) {
        if (this.checkAngleExists(charId, angle)) {
          hasV3 = true;
          break;
        }
      }
      if (hasV3) {
        // 有新8角度，清空旧角度缺失（新旧二选一）
        return [];
      }
    }
    return missing;
  }

  /**
   * 从 reference_images 中提取指定角色的角度列表
   * 🔥 v6.2-patch50-fix: 优先使用显式声明的 angle 字段
   * 其次才从URL中解析（兼容旧数据 + 新8角度）
   */
  extractReferenceImageAngles(charId, referenceImages) {
    const angles = [];
    const normalizedCharId = this.normalizeCharId(charId);
    for (const ref of referenceImages) {
      const refCharId = this.normalizeCharId(ref.characterId || this.extractCharacterIdFromUrl(ref.url));
      if (refCharId === normalizedCharId) {
        // 🔥 优先使用显式声明的 angle 字段
        if (ref.angle) {
          angles.push(ref.angle);
        } else {
          // 兜底：从 URL 中提取角度信息（支持旧4角度 + 新8角度）
          const angleMatch = ref.url.match(/-(front|threeQuarter|closeup|side)\./);
          const v3AngleMatch = ref.url.match(/-(front_fullbody|three_quarter|face_closeup|side_profile|back_fullbody|action_running|action_sitting|hand_detail)\./);
          if (angleMatch) {
            angles.push(angleMatch[1]);
          }
          if (v3AngleMatch) {
            angles.push(v3AngleMatch[1]);
          }
        }
      }
    }
    return angles;
  }
  extractCharacterIdFromUrl(url) {
    if (!url) return '';
    
    // 从 data:image/png;base64,xxx 格式中提取
    // 或者从文件路径中提取
    const match = url.match(/characters\/([^\/]+)\/portraits/);
    if (match) return match[1];
    
    // 从文件名中提取（支持 xiaoG-cg-v3-front 这类命名）
    // 优先匹配已知角色列表，避免提取出 xiaoG-cg-v3
    const knownCharacters = [
      'xiaoG', 'tao-tie', 'nuan-nuan', 'bai-ze', 'jiu-wei-hu',
      'zhu-long', 'ying-long', 'feng-huang', 'chen-nurse', 'coach-li'
    ];
    
    for (const charId of knownCharacters) {
      if (url.includes(charId)) {
        return charId;
      }
      const kebabId = this.camelToKebab(charId);
      if (url.includes(kebabId)) {
        return charId;
      }
    }
    
    return '';
  }

  /**
   * 检查图片URL是否有效
   * v6.5.8-fix: 支持文件路径（预生产模式）和 base64（生产模式）
   */
  isValidImageUrl(url) {
    if (!url) return false;
    // base64 格式：长度≥100且包含 base64
    if (url.includes('base64') && url.length >= 100) return true;
    // 文件路径格式：包含 / 且以 .png/.jpg/.jpeg 结尾
    if (url.includes('/') && /\.(png|jpg|jpeg|webp)$/i.test(url)) return true;
    return false;
  }

  /**
   * 获取镜头Prompt文本
   * v6.5.8-fix: 支持 shot.prompt 为字符串的情况
   */
  getPromptText(shot) {
    if (typeof shot === 'string') return shot;
    // 处理 shot.prompt 为字符串或对象的情况
    const promptText = shot.prompt;
    if (typeof promptText === 'string') return promptText;
    return promptText?.text || shot.visualPrompt || shot.narration || shot.scene || '';
  }

  /**
   * 生成拦截消息
   * v6.2-patch120: 增加 Seedance 2.0 @image 绑定格式说明
   */
  generateBlockMessage(shot, charId, check) {
    const issues = check.issues.join('\n      ');
    const fixes = check.fixSteps.map((step, i) => `${i + 1}. ${step}`).join('\n   ');
    
    return `❌ RENDER_BLOCKED: 定妆照强制提交闸机拦截
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
镜头: ${shot.id || shot.shotId || 'unknown'}
角色: ${charId}
问题:
   ${issues}

修复步骤:
   ${fixes}

Seedance 2.0 绑定规范:
   在 Prompt 中显式使用 @image 格式引用角色：
   @image1 作为小G角色形象参考
   @image2 作为饕餮角色形象参考
   
   content 数组中必须包含：
   { type: 'image_url', image_url: { url: 'data:image/png;base64,xxx' }, role: 'reference_image' }

目录结构:
   characters/${charId}/portraits/
   ├── ${charId}-front.png      (必需)
   ├── ${charId}-threeQuarter.png
   ├── ${charId}-closeup.png
   └── ${charId}-side.png

此拦截不可绕过。必须修复后才能提交渲染。
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  /**
   * 生成汇总报告
   */
  generateSummary(passed, errors, warnings) {
    if (passed && warnings.length === 0) {
      return '✅ 所有含角色镜头均已正确绑定定妆照';
    }
    
    if (!passed) {
      return `❌ 拦截 ${errors.length} 个镜头（${errors.filter(e => e.type === 'HARD_BLOCK').length} 个硬拦截）`;
    }
    
    return `⚠️ 通过但存在 ${warnings.length} 个警告`;
  }

  /**
   * 工具方法：驼峰转短横线
   */
  camelToKebab(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }
}

module.exports = { ReferenceImageGate };

// 自测
if (require.main === module) {
  const gate = new ReferenceImageGate({
    mode: 'production',
    requiredCharacters: ['xiaoG', 'tao-tie']
  });
  
  // 测试用例1: 无定妆照 → 硬拦截
  const badShot = {
    id: 'S01',
    characters: ['xiaoG'],
    content: [
      { type: 'text', text: 'some prompt' }
    ]
  };
  
  const result = gate.validate([badShot]);
  console.log('=== ReferenceImageGate 测试 ===');
  console.log('通过:', result.passed);
  console.log('错误:', result.errors.length);
  console.log('警告:', result.warnings.length);
  if (result.errors.length > 0) {
    console.log('\n拦截消息:');
    console.log(result.errors[0].message);
  }
}
