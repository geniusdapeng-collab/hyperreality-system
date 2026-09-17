/**
 * prompt-guardian.js — Prompt 自动化防护与修复系统
 * 
 * 核心设计：不是报错，而是自动修复
 * - 发现缺失 → 自动补全
 * - 发现错误 → 自动修正
 * - 发现敏感词 → 自动替换
 * 
 * 所有修复记录到日志，人工可追溯
 */

const fs = require('fs');
const path = require('path');

class PromptGuardian {
  constructor(options = {}) {
    this.logPath = options.logPath || path.join(__dirname, '..', 'output', 'prompt-guardian-log.json');
    this.strictMode = options.strictMode || false;
    
    // 敏感词库（可扩展）
    this.sensitiveWords = [
      { pattern: /痛苦/g, replace: '不适', reason: '触发输出敏感检测' },
      { pattern: /疼[痛楚]/g, replace: '不适', reason: '触发输出敏感检测' },
      { pattern: /剧[烈疼]/g, replace: '明显', reason: '触发输出敏感检测' },
      { pattern: /受[伤损]/g, replace: '受影响', reason: '触发输出敏感检测' },
      { pattern: /血[液汗]/g, replace: '体液', reason: '触发输出敏感检测' },
      { pattern: /流[血汗]/g, replace: '流失', reason: '触发输出敏感检测' },
      { pattern: /死[亡故]/g, replace: '严重', reason: '触发输出敏感检测' },
      { pattern: /丧命/g, replace: '危险', reason: '触发输出敏感检测' },
      { pattern: /残[疾障]/g, replace: '影响', reason: '触发输出敏感检测' },
      { pattern: /虐[待待]/g, replace: '伤害', reason: '触发输出敏感检测' },
    ];
    
    // 服装锁定规则（含详细锚定描述）
    this.costumeRules = [
      {
        rolePatterns: [/警[察服]/, /police/i, /officer/i],
        costumePrefix: '穿警服的',
        costumeDetail: '身穿藏青色警用制服，佩戴警帽、警徽、肩章、领花、胸牌',
        checkPattern: /穿警服/,
        checkDetailPattern: /警帽|警徽|肩章/,
        reason: '防止场景描述覆盖服装'
      },
      {
        rolePatterns: [/护士/, /nurse/i],
        costumePrefix: '穿护士服的',
        costumeDetail: '身穿白色护士服，佩戴护士帽',
        checkPattern: /穿护士服/,
        checkDetailPattern: /护士帽|护士服/,
        reason: '防止场景描述覆盖服装'
      },
      {
        rolePatterns: [/医生/, /doctor/i, /医师/],
        costumePrefix: '穿白大褂的',
        costumeDetail: '身穿白色医生大褂',
        checkPattern: /穿白大褂/,
        checkDetailPattern: /白大褂/,
        reason: '防止场景描述覆盖服装'
      }
    ];
    
    // 台词净化规则（保留原始）
    this.dialogueRules = [
      { pattern: /\【台词\】/g, replace: '【台词】', reason: '统一台词标记格式' },
      { pattern: /\|/g, replace: '，', reason: '竖杠会干扰音频生成' },
      { pattern: /\\n/g, replace: ' ', reason: '换行符会截断音频' },
      { pattern: /\s+/g, replace: ' ', reason: '多余空格' },
    ];
    
    // 声音描述规则（新增：环境音、音效、配乐描述）
    this.audioRules = [
      { pattern: /【音效】/, type: 'sound_effect', reason: '音效标记' },
      { pattern: /【环境音】/, type: 'ambient', reason: '环境音标记' },
      { pattern: /【配乐】/, type: 'music', reason: '配乐标记' },
    ];
    
    // 多镜头时间戳格式检查（新增）
    this.timestampRules = [
      { pattern: /\[00:(\d{2})\]/g, valid: true, reason: '单镜头时间戳格式' },
      { pattern: /\[00:(\d{2})-00:(\d{2})\]/g, valid: true, reason: '多镜头时间戳范围格式' },
    ];
    
    // 种子值规则（新增：批量生成时建议锁定seed）
    this.seedRules = [
      { pattern: /seed[=:](\d+)/i, type: 'seed_locked', reason: '已锁定种子值' },
    ];
    
    // 负向提示词规则（新增）
    this.negativePromptRules = [
      { pattern: /【负向】/g, type: 'negative_prompt', reason: '负向提示词标记' },
    ];
    
    // 引用格式修正：@image1 -> 图片1
    this.referenceRules = [
      { pattern: /@image(\d+)/g, replace: '图片$1', reason: '官方引用格式为"图片N"' },
      { pattern: /@Image(\d+)/g, replace: '图片$1', reason: '官方引用格式为"图片N"' },
    ];
    
    this.fixLog = [];
  }

