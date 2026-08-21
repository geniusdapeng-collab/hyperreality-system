/**
 * Phase 3: PromptFusion 串行执行
 * 
 * 职责：
 * - 串行执行 PromptFusion Agent（每镜头独立 LLM 调用）
 * - 动态预算计算（根据镜头数）
 * - 合并 25 字段到 shots
 * - 保存 checkpoint
 */

const { PhaseExecutor } = require('./phase-executor');
const { DialogueTimingCalculator } = require('../../../utils/dialogue-timing-calculator');
const ThemeConfig = require('../../../config/theme-config');

class Phase3PromptFusion extends PhaseExecutor {
  constructor(options) {
    super({ name: 'Phase3-PromptFusion', ...options });
  }

  async execute(state) {
    const { shots, result, adaptedBlueprint } = state;
    const startTime = Date.now();
    const shotCount = shots.length;

    // 动态预算计算
    // 【v2.1.8-fix】从 agentConfig 读取实际 llmTimeout，而非硬编码
    // 【修复 P1-7】默认值与 PromptFusionAgent 一致（300s），避免预算估算严重偏低
    const actualLLMTimeout = this.agentConfig?.llmTimeout || 300000;
    const actualRetries = this.agentConfig?.llmMaxRetries || 1;
    // 单镜头预算 = LLM超时 × (1 + 重试次数) + 解析/校验开销
    const PHASE3_PER_SHOT_MS = actualLLMTimeout * (1 + actualRetries) + 30000;   // 正常模式
    const PHASE3_FAST_PER_SHOT_MS = actualLLMTimeout + 20000;                  // fastMode 不重试
    const PHASE3_BUFFER_MS = 60000;     // 1分钟缓冲（原为2分钟）
    
    // 判断是否需要启用 fastMode
    const standardNeedMs = shotCount * PHASE3_PER_SHOT_MS + PHASE3_BUFFER_MS;
    const budgetRemaining = this.budgetRemaining ? this.budgetRemaining() : Infinity;
    const useFastMode = budgetRemaining < standardNeedMs && budgetRemaining > shotCount * PHASE3_FAST_PER_SHOT_MS;
    
    const perShotMs = useFastMode ? PHASE3_FAST_PER_SHOT_MS : PHASE3_PER_SHOT_MS;
    const needMs = shotCount * perShotMs + PHASE3_BUFFER_MS;

    this.log('PHASE-3', `📊 动态预算: ${shotCount}镜头 × ${perShotMs/1000}s${useFastMode ? '(fastMode)' : ''} + ${PHASE3_BUFFER_MS/1000}s缓冲 = 需${Math.round(needMs/1000)}s`);
    if (useFastMode) {
      this.log('PHASE-3', '⚡ fastMode 已启用：预算不足，缩短单镜头超时、禁用重试');
    }

    // 预算检查
    // 【v2.1.6-fix】Phase 3 是核心环节，预算不足时告警但继续执行，不可跳过
    const canAfford = this.checkBudget(needMs, 'Phase 3');
    if (!canAfford) {
      this.log('PHASE-3', '⚠️ 预算不足，但 Phase 3 是核心环节，继续执行（可能超时）');
    }

    try {
      // 【v2.1.8-fix】强制下限：从环境变量读取，默认 60 分钟
      const totalRemainingMs = this.budgetRemaining ? this.budgetRemaining() : parseInt(process.env.STORMAXE_TOTAL_DEADLINE_MS || '3600000');
      const minLongTaskTimeoutMs = Number(process.env.STORMAXE_MIN_LONG_TASK_TIMEOUT_MS || process.env.STORMAXE_TOTAL_DEADLINE_MS || '3600000');
      const phase3Timeout = Math.max(totalRemainingMs, minLongTaskTimeoutMs);
      if (this.healthMonitor) {
        this.healthMonitor.setLongTaskMode('ProductionEngine', true, phase3Timeout);
      } else {
        console.log('[Phase3PromptFusion] ⚠️ healthMonitor 未设置，长时间任务模式未启用');
      }

      this.log('PROMPT-FUSION-AGENT', `开始(串行模式,${shotCount}镜头,${useFastMode ? 'fastMode,' : ''}预计${Math.round(needMs/1000)}s)...`);
      
      // 【v2.1.8-fix】fastMode 下保留重试（应对429），不缩短超时（避免镜头预算不足）
      if (useFastMode && this.agents.promptFusion) {
        this.agents.promptFusion.llmMaxRetries = 1; // fastMode 保留1次重试
        this.log('PHASE-3', '⚡ fastMode 配置已下发：retries=1（timeout不变）');
      }
      
      // 【架构-L3】技能预匹配：在 PromptFusion 逐镜头生成前完成【fix-3A1】
      const { routeAndEnhanceV3, assignFilmDirector, getSkillQCBlocks, checkSkillCompliance } = require('../../../skills/hollywood-cinematography/cinematography-skill-router');
      // 【v2.3.3-A2】一部片一位导演：蓝图阶段选定，全片镜头共享同一风格宪法
      const filmDirectorAssignment = assignFilmDirector(adaptedBlueprint || {});
      const filmDirector = filmDirectorAssignment.director;
      const filmGenre = (adaptedBlueprint && (adaptedBlueprint.genre || adaptedBlueprint.type)) || '';
      this.log('SKILL-PREMATCH', `全片导演选定: ${filmDirector}（来源: ${filmDirectorAssignment.source}）`);
      // 【v2.4.0-B2】LLM 语义路由：结构化触发器粗筛 Top8 后由 LLM 精选；
      // caller 注入失败/异常时自动降级 V2 打分，语义层永不阻断生产
      const skillLlmCaller = this.agents.promptFusion ? async (prompt) => {
        try {
          const r = await this.agents.promptFusion._callLLM(prompt, { required: ['picks'] }, () => null, { critical: false });
          return r && r.result ? r.result : null;
        } catch (e) { return null; }
      } : null;
      const skillPlan = await routeAndEnhanceV3(shots, { minScore: 5, maxSkillsPerShot: 2, assignedDirector: filmDirector, filmGenre, llmCaller: skillLlmCaller });
      shots = shots.map(s => {
        const plan = skillPlan.get(s.shotId || s.shot_id);
        if (plan && plan.contextText) {
          s._skillContext = plan.contextText;
          s._skillMatched = plan.matched;
        }
        return s;
      });
      this.log('SKILL-PREMATCH', `技能预匹配完成: ${[...skillPlan.values()].filter(p => p.matched.length).length}/${shots.length} 镜头命中`);
      // 计量落盘（L4 遥测）
      result.stages = result.stages || {};
      result.stages.skillPrematch = [...skillPlan.entries()].map(([shotId, p]) => ({
        shotId,
        type: p.type,
        director: p.director,
        ...p.matched.length ? { skills: p.matched.map(m => m.file), scores: p.matched.map(m => m.score), injection: 'pre' } : { skills: [], injection: 'none' }
      }));
      // 【v2.3.3-A7】技能使用遥测落盘：真实命中率/墙纸率/类别分布从此可度量
      try {
        const fs = require('fs');
        const path = require('path');
        const telemetryDir = path.join(__dirname, '..', '..', '..', '..', 'logs', 'skill-usage');
        fs.mkdirSync(telemetryDir, { recursive: true });
        const perShot = [...skillPlan.entries()].map(([shotId, p]) => ({
          shotId, type: p.type, director: p.director, directorSource: p.directorSource, router: p.router || 'v2-score',
          skills: p.matched.map(m => ({ file: m.file, score: m.score, reasons: m.reasons, fallback: m.fallback, domain: m.domain, llmReason: m.llmReason || null }))
        }));
        const allUsed = perShot.flatMap(p => p.skills.map(s => s.file));
        const record = {
          ts: new Date().toISOString(),
          task: (adaptedBlueprint && (adaptedBlueprint.task_id || adaptedBlueprint.title)) || null,
          filmDirector,
          filmDirectorSource: filmDirectorAssignment.source,
          filmGenre: filmGenre || null,
          totalShots: perShot.length,
          matchedShots: perShot.filter(p => p.skills.length > 0).length,
          distinctSkills: [...new Set(allUsed)],
          // 墙纸镜头：无 emotion 命中理由的低分匹配（凑数注入）
          wallpaperShots: perShot.filter(p => p.skills.length > 0 && !p.skills.some(s => (s.reasons || []).includes('emotion'))).map(p => p.shotId),
          perShot
        };
        fs.appendFileSync(path.join(telemetryDir, 'skill-usage.jsonl'), JSON.stringify(record) + '\n');
      } catch (telemetryErr) {
        this.log('SKILL-TELEMETRY', `遥测落盘失败（不影响主流程）: ${telemetryErr.message}`);
      }

      const pfResult = await this.agents.promptFusion.process(
        this.cloneShots(shots), 
        adaptedBlueprint,
        {
          checkpointManager: this.checkpointManager,
          blueprintHash: this._computeBlueprintHash(adaptedBlueprint)
        }
      );

      // 合并 25 个字段（完整回滚）
      const newShots = this.mergeShots(shots, pfResult.shots, [
        'prompt', 'enhanced_prompt', 'negative_prompt', 'fields', 'fusionText', 'promptCharCount',
        'director_instruction', 'constraint', 'baseline', 'scene', 'lighting', 'composition',
        'color_palette', 'depth_of_field', 'camera_movement', 'character', 'costume', 'makeup',
        'action', 'props', 'portraits', 'dialogue', 'timeline', 'mood', 'pacing', 'transition',
        'audio', 'negative', 'bright_constraint', 'character_constraint', 'consistency'
      ]);

      // 【v2.2.0-Phase3】台词-镜头时长映射检查
      const timingCheckedShots = await this._checkDialogueTiming(newShots, adaptedBlueprint);

      // 【v2.4.0-B3】技能质检进评审：被注入技能的质检清单成为验收标准，
      // 生成与裁决用同一套尺度；机械违规（技能禁止词残留）在此拦截
      try {
        let qcChecked = 0;
        const qcViolations = [];
        for (const s of timingCheckedShots) {
          const files = (s._skillMatched || []).map(m => m.file);
          if (files.length === 0) continue;
          const entries = getSkillQCBlocks(files);
          const finalText = [s.prompt, s.enhanced_prompt, s.fusionText, s.director_instruction].filter(Boolean).join('\n');
          const violations = entries.flatMap(e =>
            checkSkillCompliance(finalText, e).map(term => ({ skill: e.file, term }))
          );
          s._skillQC = {
            skills: files,
            checklistCount: entries.reduce((n, e) => n + e.qc.length, 0),
            violations
          };
          qcChecked++;
          if (violations.length > 0) {
            qcViolations.push({ shotId: s.shotId || s.shot_id, violations });
          }
        }
        result.stages = result.stages || {};
        result.stages.skillQC = { checked: qcChecked, violatedShots: qcViolations.length, details: qcViolations };
        this.log('SKILL-QC', `技能质检: ${qcChecked} 镜头受检，${qcViolations.length} 镜头存在技能禁止词残留`);
      } catch (qcErr) {
        this.log('SKILL-QC', `技能质检异常（不影响主流程）: ${qcErr.message}`);
      }

      result.llmStats.promptFusion = pfResult.timing;
      
      const timing = Date.now() - startTime;
      this.log('PROMPT-FUSION-AGENT', `完成 (${timing}ms)`);

      // 保存 checkpoint
      await this.saveCheckpoint('phase3', timingCheckedShots, {
        opening: result.opening,
        llmStats: result.llmStats
      });

      return { success: true, shots: timingCheckedShots, result, timing };
    } catch (e) {
      this.log('PROMPT-FUSION-FAIL', `❌ ${e.message},部分镜头降级到规则 Prompt`);
      return { success: false, shots, result, timing: Date.now() - startTime, error: e.message };
    } finally {
      // 【v2.1.8-fix3-专家方案】延迟关闭，避免刚完成checkpoint合并时被心跳检查误判
      // 【修复 P3-2】存储 timer handle + unref，防止进程被悬空 timer 吊住 60s
      if (this.healthMonitor) {
        const delayMs = Number(process.env.STORMAXE_LONG_TASK_CLOSE_DELAY_MS || 60000);
        this._longTaskCloseTimer = setTimeout(() => {
          try {
            this.healthMonitor.setLongTaskMode('ProductionEngine', false);
          } catch (_) {}
          this._longTaskCloseTimer = null;
        }, delayMs);
        if (typeof this._longTaskCloseTimer.unref === 'function') {
          this._longTaskCloseTimer.unref();
        }
      }
    }
  }
  /**
   * 【v2.2.0-Phase3】台词-镜头时长映射检查
   * 在 PromptFusion 后、checkpoint 前执行
   * - 检测台词溢出（台词时长 > 镜头时长）
   * - 检测台词占比过高（>80%）
   * - 根据类型自动选择调整策略
   */
  async _checkDialogueTiming(shots, blueprint) {
    // 【v2.1.11-重构】台词策略由 productionProfile.dialogue_density 驱动，
    // 不再用类型白名单（原方案把 DRAMA/MV/VLOG 等 legacy 类型全部误判为 shorten）
    const { dialogueStrategy } = require('../../../config/production-profile');
    const profile = blueprint?.productionProfile
      || blueprint?.config?.productionProfile
      || blueprint?.requirementList?.productionProfile
      || null;
    const strategy = dialogueStrategy(profile || {});
    const videoTypeLabel = blueprint?.genre || blueprint?.requirementList?.genre || '通用';

    const calculator = new DialogueTimingCalculator({
      autoAdjust: true,
      adjustStrategy: strategy
    });

    this.log('DIALOGUE-TIMING', `开始检查 (${videoTypeLabel} 题材, 台词密度=${(profile || {}).dialogue_density || 'medium'}, 策略:${strategy})...`);
    
    const checkResult = calculator.validateShots(shots);
    
    if (checkResult.criticalCount > 0) {
      this.log('DIALOGUE-TIMING', `⚠️ 发现 ${checkResult.criticalCount} 个镜头台词溢出，自动调整中...`);
    }
    if (checkResult.warningCount > 0) {
      this.log('DIALOGUE-TIMING', `⚡ 发现 ${checkResult.warningCount} 个镜头台词占比过高`);
    }
    
    // 应用自动修复到 shots
    const adjustedShots = shots.map((shot, index) => {
      const result = checkResult.results[index];
      if (!result || !result.hasDialogue) return shot;
      
      const metadata = {
        dialogueTiming: {
          checked: true,
          dialogueDuration: result.dialogueDuration,
          shotDuration: result.shotDuration,
          ratio: result.ratio,
          severity: result.severity,
          issue: result.issue
        }
      };
      
      // 如果有 autoFix，应用修复
      if (result.autoFix) {
        metadata.dialogueTiming.autoFix = result.autoFix;
        
        if (result.autoFix.type === 'shorten_dialogue' && shot.dialogue) {
          // 应用缩短后的台词
          const suggestedText = result.autoFix.suggestedText;
          if (suggestedText && shot.dialogue.lines) {
            shot.dialogue.lines[0].text = suggestedText;
            this.log('DIALOGUE-TIMING', `✂️ ${shot.shot_id || shot.shotId}: 台词已缩短 ${result.autoFix.originalChars}→${result.autoFix.targetChars} 字`);
          }
        } else if (result.autoFix.type === 'extend_shot') {
          // 延长镜头时长
          const newDuration = result.autoFix.suggestedDuration;
          if (shot.duration !== undefined) {
            shot.duration = newDuration;
            this.log('DIALOGUE-TIMING', `⏱️ ${shot.shot_id || shot.shotId}: 镜头时长已延长 ${result.autoFix.originalDuration}→${newDuration}s`);
          } else if (shot.timing) {
            shot.timing.duration = newDuration;
            this.log('DIALOGUE-TIMING', `⏱️ ${shot.shot_id || shot.shotId}: 镜头时长已延长 ${result.autoFix.originalDuration}→${newDuration}s`);
          }
        }
      }
      
      // 合并 metadata 到 shot
      return { ...shot, ...metadata };
    });
    
    this.log('DIALOGUE-TIMING', `完成 | 总镜头:${checkResult.totalShots} | 含台词:${checkResult.shotsWithDialogue} | 严重:${checkResult.criticalCount} | 警告:${checkResult.warningCount}`);
    
    return adjustedShots;
  }
  /**
   * 【v2.1.8-fix】计算 blueprint 的简易 hash，用于断点续跑匹配
   */
  _computeBlueprintHash(blueprint) {
    const crypto = require('crypto');
    const str = JSON.stringify({
      title: blueprint.title,
      scenes: blueprint.scenes?.map(s => s.scene_id),
      characters: blueprint.character_system?.characters?.map(c => c.id),
      config: blueprint.config
    });
    return crypto.createHash('md5').update(str).digest('hex').substring(0, 16);
  }
}

module.exports = { Phase3PromptFusion };