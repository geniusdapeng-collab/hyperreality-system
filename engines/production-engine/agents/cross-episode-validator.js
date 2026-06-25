// cross-episode-validator.js
// 跨集内容边界校验器
// 在ContinuityReview后运行，检测越界内容
// v1.0 | 2026-06-21

const fs = require('fs');
const path = require('path');

class CrossEpisodeValidator {
  constructor(options = {}) {
    this.config = {
      // LLM配置
      llmEngine: options.llmEngine || null,
      model: options.model || 'kimi-k2p6',
      timeout: options.timeout || 120000,
      // 置信度阈值
      confidence: {
        ignoreThreshold: 0.4,    // 低于此值丢弃
        blockThreshold: 0.75     // 低于此值的高严重度降级为warn
      },
      // 硬校验处置
      hardValidation: {
        forbiddenZoneViolation: 'block',
        nextEpisodePreview: 'block',
        responsibilityMissing: 'warn',
        bufferOverExpansion: 'warn'
      },
      // 缓冲区限制
      narrativeFlexibility: {
        maxBufferMentionDuration: 15,    // 秒
        maxForbiddenMentionDuration: 5   // 秒
      },
      ...options
    };
  }

  /**
   * 主校验入口
   * @param {object} params - 校验参数
   * @param {string} params.script - 脚本文本（从scenes中提取的台词+描述）
   * @param {object} params.contract - 边界契约
   * @param {number} params.episodeIndex - 当前集编号
   * @param {number} params.totalEpisodes - 总集数
   * @param {string} params.overrideReason - 覆盖原因（可选）
   * @returns {object} 校验报告
   */
  async validate({ script, contract, episodeIndex, totalEpisodes, overrideReason }) {
    console.log(`[CrossEpisodeValidator] 开始校验第${episodeIndex}集/共${totalEpisodes}集...`);

    // 如果提供了覆盖原因，直接通过
    if (overrideReason) {
      console.log(`[CrossEpisodeValidator] 收到override: ${overrideReason}`);
      return {
        passed: true,
        override: true,
        overrideReason,
        violations: [],
        summary: '校验已覆盖（人工确认）'
      };
    }

    const violations = [];

    // ====== 第一层：正则快筛 ======
    console.log(`[CrossEpisodeValidator] 第一层：正则快筛...`);
    const regexViolations = this._regexScan(script, contract);
    violations.push(...regexViolations);

    // ====== 第二层：LLM语义校验（仅当第一层有命中或强制开启时） ======
    if (regexViolations.length > 0 || this.config.alwaysRunLLM) {
      console.log(`[CrossEpisodeValidator] 第二层：LLM语义校验...`);
      try {
        const llmViolations = await this._llmSemanticScan(script, contract, episodeIndex, totalEpisodes);
        violations.push(...llmViolations);
      } catch (err) {
        console.warn(`[CrossEpisodeValidator] LLM语义校验失败: ${err.message}，使用正则结果`);
      }
    }

    // ====== 去重与置信度分级 ======
    const deduped = this._deduplicateAndGrade(violations);

    // ====== 生成报告 ======
    const criticalCount = deduped.filter(v => v.action === 'block').length;
    const warnCount = deduped.filter(v => v.action === 'warn').length;

    const report = {
      passed: criticalCount === 0,
      episodeIndex,
      totalEpisodes,
      violations: deduped,
      stats: {
        total: deduped.length,
        critical: criticalCount,
        warning: warnCount,
        passed: deduped.length === 0
      },
      summary: deduped.length === 0 
        ? '✅ 跨集边界校验通过，未发现越界内容'
        : `⚠️ 发现 ${deduped.length} 个问题：${criticalCount} 个严重（需处理），${warnCount} 个警告`
    };

    console.log(`[CrossEpisodeValidator] 校验完成: ${report.summary}`);
    return report;
  }

