/**
 * Render Pipeline Guard — 渲染流水线强制检查机制 (SuperMickey 适配版)
 * 
 * 来源: 卓越系统 zhuoyue/scripts/render-pipeline-guard.js
 * 适配: SuperMickey 四层架构，在 Layer 3 渲染引擎前调用
 * 
 * 核心设计：不是建议，而是强制阻塞
 * - 检查不通过 → 阻止提交 → 给出明确修复指令
 * - 所有检查项必须代码化，不能靠人记住
 */

const fs = require('fs');
const path = require('path');
// 【v2.2.5-审计修复】长度上限从唯一真源读取，消除 12000/1500 就地硬编码
const PromptLengthConfig = require('../config/prompt-length.js');

class RenderPipelineGuard {
  constructor(options = {}) {
    this.charactersDir = options.charactersDir || path.join(__dirname, '..', '..', 'characters');
    this.strictMode = options.strictMode !== false;
    this.enabled = options.enabled !== false;
    this.logPath = options.logPath || path.join(__dirname, '..', '..', 'output', 'pipeline-guard-log.json');
    
    // 强制检查规则（不可绕过）
    this.requiredRules = [
      {
        id: 'REF_IMAGE_ROLE',
        name: 'reference_image角色指定',
        check: (prompt) => {
          // SuperMickey 格式: prompt 可能包含 imageReferences 字段
          const images = prompt.imageReferences || [];
          if (images.length === 0) return { pass: true };
          const allHaveRole = images.every(c => c.role === 'reference_image');
          return {
            pass: allHaveRole,
            message: allHaveRole ? null : `${images.filter(c => c.role !== 'reference_image').length} 张图片未指定 role`,
            fix: '为所有图片引用添加 role: "reference_image"'
          };
        }
      },
      {
        id: 'GENERATE_AUDIO',
        name: '台词音频生成开关',
        check: (prompt) => {
          const promptText = prompt.prompt || '';
          const hasDialogue = /【台词】/.test(promptText);
          if (!hasDialogue) return { pass: true };
          // v6.5.60-fix: 如果检测到台词但未开启音频，自动设置而不是报错
          if (prompt.generate_audio !== true) {
            prompt.generate_audio = true;
            return {
              pass: true, // 改为通过，但给出警告
              message: '已自动设置 generate_audio: true（检测到台词）',
              fix: '已自动修复',
              severity: 'warning'
            };
          }
          return { pass: true };
        }
      },
      {
        id: 'REF_IMAGE_COUNT',
        name: '定妆照数量检查',
        check: (prompt) => {
          const images = prompt.imageReferences || [];
          if (images.length === 0) return { pass: true };
          const pass = images.length >= 3;
          return {
            pass,
            message: pass ? null : `只有 ${images.length} 张定妆照，建议至少3-5张`,
            fix: '上传3-5张多角度定妆照（正面、45度、侧面、特写）',
            severity: 'warning'
          };
        }
      },
      {
        id: 'COSTUME_LOCK',
        name: '服装锁定检查',
        check: (prompt) => {
          const text = prompt.prompt || '';
          const hasCharacter = /protagonist|角色|character|主角|人物/i.test(text);
          if (!hasCharacter) return { pass: true };
          // v2.2.1-fix: 修复误报——25字段标准中服装是独立【服装】字段，或在角色描述中以"着/穿...装/服"出现
          const hasSeparateCostumeField = /【服装】[^【】]{10,}/.test(text);
          const hasCostumeLock = hasSeparateCostumeField || /身穿|wearing|dressed in|in a|古装|战甲|铠甲|armor|甲胄|战袍|道服|职业装|正装|锁子黄金甲|凤翅紫金冠|藕丝步云履|虎皮裙|飞凤帽|着[^，。；]{1,}(装|服|衫|袍|褂|裙|甲)|戏服|西装|中山装|童装|制服|工装|旗袍|礼裙/i.test(text);
          return {
            pass: hasCostumeLock,
            message: hasCostumeLock ? null : 'Prompt未明确锁定角色服装',
            // 【修复 P1-1】修复建议去领域化：不指定特定项目服装
            fix: '在角色描述前添加服装描述（与角色档案一致的完整服装锚定，如"身穿[角色档案服装]"）'
          };
        }
      },
      {
        id: 'APPEARANCE_ANCHOR',
        name: '外观特征锚定',
        check: (prompt) => {
          const text = prompt.prompt || '';
          // 【修复 P1-1】外观锚定检查泛化：不绑定特定神话角色的特征词
          const hasAncient = /古装|战甲|铠甲|仙衣|道袍/i.test(text);
          const hasPolice = /穿警服/.test(text);
          if (!hasAncient && !hasPolice) return { pass: true };
          if (hasAncient) {
            const hasAnchor = /头戴|佩戴|手持|额前|腰间/i.test(text);
            return {
              pass: hasAnchor,
              message: hasAnchor ? null : '古装角色但未描述标志性配饰（头饰/手持物等）',
              // 【修复 P1-1】修复建议去领域化
              fix: '添加与角色档案一致的标志性配饰描述（如头饰、手持物）',
              severity: 'warning'
            };
          }
          // 现代职业场景
          const hasAnchor = /警帽|警徽|肩章|领花|胸牌/.test(text);
          return {
            pass: hasAnchor,
            message: hasAnchor ? null : '穿警服但未描述标志性配饰（警帽、警徽等）',
            fix: '添加"佩戴警帽、警徽、肩章、领花、胸牌"',
            severity: 'warning'
          };
        }
      },
      {
        id: 'DIALOGUE_FORMAT',
        name: '台词格式检查',
        check: (prompt) => {
          const text = prompt.prompt || '';
          // 【v2.2.7-fix】台词丢失盲区封堵：旧逻辑"无【台词】即放行"，
          // 数据层有台词但渲染层丢失时全程无告警（本次台词字段整体丢失事故即因此漏检）。
          const dataDialogue = typeof prompt.dialogue === 'string' ? prompt.dialogue
            : (typeof prompt.dialogueText === 'string' ? prompt.dialogueText : '');
          const dataBlocks = Array.isArray(prompt.dialogueBlocks) ? prompt.dialogueBlocks : [];
          const dataHasDialogue = dataBlocks.length > 0 || dataDialogue.trim().length > 0;
          if (dataHasDialogue && !/【台词】/.test(text)) {
            return {
              pass: false,
              message: '数据层存在台词，但最终 Prompt 缺失【台词】字段',
              fix: '检查 PromptFusionAgent 台词组装链路（dialogueBlocks → fields.dialogue → shot.dialogue 回退链）'
            };
          }
          // 【v2.2.7-fix】字段分隔符 ' | ' 不再被误判为台词内容竖杠：
          // 段内容截取到下一个 ' | 【' 或文本结尾为止
          const dialogues = [];
          const dlgRe = /【台词】([\s\S]*?)(?=\s*\|\s*【|$)/g;
          let dm;
          while ((dm = dlgRe.exec(text)) !== null) dialogues.push(dm[1]);
          if (dialogues.length === 0) return { pass: true };
          const badDialogues = dialogues.filter(d => /\|/.test(d));
          return {
            pass: badDialogues.length === 0,
            message: badDialogues.length === 0 ? null : `${badDialogues.length} 句台词包含竖杠 |`,
            fix: '将台词中的 | 替换为 ，'
          };
        }
      },
      {
        id: 'SENSITIVE_WORDS',
        name: '敏感词预检',
        check: (prompt) => {
          const text = prompt.prompt || '';
          const sensitiveMap = {
            '痛苦': '不适',
            '疼痛': '不适',
            '受伤': '受影响',
            '死亡': '严重',
            '血汗': '体液'
          };
          const found = Object.keys(sensitiveMap).filter(w => text.includes(w));
          return {
            pass: found.length === 0,
            message: found.length === 0 ? null : `发现敏感词: ${found.join(', ')}`,
            fix: `替换为中性词: ${found.map(w => `${w}→${sensitiveMap[w]}`).join(', ')}`
          };
        }
      },
      {
        id: 'REFERENCE_FORMAT',
        name: '引用格式检查',
        check: (prompt) => {
          const text = prompt.prompt || '';
          const hasBadFormat = /@image\d+/.test(text);
          return {
            pass: !hasBadFormat,
            message: hasBadFormat ? '使用了错误的引用格式 @imageN' : null,
            fix: '将 @imageN 替换为 图片N'
          };
        }
      },
      {
        id: 'PROMPT_LENGTH',
        name: 'Prompt长度检查',
        check: (prompt) => {
          const text = prompt.prompt || '';
          // 【v2.2.5-审计修复】25字段系统上限从唯一真源 config/prompt-length.js 读取
          // （旧值 12000 是真源 HARD_MAX 的 4 倍，溢出防护形同虚设）；
          // 1500 仅保留给历史 8 字段旧格式 prompt 的兼容校验。
          const is25Field = /【角色】|【场景】|【动作】|【情绪】|【运镜】|【光影】/.test(text);
          const maxLength = prompt.maxLength || (is25Field ? PromptLengthConfig.HARD_MAX : 1500);
          return {
            pass: text.length <= maxLength,
            message: text.length <= maxLength ? null : `Prompt ${text.length} 字符，超过 ${maxLength} 上限`,
            fix: `精简Prompt至 ${maxLength} 字符以内`
          };
        }
      },
      {
        id: 'NEGATIVE_PROMPT',
        name: '负向提示词检查',
        check: (prompt) => {
          const text = prompt.prompt || '';
          // 【修复】支持多种负向提示词标记：【负面约束】、【负向】、negative 字段
          const hasNegative = /【负面约束】|【负向】/.test(text) || prompt.negativePrompt || prompt.negative;
          return {
            pass: hasNegative,
            message: hasNegative ? null : '未找到负向提示词',
            fix: '添加【负面约束】或【负向】标记和负向提示词内容',
            severity: 'warning'
          };
        }
      }
    ];
  }

