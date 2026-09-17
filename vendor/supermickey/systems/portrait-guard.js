/**
 * portrait-guard.js — 定妆照统一硬拦截系统 v1.0
 * 
 * 双系列通用（山海经 + 通用视频）
 * 核心原则：任何包含角色的镜头，没有成功传入全部定妆照 → 完全无法提交渲染
 * 
 * 使用方式：
 *   const guard = new PortraitGuard({ charactersDir });
 *   const result = guard.validate(shots);
 *   if (!result.passed) throw new Error(result.summary);
 */

const fs = require('fs');
const path = require('path');

// 必需角度（4角度标准）
const REQUIRED_ANGLES = ['front', 'threeQuarter', 'closeup', 'side'];
// 最低角度要求（至少要有 front）
const MINIMUM_ANGLES = ['front'];

class PortraitGuard {
  constructor(options = {}) {
    this.charactersDir = options.charactersDir || path.join(__dirname, '..', 'characters');
    this.mode = options.mode || 'production'; // 'production' | 'pre-production'
    // 生产模式：硬拦截（抛出错误）
    // 预生产模式：返回警告但不抛出
  }

  /**
   * 主入口：验证 shots 数组
   * @param {Array} shots - 镜头数组，每项包含 { id, characters, content }
   * @returns {Object} { passed, errors, warnings, summary }
   */
  validate(shots) {
    const errors = [];
    const warnings = [];
    const details = [];

    for (const shot of shots) {
      const result = this.validateShot(shot);
      details.push({ shotId: shot.id || shot.shotId, ...result });

      if (result.errors.length > 0) {
        errors.push(...result.errors);
      }
      if (result.warnings.length > 0) {
        warnings.push(...result.warnings);
      }
    }

    const passed = errors.length === 0;
    const summary = this.generateSummary(passed, errors, warnings, details);

    return { passed, errors, warnings, details, summary };
  }

