/**
 * Prompt Guardian — Prompt 自动化防护与修复系统 (SuperMickey 适配版)
 * 
 * 来源: 卓越系统 zhuoyue/scripts/prompt-guardian.js
 * 适配: SuperMickey 四层架构，在 Layer 2 制作引擎后、FieldGuard 前调用
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
    this.logPath = options.logPath || path.join(__dirname, '..', '..', 'output', 'prompt-guardian-log.json');
    this.strictMode = options.strictMode || false;
    this.enabled = options.enabled !== false;
    
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
    
    // 台词净化规则
    this.dialogueRules = [
      { pattern: /\【台词\】/g, replace: '【台词】', reason: '统一台词标记格式' },
      { pattern: /\|/g, replace: '，', reason: '竖杠会干扰音频生成' },
      { pattern: /\\n/g, replace: ' ', reason: '换行符会截断音频' },
      { pattern: /\s+/g, replace: ' ', reason: '多余空格' },
    ];
    
    // 引用格式修正：@image1 -> 图片1
    this.referenceRules = [
      { pattern: /@image(\d+)/g, replace: '图片$1', reason: '官方引用格式为"图片N"' },
      { pattern: /@Image(\d+)/g, replace: '图片$1', reason: '官方引用格式为"图片N"' },
    ];
    
    this.fixLog = [];
  }

  /**
   * SuperMickey 主入口：批量修复 Prompts
   * @param {Array} prompts - SuperMickey 格式的 prompts 数组 [{shotId, prompt, ...}]
   * @param {Object} options - { characters, isBatch, strictMode }
   * @returns {Object} { prompts, fixes, safe }
   */
  guard(prompts, options = {}) {
    if (!this.enabled) {
      return { prompts, fixes: [], safe: true };
    }

    this.fixLog = [];
    let safe = true;
    const guardedPrompts = [];

    console.log('🔍 【PromptGuardian】启动自动修复...');

    for (const promptObj of prompts) {
      const promptText = typeof promptObj === 'string' ? promptObj : (promptObj.prompt || '');
      const characters = options.characters || [];
      
      const result = this.autoFix(promptText, characters, options);
      
      if (typeof promptObj === 'string') {
        guardedPrompts.push(result.prompt);
      } else {
        guardedPrompts.push({ ...promptObj, prompt: result.prompt });
      }
      
      this.fixLog.push(...result.fixes);
      if (!result.safe) safe = false;
    }

    console.log(`✅ 【PromptGuardian】修复完成: ${this.fixLog.length} 处修复`);

    return {
      prompts: guardedPrompts,
      fixes: this.fixLog,
      safe
    };
  }

  /**
   * 原始主入口：自动修复单个 Prompt
   */
  autoFix(prompt, characters = [], options = {}) {
    this.fixLog = [];
    let fixedPrompt = prompt;
    let safe = true;

    // Step 1: 服装锁定检查与自动修复
    const costumeResult = this._fixCostume(fixedPrompt, characters);
    if (costumeResult.fixed) {
      fixedPrompt = costumeResult.prompt;
      this.fixLog.push(costumeResult.fix);
    }

    // Step 2: 台词净化
    const dialogueResult = this._fixDialogue(fixedPrompt);
    if (dialogueResult.fixed) {
      fixedPrompt = dialogueResult.prompt;
      this.fixLog.push(...dialogueResult.fixes);
    }

    // Step 3: 敏感词过滤
    const sensitiveResult = this._filterSensitive(fixedPrompt);
    if (sensitiveResult.fixed) {
      fixedPrompt = sensitiveResult.prompt;
      this.fixLog.push(...sensitiveResult.fixes);
      if (this.strictMode) safe = false;
    }

    // Step 4: 引用格式修正
    const refResult = this._fixReferenceFormat(fixedPrompt);
    if (refResult.fixed) {
      fixedPrompt = refResult.prompt;
      this.fixLog.push(refResult.fix);
    }

    // Step 5: 外观特征锚定
    const anchorResult = this._addAppearanceAnchor(fixedPrompt, characters);
    if (anchorResult.fixed) {
      fixedPrompt = anchorResult.prompt;
      this.fixLog.push(anchorResult.fix);
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

  // ========== 子模块实现 ==========

  _fixCostume(prompt, characters) {
    let fixed = prompt;
    let changed = false;
    const actions = [];

    for (const rule of this.costumeRules) {
      // 检查是否提到了该角色
      const hasRole = rule.rolePatterns.some(p => p.test(prompt));
      if (!hasRole) continue;

      // 检查是否已锁定服装
      const hasCostume = rule.checkPattern.test(prompt);
      if (!hasCostume) {
        // 自动补全服装前缀
        fixed = rule.costumePrefix + '的' + fixed;
        changed = true;
        actions.push(`补全"${rule.costumePrefix}"`);
      }

      // 检查是否有详细描述
      const hasDetail = rule.checkDetailPattern.test(prompt);
      if (!hasDetail) {
        // 在首次提到服装的位置追加详细描述
        fixed = fixed.replace(
          rule.checkPattern,
          match => match + '，' + rule.costumeDetail
        );
        changed = true;
        actions.push(`追加外观锚定"${rule.costumeDetail.substring(0, 20)}..."`);
      }
    }

    return {
      fixed: changed,
      prompt: fixed,
      fix: {
        type: 'costume_lock',
        action: actions.join('；') || '无需修复',
        reason: '防止场景描述覆盖服装'
      }
    };
  }

  _fixDialogue(prompt) {
    let fixed = prompt;
    const fixes = [];

    for (const rule of this.dialogueRules) {
      if (rule.pattern.test(fixed)) {
        fixed = fixed.replace(rule.pattern, rule.replace);
        fixes.push({
          type: 'dialogue_clean',
          action: rule.reason,
          pattern: rule.pattern.toString()
        });
      }
    }

    return {
      fixed: fixes.length > 0,
      prompt: fixed,
      fixes
    };
  }

  _filterSensitive(prompt) {
    let fixed = prompt;
    const fixes = [];

    for (const rule of this.sensitiveWords) {
      if (rule.pattern.test(fixed)) {
        fixed = fixed.replace(rule.pattern, rule.replace);
        fixes.push({
          type: 'sensitive_word',
          action: `替换"${rule.pattern.source}"为"${rule.replace}"`,
          reason: rule.reason
        });
      }
    }

    return {
      fixed: fixes.length > 0,
      prompt: fixed,
      fixes
    };
  }

  _fixReferenceFormat(prompt) {
    let fixed = prompt;
    let changed = false;
    const actions = [];

    for (const rule of this.referenceRules) {
      if (rule.pattern.test(fixed)) {
        fixed = fixed.replace(rule.pattern, rule.replace);
        changed = true;
        actions.push(rule.reason);
      }
    }

    return {
      fixed: changed,
      prompt: fixed,
      fix: {
        type: 'reference_format',
        action: actions.join('；') || '无需修复',
        reason: '修正图片引用格式'
      }
    };
  }

  _addAppearanceAnchor(prompt, characters) {
    // 已在 _fixCostume 中处理
    return { fixed: false, prompt, fix: { type: 'appearance_anchor', action: '无需修复' } };
  }

  _saveLog(original, fixed, fixes, safe) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        originalLength: original.length,
        fixedLength: fixed.length,
        fixCount: fixes.length,
        safe,
        fixes: fixes.map(f => ({ type: f.type, action: f.action }))
      };

      const dir = path.dirname(this.logPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      let logs = [];
      if (fs.existsSync(this.logPath)) {
        logs = JSON.parse(fs.readFileSync(this.logPath, 'utf8'));
      }
      logs.push(logEntry);
      fs.writeFileSync(this.logPath, JSON.stringify(logs, null, 2));
    } catch (e) {
      console.warn('⚠️ PromptGuardian 日志保存失败:', e.message);
    }
  }
}

module.exports = { PromptGuardian };