  /**
   * SuperMickey 主入口：批量检查 Prompts
   * @param {Array} prompts - SuperMickey 格式的 prompts 数组
   * @param {Object} options - 检查选项
   * @returns {Object} { pass, errors, warnings }
   */
  check(prompts, options = {}) {
    if (!this.enabled) {
      return { pass: true, errors: [], warnings: [] };
    }

    const errors = [];
    const warnings = [];

    console.log('🛡️ 【PipelineGuard】启动渲染管线检查...');

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const promptId = prompt.shotId || `prompt_${i}`;

      for (const rule of this.requiredRules) {
        // 如果选项中明确禁用了该规则，则跳过
        if (options.disabledRules?.includes(rule.id)) continue;

        const result = rule.check(prompt);
        
        if (!result.pass) {
          const issue = {
            ruleId: rule.id,
            ruleName: rule.name,
            promptId,
            message: result.message,
            fix: result.fix,
            severity: result.severity || 'error'
          };

          if (result.severity === 'warning') {
            warnings.push(issue);
            console.log(`  🟡 [${rule.name}] ${promptId}: ${result.message}`);
          } else {
            errors.push(issue);
            console.log(`  🔴 [${rule.name}] ${promptId}: ${result.message}`);
          }
        }
      }
    }

    const pass = this.strictMode ? errors.length === 0 : true;

    console.log(`✅ 【PipelineGuard】检查完成: ${errors.length} 错误, ${warnings.length} 警告`);

    // 保存日志
    this._saveLog(errors, warnings);

    return { pass, errors, warnings };
  }

  _saveLog(errors, warnings) {
    try {
      const logEntry = {
        timestamp: new Date().toISOString(),
        errorCount: errors.length,
        warningCount: warnings.length,
        errors: errors.map(e => ({ rule: e.ruleName, prompt: e.promptId, message: e.message })),
        warnings: warnings.map(w => ({ rule: w.ruleName, prompt: w.promptId, message: w.message }))
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
      console.warn('⚠️ PipelineGuard 日志保存失败:', e.message);
    }
  }
}

module.exports = { RenderPipelineGuard };