  /**
   * 主入口：自动修复Prompt
   * @param {string} prompt - 原始prompt
   * @param {Array} characters - 角色数组 [{id, role, costume}]
   * @param {Object} options - 可选参数 { isBatch }
   * @returns {Object} { prompt, fixes, safe }
   */
  autoFix(prompt, characters = [], options = {}) {
    this.fixLog = [];
    let fixedPrompt = prompt;
    let safe = true;

    console.log('🔍 【PromptGuardian】启动自动修复...');

    // Step 1: 服装锁定检查与自动修复
    const costumeResult = this._fixCostume(fixedPrompt, characters);
    if (costumeResult.fixed) {
      fixedPrompt = costumeResult.prompt;
      this.fixLog.push(costumeResult.fix);
      console.log(`  ✅ 服装锁定: ${costumeResult.fix.action}`);
    }

    // Step 2: 台词净化
    const dialogueResult = this._fixDialogue(fixedPrompt);
    if (dialogueResult.fixed) {
      fixedPrompt = dialogueResult.prompt;
      this.fixLog.push(...dialogueResult.fixes);
      console.log(`  ✅ 台词净化: 修复 ${dialogueResult.fixes.length} 处`);
    }

    // Step 3: 敏感词过滤
    const sensitiveResult = this._filterSensitive(fixedPrompt);
    if (sensitiveResult.fixed) {
      fixedPrompt = sensitiveResult.prompt;
      this.fixLog.push(...sensitiveResult.fixes);
      console.log(`  ✅ 敏感词过滤: 替换 ${sensitiveResult.fixes.length} 处`);
      if (this.strictMode) safe = false;
    }

    // Step 4: 声音描述检查（新增：环境音、音效、配乐标记）
    const audioResult = this._checkAudioDescription(fixedPrompt);
    if (audioResult.found) {
      this.fixLog.push(audioResult.fix);
      console.log(`  ✅ 声音描述: 检测到 ${audioResult.fix.count} 处声音标记`);
    }

    // Step 5: 多镜头时间戳检查（新增）
    const timestampResult = this._checkTimestampFormat(fixedPrompt);
    if (timestampResult.found) {
      this.fixLog.push(timestampResult.fix);
      console.log(`  ✅ 时间戳: 检测到 ${timestampResult.fix.count} 处多镜头标记`);
    }

    // Step 6: 引用格式修正（@image1 -> 图片1）
    const refResult = this._fixReferenceFormat(fixedPrompt);
    if (refResult.fixed) {
      fixedPrompt = refResult.prompt;
      this.fixLog.push(refResult.fix);
      console.log(`  ✅ 引用格式: ${refResult.fix.action}`);
    }

    // Step 7: 负向提示词检查（新增）
    const negativeResult = this._checkNegativePrompt(fixedPrompt);
    if (negativeResult.found) {
      this.fixLog.push(negativeResult.fix);
      console.log(`  ✅ 负向提示词: ${negativeResult.fix.action}`);
    }

    // Step 8: 外观特征锚定（详细描述服装配饰）
    const anchorResult = this._addAppearanceAnchor(fixedPrompt, characters);
    if (anchorResult.fixed) {
      fixedPrompt = anchorResult.prompt;
      this.fixLog.push(anchorResult.fix);
      console.log(`  ✅ 外观锚定: ${anchorResult.fix.action}`);
    }

    // Step 9: 种子值检查（新增：批量生成建议）
    const seedResult = this._checkSeedValue(fixedPrompt, options);
    if (seedResult.found) {
      this.fixLog.push(seedResult.fix);
      console.log(`  ✅ 种子值: ${seedResult.fix.action}`);
    }

    // Step 10: API参数完整性检查（仅检查，不修改prompt）
    const apiResult = this._checkApiParams(fixedPrompt, characters);
    if (!apiResult.valid) {
      this.fixLog.push(...apiResult.issues);
      console.log(`  ⚠️ API参数检查: 发现 ${apiResult.issues.length} 个问题`);
      if (this.strictMode) safe = false;
    }

    // 保存日志
    this._saveLog(prompt, fixedPrompt, this.fixLog, safe);

    return {
      originalPrompt: prompt,
      prompt: fixedPrompt,
      fixes: this.fixLog,
      safe,
      changed: fixedPrompt !== prompt
    };
  }