  /**
   * 正则快筛层
   */
  _regexScan(script, contract) {
    const violations = [];
    if (!script || !contract) return violations;

    // 1. 检测下集预告语（高置信度）
    const previewPatterns = [
      { pattern: /(?:下一集|下一期|下一部|下一讲|下集|下期|下部|下讲)[\s\S]{0,20}?[讲讲说说分享介绍]/i, desc: '下集内容预告' },
      { pattern: /(?:敬请期待|未完待续|未完|待续|to be continued|coming soon|stay tuned)/i, desc: '未完待续标记' },
      { pattern: /(?:下次|下回|下一次|下一次)[\s\S]{0,15}?[讲讲说说分享介绍告诉]/i, desc: '下次预告' },
      { pattern: /(?:记住|记住这点|记住这个|记住这个)[\s\S]{0,15}?[下次下回后续]/i, desc: '暗示后续' },
      { pattern: /(?:后续|之后|后面|接下来)[\s\S]{0,15}?[分享讲说介绍告诉]/i, desc: '后续内容预告' },
      { pattern: /(?:后面|之后|随后|接下来)[\s\S]{0,15}?[再讲讲再说再分享]/i, desc: '后续内容预告' }
    ];

    for (const { pattern, desc } of previewPatterns) {
      const match = script.match(pattern);
      if (match) {
        violations.push({
          type: 'next_episode_preview',
          description: desc,
          matchedText: match[0].substring(0, 100),
          severity: 'high',
          confidence: 0.95, // 正则高置信度
          location: this._extractLocation(script, match.index),
          action: 'block'
        });
      }
    }

    // 2. 检测禁区关键词（中高置信度，需结合LLM确认是否"深入展开"）
    if (contract.mustNotCover) {
      for (const topic of contract.mustNotCover) {
        // 检查是否出现禁区关键词 + 详细展开特征（>50字连续描述）
        const topicRegex = new RegExp(topic.substring(0, 20), 'i'); // 取前20字做模糊匹配
        if (topicRegex.test(script)) {
          // 检查周围是否有详细展开的迹象（多句描述、列举、解释）
          const context = this._extractContext(script, topic, 200);
          if (context && context.length > 100) {
            violations.push({
              type: 'forbidden_zone',
              description: `检测到禁区内容"${topic.substring(0, 30)}..."可能深入展开`,
              matchedText: context.substring(0, 150),
              severity: 'high',
              confidence: 0.7, // 需要LLM确认
              location: this._extractLocation(script, script.indexOf(topic.substring(0, 20))),
              action: 'block'
            });
          }
        }
      }
    }

    // 3. 检测"本集是系列第X集"的自我引用（低严重度，仅提醒）
    if (script.match(/(?:这是|本集是|本视频是|本期是)[\s\S]{0,10}(?:第[一二三四五六七八九十\d]+集|系列第[\d]+集)/i)) {
      violations.push({
        type: 'series_self_reference',
        description: '脚本中自我引用集数位置',
        matchedText: '检测到集数自我引用',
        severity: 'info',
        confidence: 0.6,
        action: 'warn'
      });
    }

    return violations;
  }