  /**
   * 硬拦截入口：验证不通过直接抛出错误
   * 适用于生产环境提交脚本
   */
  validateOrThrow(shots) {
    const result = this.validate(shots);
    if (!result.passed) {
      console.error('\n❌❌❌ 定妆照硬拦截触发 ❌❌❌');
      console.error(result.summary);
      throw new Error(`[PortraitGuard] 渲染被拦截：${result.errors.length}个镜头缺少定妆照。请先生成定妆照并经队长确认后再提交。`);
    }
    if (result.warnings.length > 0) {
      console.warn('\n⚠️ 定妆照警告：');
      result.warnings.forEach(w => console.warn(`  - ${w.shotId}: ${w.message}`));
    }
    console.log('\n✅ 定妆照硬拦截通过：所有角色定妆照已绑定');
    return result;
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

    // 3. 从 content 数组中提取 reference_image
    const content = shot.content || (shot.prompt && shot.prompt.content) || [];
    const referenceImages = this.extractReferenceImages(content);

    // 4. 逐角色检查
    for (const charId of charactersInShot) {
      const check = this.validateCharacter(charId, referenceImages, shot);
      characterChecks.push(check);

      if (!check.passed) {
        const blockMsg = this.generateBlockMessage(shot, charId, check);

        if (this.mode === 'production') {
          errors.push({
            type: 'HARD_BLOCK',
            shotId: shot.id || shot.shotId,
            characterId: charId,
            message: blockMsg,
            fixSteps: check.fixSteps
          });
        } else {
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
   * 从镜头中提取角色ID
   * 支持多种字段名：characters / humanCharacters / characterRoles / requiredCharacters
   */
  extractCharacters(shot) {
    const characters = new Set();

    // 从 shot.characters 提取（通用视频系列标准字段）
    if (shot.characters && Array.isArray(shot.characters)) {
      shot.characters.forEach(c => characters.add(typeof c === 'string' ? c : c.id));
    }

    // 从 shot.humanCharacters 提取（山海经系列人类角色）
    if (shot.humanCharacters && Array.isArray(shot.humanCharacters)) {
      shot.humanCharacters.forEach(c => characters.add(c));
    }

    // 从 shot.characterRoles 提取
    if (shot.characterRoles && Array.isArray(shot.characterRoles)) {
      shot.characterRoles.forEach(c => characters.add(typeof c === 'string' ? c : c.id));
    }

    // 从 shot.requiredCharacters 提取（projectConfig级别）
    if (shot.requiredCharacters && Array.isArray(shot.requiredCharacters)) {
      shot.requiredCharacters.forEach(c => characters.add(c));
    }

    return Array.from(characters);
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
        // 🔥 v6.2-patch50-fix: 优先使用显式声明的characterId（buildReferenceImages设置）
        characterId: item.characterId || item.image_url?.characterId || this.extractCharacterIdFromUrl(item.image_url?.url || ''),
        // 🔥 v6.2-patch50-fix: 传递angle字段（用于extractReferenceImageAngles）
        angle: item.angle || undefined,
        valid: this.isValidImageUrl(item.image_url?.url)
      }));
  }

  /**
   * 验证单个角色的定妆照
   */
  validateCharacter(charId, referenceImages, shot) {
    const issues = [];
    const fixSteps = [];

    // 1. 检查是否有该角色的 reference_image
    const charRefs = referenceImages.filter(ref =>
      ref.characterId === charId || ref.characterId === this.camelToKebab(charId)
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

      // 3. 检查角度覆盖
      const charRefAngles = this.extractReferenceImageAngles(charId, referenceImages);
      const missingRequiredAngles = REQUIRED_ANGLES.filter(a => !charRefAngles.includes(a));
      if (missingRequiredAngles.length > 0) {
        issues.push(`角色 "${charId}" 缺少角度: ${missingRequiredAngles.join(', ')}`);
        fixSteps.push(`为 ${charId} 传入缺失角度: ${missingRequiredAngles.join(', ')}`);
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
      missingFileAngles: missingFileAngles.length > 0 ? missingFileAngles : undefined
    };
  }

  /**
   * 检查指定角度的定妆照文件是否存在
   */
  checkAngleExists(charId, angle) {
    const portraitDir = path.join(this.charactersDir, charId, 'portraits');

    // 精确匹配名称
    const exactNames = [
      `${charId}-${angle}.png`,
      `${charId}-${angle}.jpg`,
      `${this.camelToKebab(charId)}-${angle}.png`,
      `${this.camelToKebab(charId)}-${angle}.jpg`
    ];

    for (const name of exactNames) {
      if (fs.existsSync(path.join(portraitDir, name))) {
        return true;
      }
    }

    // 模糊匹配
    try {
      const files = fs.readdirSync(portraitDir);
      const pattern = new RegExp(`${charId}.*-${angle}\.(png|jpg|jpeg)`, 'i');
      const kebabPattern = new RegExp(`${this.camelToKebab(charId)}.*-${angle}\.(png|jpg|jpeg)`, 'i');
      for (const file of files) {
        if (pattern.test(file) || kebabPattern.test(file)) {
          return true;
        }
      }
    } catch (e) {
      return false;
    }

    return false;
  }

  /**
   * 从 reference_images 中提取指定角色的角度列表
   * 🔥 v6.2-patch50-fix: 优先使用显式声明的 angle 字段（buildReferenceImages设置）
   * 其次才从URL中解析（兼容旧数据）
   */
  extractReferenceImageAngles(charId, referenceImages) {
    const angles = [];
    for (const ref of referenceImages) {
      const refCharId = ref.characterId || this.extractCharacterIdFromUrl(ref.url);
      if (refCharId === charId || refCharId === this.camelToKebab(charId)) {
        // 🔥 优先使用显式声明的 angle 字段
        if (ref.angle) {
          angles.push(ref.angle);
        } else {
          // 兜底：从 URL 中提取角度信息
          const angleMatch = ref.url.match(/-(front|threeQuarter|closeup|side)\./);
          if (angleMatch) {
            angles.push(angleMatch[1]);
          }
        }
      }
    }
    return angles;
  }

  /**
   * 从URL中提取角色ID
   * 支持多种命名格式：
   * - characters/xiaoG/portraits/xiaoG-front.png
   * - xiaoG-cg-v3-front.png（提取 xiaoG，而非 xiaoG-cg-v3）
   */
  extractCharacterIdFromUrl(url) {
    if (!url) return '';
    
    // 从路径中提取角色目录名
    const match = url.match(/characters\/([^\/]+)\/portraits/);
    if (match) return match[1];
    
    // 从文件名中提取角色ID（匹配标准角色ID列表）
    // 注意：xiaoG-cg-v3-front.png 应该提取 xiaoG，而非 xiaoG-cg-v3
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
    
    // 兜底：尝试从路径结构中提取
    const pathMatch = url.match(/portraits\/([^-]+)/);
    if (pathMatch) return pathMatch[1];
    
    return '';
  }

  /**
   * 检查图片URL是否有效
   */
  isValidImageUrl(url) {
    if (!url) return false;
    if (url.length < 100) return false;
    if (!url.includes('base64')) return false;
    return true;
  }

  /**
   * 生成拦截消息
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
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  /**
   * 生成汇总报告
   */
  generateSummary(passed, errors, warnings, details) {
    const lines = [];
    lines.push(`定妆照硬拦截验证结果: ${passed ? '✅ 通过' : '❌ 未通过'}`);
    lines.push(`总镜头: ${details.length} | 错误: ${errors.length} | 警告: ${warnings.length}`);

    if (errors.length > 0) {
      lines.push('\n❌ 硬拦截错误:');
      errors.forEach(e => lines.push(`  - ${e.shotId} | ${e.characterId}: ${e.message.substring(0, 80)}...`));
    }

    if (warnings.length > 0) {
      lines.push('\n⚠️ 警告:');
      warnings.forEach(w => lines.push(`  - ${w.shotId} | ${w.characterId}: ${w.message.substring(0, 80)}...`));
    }

    // 统计每镜的 reference_image 数量
    details.forEach(d => {
      const refCount = d.characterChecks?.reduce((sum, c) => sum + (c.referenceCount || 0), 0) || 0;
      lines.push(`  ${d.shotId}: ${refCount}张 reference_image`);
    });

    return lines.join('\n');
  }

  /**
   * 工具：camelCase to kebab-case
   */
  camelToKebab(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }

  // ==================== 静态工具方法 ====================

  /**
   * 生成角色ID的变体列表（用于匹配不同命名格式）
   * 如: tao-tie → [tao-tie, taotie]
   *     xiaoG → [xiaoG, xiao-g, xiao_g]
   */
  static generateCharIdVariants(charId) {
    const variants = [charId];
    
    // 添加短横线版本（驼峰转短横线）
    const kebab = charId.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
    if (kebab !== charId.toLowerCase()) {
      variants.push(kebab);
    }
    
    // 添加无短横线版本（如 taotie）
    const noDash = charId.replace(/-/g, '').toLowerCase();
    if (noDash !== charId.toLowerCase() && !variants.includes(noDash)) {
      variants.push(noDash);
    }
    
    // 添加无下划线版本
    const noUnderscore = charId.replace(/_/g, '').toLowerCase();
    if (noUnderscore !== charId.toLowerCase() && !variants.includes(noUnderscore)) {
      variants.push(noUnderscore);
    }
    
    return [...new Set(variants)]; // 去重
  }

  /**
   * 快速验证：验证单个 content 数组中是否包含指定角色的 reference_image
   * 适用于提交脚本中的实时检查
   */
  static quickCheck(content, characterIds) {
    const guard = new PortraitGuard();
    const shot = { id: 'quick-check', characters: characterIds, content };
    return guard.validateShot(shot);
  }

  /**
   * 构建 reference_image content 元素（从角色档案读取图片）
   * 双系列通用：自动扫描角色目录，读取定妆照图片
   * 
   * 🔥 v6.2-patch50-fix1: 传入全部4角度，而非只选1个角度
   * 每个角色的 front, threeQuarter, closeup, side 全部传入
   */
  static buildReferenceImages(characterIds, options = {}) {
    const charactersDir = options.charactersDir || path.join(__dirname, '..', '..', 'characters');
    const referenceImages = [];

    for (const charId of characterIds) {
      // 1. 尝试从角色目录读取定妆照
      const portraitDir = path.join(charactersDir, charId, 'portraits');
      if (!fs.existsSync(portraitDir)) {
        console.warn(`⚠️ PortraitGuard: 角色 ${charId} 的 portraits 目录不存在`);
        continue;
      }

      // 2. 扫描目录中的定妆照文件
      const files = fs.readdirSync(portraitDir);
      const portraits = {};

      for (const angle of REQUIRED_ANGLES) {
        // 支持多种命名格式和角色ID变体
        // 如: tao-tie-front.png, taotie-front.jpeg, xiaoG-front.png, xiaoG-cg-v3-front.png
        const charIdVariants = this.generateCharIdVariants(charId);
        
        for (const variant of charIdVariants) {
          const pattern = new RegExp(`${variant}.*-${angle}\.(png|jpg|jpeg)$`, 'i');
          const matchedFile = files.find(f => pattern.test(f));
          if (matchedFile) {
            portraits[angle] = path.join(portraitDir, matchedFile);
            break;
          }
        }
      }

      // 3. 传入全部4角度（非只选1个）
      for (const angle of REQUIRED_ANGLES) {
        const selectedFile = portraits[angle];
        if (!selectedFile) {
          console.warn(`⚠️ PortraitGuard: 角色 ${charId} 缺少 ${angle} 角度定妆照`);
          continue;
        }

        // 4. 读取图片并构建 content 元素
        try {
          const base64 = fs.readFileSync(selectedFile).toString('base64');
          const mimeType = selectedFile.toLowerCase().endsWith('.png') ? 'image/png' : 'image/jpeg';
          referenceImages.push({
            type: 'image_url',
            image_url: {
              url: `data:${mimeType};base64,${base64}`,
              // 🔥 v6.2-patch50-fix: 显式声明角色ID，避免base64 URL解析失败
              characterId: charId
            },
            role: 'reference_image',
            // 🔥 v6.2-patch50-fix: 显式声明角色ID字段（供extractReferenceImages优先使用）
            characterId: charId,
            angle: angle
          });
          console.log(`📸 PortraitGuard: 绑定 ${charId} (${angle})`);
        } catch (e) {
          console.warn(`⚠️ PortraitGuard: 读取 ${charId} ${angle} 定妆照失败: ${e.message}`);
        }
      }
    }

    return referenceImages;
  }

  // 静态工具方法：驼峰转短横线
  static camelToKebabStatic(str) {
    return str.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
  }
}

module.exports = { PortraitGuard, REQUIRED_ANGLES };