  /**
   * 服装锁定：自动在角色描述前添加服装前缀
   */
  _fixCostume(prompt, characters) {
    let fixed = false;
    let fixedPrompt = prompt;
    const fix = {
      type: 'costume_lock',
      action: '无修复',
      reason: '已包含服装锁定'
    };

    for (const char of characters) {
      const charName = char.name || char.id;
      
      for (const rule of this.costumeRules) {
        // 检查角色是否匹配规则
        const roleMatch = rule.rolePatterns.some(p => 
          p.test(char.role || '') || p.test(char.description || '') || p.test(charName)
        );
        
        if (!roleMatch) continue;
        
        // 检查prompt是否已包含服装锁定
        if (rule.checkPattern.test(fixedPrompt)) {
          continue; // 已锁定，跳过
        }
        
        // 自动修复：在角色名附近添加服装前缀
        const namePatterns = [
          new RegExp(`(${charName})`, 'g'),
          new RegExp(`(角色[是为]${charName})`, 'g'),
        ];
        
        for (const pattern of namePatterns) {
          if (pattern.test(fixedPrompt)) {
            fixedPrompt = fixedPrompt.replace(pattern, `${rule.costumePrefix}$1`);
            fixed = true;
            fix.action = `添加"${rule.costumePrefix}"前缀到角色"${charName}"`;
            fix.reason = rule.reason;
            break;
          }
        }
        
        if (fixed) break;
      }
      
      if (fixed) break;
    }

    return { fixed, prompt: fixedPrompt, fix };
  }

  /**
   * 台词净化：移除竖杠等干扰字符
   */
  _fixDialogue(prompt) {
    const fixes = [];
    let fixedPrompt = prompt;
    let fixed = false;

    // 查找台词区域（【台词】标记）
    const dialogueRegex = /【台词】([^【】]+)/g;
    let match;
    
    while ((match = dialogueRegex.exec(prompt)) !== null) {
      const originalDialogue = match[1];
      let cleanedDialogue = originalDialogue;
      
      for (const rule of this.dialogueRules) {
        if (rule.pattern.test(cleanedDialogue)) {
          cleanedDialogue = cleanedDialogue.replace(rule.pattern, rule.replace);
          fixes.push({
            type: 'dialogue_clean',
            action: `替换 "${rule.pattern.source}" -> "${rule.replace}"`,
            reason: rule.reason,
            original: originalDialogue,
            cleaned: cleanedDialogue
          });
          fixed = true;
        }
      }
      
      // 替换台词区域
      if (cleanedDialogue !== originalDialogue) {
        fixedPrompt = fixedPrompt.replace(
          `【台词】${originalDialogue}`,
          `【台词】${cleanedDialogue}`
        );
      }
    }

    return { fixed, prompt: fixedPrompt, fixes };
  }

  /**
   * 敏感词过滤：自动替换为中性词
   */
  _filterSensitive(prompt) {
    const fixes = [];
    let fixedPrompt = prompt;
    let fixed = false;

    for (const rule of this.sensitiveWords) {
      if (rule.pattern.test(fixedPrompt)) {
        const original = fixedPrompt.match(rule.pattern)?.[0];
        fixedPrompt = fixedPrompt.replace(rule.pattern, rule.replace);
        fixes.push({
          type: 'sensitive_filter',
          action: `替换 "${original}" -> "${rule.replace}"`,
          reason: rule.reason
        });
        fixed = true;
      }
    }

    return { fixed, prompt: fixedPrompt, fixes };
  }