  /**
   * LLM语义校验层
   */
  async _llmSemanticScan(script, contract, episodeIndex, totalEpisodes) {
    if (!this.config.llmEngine) {
      console.warn('[CrossEpisodeValidator] 未配置LLM引擎，跳过语义校验');
      return [];
    }

    const prompt = `你是一名专业的视频内容审查员。请审查以下视频脚本，判断是否存在"跨集内容越界"问题。

## 审查标准

1. **下集预告检测**：脚本结尾或台词中是否暗示/预告了后续集的内容？
   - 明显的预告语："下一集讲...""敬请期待""未完待续"
   - 模糊预告："后面会分享...""记住这点，后续有用""我们后面再讲"
   - 如果发现有"后续/后面/下次/下一集"等暗示，且实质指向后续内容 → 越界

2. **禁区深入展开**：脚本是否详细讲解了本集不应该讲的内容？
   - 本集不应该讲：${contract.mustNotCover?.join('、') || '后续集内容'}
   - 如果对这些内容进行了详细解释（>3句话、有具体步骤/方法/数据）→ 越界
   - 如果仅一句话带过（≤15秒）→ 不越界

3. **重复冗余**：脚本是否重复了前面已经详细讲过的内容？
   - 前面已讲：${contract.previousSummary || '见前一集'}
   - 如果花大篇幅重复前面已讲的内容 → 冗余

## 脚本内容

${script.substring(0, 3000)}${script.length > 3000 ? '\n...（脚本截断，剩余' + (script.length - 3000) + '字）' : ''}

## 输出要求

请输出JSON格式：
{
  "violations": [
    {
      "type": "next_episode_preview | forbidden_zone | repetition",
      "description": "问题描述（50字以内）",
      "confidence": 0.0-1.0,  // 你对此判断的置信度
      "severity": "high | medium | low",
      "evidence": "脚本中的具体文本证据（100字以内）"
    }
  ],
  "summary": "总体判断：pass（通过）/ warn（有警告）/ block（有严重越界）"
}

注意：
- 如果仅一句话带过（≤15秒），不算越界
- 自然收束结尾（如"希望有帮助"）不算预告
- 如果判断不准确，confidence可以低于0.5`;

    // 【v2.1.4-fix13-审计修复】增加超时保护 + 适配 BaseAgent 的 LLM 引擎 API
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error('CrossEpisodeValidator LLM 超时')),
        this.config.timeout
      );
    });

    try {
      let responseText = '';

      // 优先用 chat 方法（BaseAgent 引擎的标准接口）
      if (typeof this.config.llmEngine.chat === 'function') {
        responseText = await Promise.race([
          this.config.llmEngine.chat(
            '你是一位严格但公正的内容审查员。只输出JSON，不要解释。',
            prompt,
            0.2
          ),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
      }
      // 兼容 reasonStructured 方法
      else if (typeof this.config.llmEngine.reasonStructured === 'function') {
        const result = await Promise.race([
          this.config.llmEngine.reasonStructured(prompt, null, {
            maxTokens: 2000,
            timeoutMs: this.config.timeout
          }),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        responseText = result?.data ? JSON.stringify(result.data) : '';
      }
      // 兼容 generate 方法（如果引擎实现了的话）
      else if (typeof this.config.llmEngine.generate === 'function') {
        const result = await Promise.race([
          this.config.llmEngine.generate(prompt, {
            systemPrompt: '你是一位严格但公正的内容审查员。只输出JSON，不要解释。',
            maxTokens: 2000,
            timeoutMs: this.config.timeout,
            forceJson: true
          }),
          timeoutPromise
        ]).finally(() => clearTimeout(timer));
        responseText = result?.content || '';
      } else {
        throw new Error('LLM引擎没有可用的方法(chat/reasonStructured/generate)');
      }

      if (!responseText) {
        return [];
      }

      let parsed;
      try {
        parsed = JSON.parse(responseText.trim());
      } catch (e) {
        // 尝试从文本中提取JSON
        const jsonMatch = responseText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            parsed = JSON.parse(jsonMatch[0]);
          } catch (e2) {
            return [];
          }
        } else {
          return [];
        }
      }

      if (!parsed.violations || !Array.isArray(parsed.violations)) {
        return [];
      }

      return parsed.violations.map(v => ({
        type: v.type || 'unknown',
        description: v.description || '语义校验发现问题',
        matchedText: v.evidence || '',
        severity: v.severity || 'medium',
        confidence: Math.max(0, Math.min(1, v.confidence || 0.5)),
        location: null,
        action: this._determineAction(v.type, v.severity, v.confidence)
      }));

    } catch (err) {
      console.warn(`[CrossEpisodeValidator] LLM语义校验异常: ${err.message}`);
      return [];
    }
  }

  /**
   * 去重与置信度分级
   */
  _deduplicateAndGrade(violations) {
    // 按类型和位置去重
    const seen = new Set();
    const deduped = [];

    for (const v of violations) {
      const key = `${v.type}-${v.description?.substring(0, 30)}`;
      if (seen.has(key)) continue;
      seen.add(key);

      // 置信度分级
      const conf = v.confidence || 0.5;
      if (conf < this.config.confidence.ignoreThreshold) {
        continue; // 丢弃噪音
      }

      if (conf < this.config.confidence.blockThreshold && v.severity === 'high') {
        v.severity = 'medium'; // 降级
        v.action = 'warn';
      }

      deduped.push(v);
    }

    return deduped;
  }

  /**
   * 确定处置方式
   */
  _determineAction(type, severity, confidence) {
    const mapping = this.config.hardValidation;

    if (type === 'next_episode_preview') {
      return confidence >= 0.75 ? mapping.nextEpisodePreview : 'warn';
    }
    if (type === 'forbidden_zone') {
      return confidence >= 0.75 ? mapping.forbiddenZoneViolation : 'warn';
    }
    if (type === 'repetition') {
      return mapping.bufferOverExpansion || 'warn';
    }

    return severity === 'high' ? 'block' : 'warn';
  }

  /**
   * 提取文本位置（行号）
   */
  _extractLocation(script, index) {
    if (index === -1 || index === null) return null;
    const linesBefore = script.substring(0, index).split('\n').length;
    return `第${linesBefore}行附近`;
  }

  /**
   * 提取上下文
   */
  _extractContext(script, topic, windowSize) {
    const idx = script.indexOf(topic.substring(0, 20));
    if (idx === -1) return null;
    const start = Math.max(0, idx - windowSize / 2);
    const end = Math.min(script.length, idx + windowSize / 2);
    return script.substring(start, end);
  }

  /**
   * 从shots中提取可校验的文本
   * 【v2.1.4-fix13-审计修复】适配 ProductionEngine 实际输出的字段名
   */
  static extractScriptText(shots) {
    if (!Array.isArray(shots)) return '';

    const texts = [];
    for (const shot of shots) {
      // 【修复】适配 ProductionEngine 实际输出的字段名
      if (shot.scene) texts.push(String(shot.scene));
      if (shot.sceneDescription) texts.push(String(shot.sceneDescription));
      if (shot.action) texts.push(String(shot.action));
      if (shot.mood) texts.push(String(shot.mood));

      // 台词：可能是字符串、数组、或对象
      if (shot.dialogue) {
        if (typeof shot.dialogue === 'string') {
          texts.push(shot.dialogue);
        } else if (Array.isArray(shot.dialogue)) {
          for (const line of shot.dialogue) {
            if (typeof line === 'string') texts.push(line);
            else if (line?.text) texts.push(line.text);
            else if (line?.content) texts.push(line.content);
          }
        } else if (shot.dialogue?.lines) {
          for (const line of shot.dialogue.lines) {
            if (line.text) texts.push(line.text);
          }
        }
      }

      // fields 嵌套对象中的文本
      if (shot.fields) {
        if (shot.fields.scene) texts.push(String(shot.fields.scene));
        if (shot.fields.action) texts.push(String(shot.fields.action));
        if (shot.fields.dialogue) texts.push(String(shot.fields.dialogue));
      }
    }

    return texts.filter(t => t && t.trim()).join('\n');
  }
}

module.exports = { CrossEpisodeValidator };