  /**
   * 引用格式修正：@image1 -> 图片1
   */
  _fixReferenceFormat(prompt) {
    let fixed = false;
    let fixedPrompt = prompt;
    const fix = {
      type: 'reference_format',
      action: '无修复',
      reason: '官方引用格式为"图片N"'
    };

    for (const rule of this.referenceRules) {
      if (rule.pattern.test(fixedPrompt)) {
        fixedPrompt = fixedPrompt.replace(rule.pattern, rule.replace);
        fixed = true;
        fix.action = `修正引用格式: ${rule.pattern.source} -> ${rule.replace}`;
        fix.reason = rule.reason;
      }
    }

    return { fixed, prompt: fixedPrompt, fix };
  }

  /**
   * 外观特征锚定：添加详细服装配饰描述
   */
  _addAppearanceAnchor(prompt, characters) {
    let fixed = false;
    let fixedPrompt = prompt;
    const fix = {
      type: 'appearance_anchor',
      action: '无修复',
      reason: '已包含外观锚定'
    };

    for (const char of characters) {
      const charName = char.name || char.id;
      
      for (const rule of this.costumeRules) {
        // 检查角色是否匹配规则
        const roleMatch = rule.rolePatterns.some(p => 
          p.test(char.role || '') || p.test(char.description || '') || p.test(charName)
        );
        
        if (!roleMatch) continue;
        
        // 检查prompt是否已包含详细锚定描述
        if (rule.checkDetailPattern.test(fixedPrompt)) {
          continue; // 已有详细描述，跳过
        }
        
        // 检查prompt是否包含服装前缀（说明已经锁定服装）
        if (!rule.checkPattern.test(fixedPrompt)) {
          continue; // 没有服装锁定，跳过（由_fixCostume处理）
        }
        
        // 自动修复：在角色描述后添加详细锚定
        // 查找角色名或服装描述后的位置
        const insertPatterns = [
          new RegExp(`(穿警服的${charName})`, 'g'),
          new RegExp(`(穿护士服的${charName})`, 'g'),
          new RegExp(`(穿白大褂的${charName})`, 'g'),
        ];
        
        for (const pattern of insertPatterns) {
          if (pattern.test(fixedPrompt)) {
            fixedPrompt = fixedPrompt.replace(pattern, `$1，${rule.costumeDetail}`);
            fixed = true;
            fix.action = `添加外观锚定:"${rule.costumeDetail}"`;
            fix.reason = '详细描述服装配饰防止漂移';
            break;
          }
        }
        
        if (fixed) break;
      }
      
      if (fixed) break;
    }

    return { fixed, prompt: fixedPrompt, fix };
  }

  /**
   * API参数完整性检查
   */
  _checkApiParams(prompt, characters) {
    const issues = [];
    
    // 检查是否包含角色但缺少服装锁定
    for (const char of characters) {
      const charName = char.name || char.id;
      if (prompt.includes(charName) && !/穿[警护白][服大]/g.test(prompt)) {
        issues.push({
          type: 'api_param',
          severity: 'warning',
          message: `角色"${charName}"出现但Prompt未明确锁定服装`,
          suggestion: '在角色描述前添加"穿警服的/穿护士服的/穿白大褂的"'
        });
      }
    }
    
    // 检查台词标记格式
    if (/【台词】/.test(prompt)) {
      const dialogueMatches = prompt.match(/【台词】([^【】]+)/g);
      if (dialogueMatches) {
        for (const match of dialogueMatches) {
          if (/\|/.test(match)) {
            issues.push({
              type: 'api_param',
              severity: 'error',
              message: '台词中包含竖杠 |',
              suggestion: '移除竖杠，使用纯文本'
            });
          }
        }
      }
    }
    
    return {
      valid: issues.length === 0,
      issues
    };
  }

  /**
   * 声音描述检查：检测环境音、音效、配乐标记
   */
  _checkAudioDescription(prompt) {
    const found = [];
    for (const rule of this.audioRules) {
      if (rule.pattern.test(prompt)) {
        found.push(rule.type);
      }
    }
    
    return {
      found: found.length > 0,
      fix: {
        type: 'audio_description',
        action: `检测到 ${found.length} 处声音描述标记 (${found.join(', ')})`,
        reason: '声音描述有助于生成匹配的音频',
        count: found.length
      }
    };
  }

  /**
   * 多镜头时间戳格式检查
   */
  _checkTimestampFormat(prompt) {
    let count = 0;
    for (const rule of this.timestampRules) {
      const matches = prompt.match(rule.pattern);
      if (matches) {
        count += matches.length;
      }
    }
    
    return {
      found: count > 0,
      fix: {
        type: 'timestamp_format',
        action: count > 0 ? `检测到 ${count} 处多镜头时间戳标记` : '未使用多镜头时间戳',
        reason: '时间戳格式 [00:00-00:04] 用于多镜头叙事',
        count
      }
    };
  }

  /**
   * 负向提示词检查
   */
  _checkNegativePrompt(prompt) {
    let found = false;
    for (const rule of this.negativePromptRules) {
      if (rule.pattern.test(prompt)) {
        found = true;
        break;
      }
    }
    
    return {
      found,
      fix: {
        type: 'negative_prompt',
        action: found ? '已使用负向提示词【负向】标记' : '未使用负向提示词',
        reason: '负向提示词可排除不想要的元素'
      }
    };
  }

  /**
   * 种子值检查（批量生成时建议锁定）
   */
  _checkSeedValue(prompt, options = {}) {
    let hasSeed = false;
    for (const rule of this.seedRules) {
      if (rule.pattern.test(prompt)) {
        hasSeed = true;
        break;
      }
    }
    
    // 批量生成且未锁定seed时提示
    if (options.isBatch && !hasSeed) {
      return {
        found: true,
        fix: {
          type: 'seed_value',
          action: '批量生成未锁定seed值，建议添加 seed:12345 以保持角色一致性',
          reason: '固定seed值可排除随机因素，确保角色细节一致'
        }
      };
    }
    
    return {
      found: hasSeed,
      fix: {
        type: 'seed_value',
        action: hasSeed ? '已锁定种子值' : '未使用种子值（单条生成可选）',
        reason: '种子值控制生成随机性'
      }
    };
  }
  _saveLog(original, fixed, fixes, safe) {
    const log = {
      timestamp: new Date().toISOString(),
      originalPromptLength: original.length,
      fixedPromptLength: fixed.length,
      fixCount: fixes.length,
      safe,
      fixes,
      originalPrompt: original.substring(0, 200) + '...',
      fixedPrompt: fixed.substring(0, 200) + '...'
    };
    
    let logs = [];
    if (fs.existsSync(this.logPath)) {
      logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
    }
    logs.push(log);
    fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
  }

  /**
   * 获取修复统计
   */
  getStats() {
    if (!fs.existsSync(this.logPath)) return { total: 0, fixes: 0 };
    const logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
    return {
      total: logs.length,
      fixes: logs.reduce((sum, log) => sum + log.fixCount, 0),
      unsafeCount: logs.filter(l => !l.safe).length
    };
  }
}

module.exports = { PromptGuardian };

// 自测
if (require.main === module) {
  const guardian = new PromptGuardian();
  
  // 测试用例
  const testPrompt = `16:9 cinematic | 主角A站在健身房中，痛苦的表情，汗水浸湿衣服 | 【台词】横纹肌溶解|会导致肌肉疼痛和损伤`;
  
  const result = guardian.autoFix(testPrompt, [
    { id: 'protagonist-a', name: '主角A', role: '警察' }
  ]);
  
  console.log('\n🔍 测试结果:');
  console.log('原始:', result.originalPrompt);
  console.log('修复后:', result.prompt);
  console.log('修复项:', result.fixes.length);
  console.log('是否安全:', result.safe);
  console.log('是否变更:', result.changed);
}
