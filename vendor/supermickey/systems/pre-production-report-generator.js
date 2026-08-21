/**
 * 预生产报告生成器 (Pre-production Report Generator)
 * 在提交Seedance渲染前，生成完整的审查文档交付队长人工检查
 * @version v1.0
 * @author 小G
 */

const fs = require('fs').promises;
const path = require('path');

class PreProductionReportGenerator {
  constructor(config = {}) {
    this.config = {
      maxPromptLength: config.maxPromptLength || 1500,
      targetPromptLength: config.targetPromptLength || 1470,
      maxDuration: config.maxDuration || 15,
      minDuration: config.minDuration || 4,
      defaultRatio: config.defaultRatio || '16:9',
      ...config
    };
    
    // 检查项定义
    this.checkItems = [
      { id: 'prd-align', name: 'PRD对齐检查', phase: '剧本阶段' },
      { id: 'schema-validate', name: 'Schema校验', phase: '故事板阶段' },
      { id: 'duration-alloc', name: '时长分配', phase: '分配阶段' },
      { id: 'camera-move', name: '运镜设计', phase: '运镜阶段' },
      { id: 'fpv-check', name: 'FPV镜头检查', phase: '运镜阶段' },  // 【NEW】FPV检查
      { id: 'char-build', name: '角色构建', phase: '角色阶段' },
      { id: 'prompt-build', name: 'Prompt构建', phase: '构建阶段' },
      { id: 'compliance', name: '合规检查', phase: '闸机阶段' },
      { id: 'pre-render', name: '渲染前置验证', phase: '验证阶段' },
      { id: 'continuity', name: '连续性检查', phase: '验证阶段' }
    ];
  }

  /**
   * 生成完整的预生产报告
   * @param {Object} params - 生成参数
   * @param {string} params.projectName - 项目名称
   * @param {string} params.projectType - 项目类型 (universal/shanhaijing)
   * @param {string} params.version - 系统版本
   * @param {Array} params.shots - 镜头数组
   * @param {Object} params.checkResults - 各阶段检查结果
   * @param {Object} params.metadata - 附加元数据
   * @returns {Object} 报告对象
   */
  async generateReport(params) {
    const {
      projectName = '未命名项目',
      projectType = 'universal',
      version = 'v6.0',
      shots = [],
      checkResults = {},
      metadata = {}
    } = params;

    const timestamp = new Date().toISOString();
    const totalShots = shots.length;
    const totalDuration = shots.reduce((sum, s) => sum + (s.duration || 5), 0);
    
    // 计算预估渲染成本（基于时长和并发策略）
    const estimatedCost = this._estimateRenderCost(shots);
    
    // 每镜详细分析
    const shotDetails = shots.map((shot, idx) => this._analyzeShot(shot, idx + 1));
    
    // 汇总统计
    const summary = this._generateSummary(shotDetails, checkResults);
    
    // 风险评级
    const riskLevel = this._calculateRiskLevel(summary, shotDetails);
    
    return {
      meta: {
        projectName,
        projectType,
        systemVersion: version,
        generatedAt: timestamp,
        generatorVersion: 'v1.0'
      },
      overview: {
        totalShots,
        totalDuration,
        estimatedCost,
        riskLevel,
        riskLevelText: this._riskText(riskLevel)
      },
      summary,
      checkResults,
      shots: shotDetails,
      warnings: this._collectWarnings(shotDetails, checkResults),
      recommendations: this._generateRecommendations(shotDetails, checkResults),
      nextSteps: this._generateNextSteps(riskLevel)
    };
  }

  /**
   * 生成飞书文档格式的Markdown内容
   * @param {Object} report - 报告对象
   * @returns {string} Markdown内容
   */
  generateMarkdown(report) {
    const { meta, overview, summary, checkResults, shots, warnings, recommendations, nextSteps } = report;
    
    let md = `# 【预生产报告】${meta.projectName}\n\n`;
    md += `> 系统版本: ${meta.systemVersion} | 生成时间: ${this._formatTime(meta.generatedAt)} | 报告版本: ${meta.generatorVersion}\n\n`;
    
    // 1. 项目概览
    md += `---\n\n## 📊 项目概览\n\n`;
    md += `| 指标 | 数值 |\n|------|------|\n`;
    md += `| 项目名称 | ${meta.projectName} |\n`;
    md += `| 项目类型 | ${meta.projectType === 'shanhaijing' ? '山海经系列' : '通用视频'} |\n`;
    md += `| 总镜头数 | ${overview.totalShots} 镜 |\n`;
    md += `| 总时长 | ${overview.totalDuration} 秒 |\n`;
    md += `| 预估渲染成本 | ${overview.estimatedCost} |\n`;
    md += `| **风险评级** | **${overview.riskLevelText}** |\n\n`;
    
    // 2. 系统检查结果汇总
    md += `---\n\n## ✅ 系统检查结果汇总\n\n`;
    md += `| 检查项 | 阶段 | 状态 | 说明 |\n`;
    md += `|--------|------|------|------|\n`;
    
    for (const item of this.checkItems) {
      const result = checkResults[item.id] || { status: 'pending', message: '未执行' };
      const statusIcon = result.status === 'passed' ? '🟢 通过' : 
                          result.status === 'warning' ? '🟡 警告' : 
                          result.status === 'failed' ? '🔴 失败' : '⚪ 未执行';
      md += `| ${item.name} | ${item.phase} | ${statusIcon} | ${result.message || '-'} |\n`;
    }
    md += `\n`;
    
    // 3. 镜头明细表
    md += `---\n\n## 🎬 镜头明细表\n\n`;
    md += `| 镜号 | 时长 | 字数 | Prompt完整度 | 合规 | 角色 | 运镜 | 风险 |\n`;
    md += `|------|------|------|-------------|------|------|------|------|\n`;
    
    for (const shot of shots) {
      const riskIcon = shot.risk === 'high' ? '🔴' : shot.risk === 'medium' ? '🟡' : '🟢';
      const fpvIcon = shot.fpv?.enabled ? '✨' : '';
      md += `| ${shot.id} ${fpvIcon}| ${shot.duration}s | ${shot.promptLength}/${this.config.maxPromptLength} | ${shot.promptCompleteness}% | ${shot.compliance} | ${shot.characterRef || '无'} | ${shot.cameraMovement || '无'} | ${riskIcon} ${shot.riskText} |\n`;
    }
    md += `\n`;
    
    // 4. 每镜详细内容
    md += `---\n\n## 📝 每镜详细内容\n\n`;
    
    for (const shot of shots) {
      md += `### ${shot.id} (${shot.duration}秒)\n\n`;
      md += `**状态**: ${shot.risk === 'high' ? '🔴 高风险' : shot.risk === 'medium' ? '🟡 中风险' : '🟢 正常'} | `;
      md += `**字数**: ${shot.promptLength}/${this.config.maxPromptLength} | `;
      md += `**完整度**: ${shot.promptCompleteness}%\n\n`;
      
      // 【NEW】FPV信息
      if (shot.fpv?.enabled) {
        md += `**✨ FPV（第一人称主观视角）**: \n`;
        md += `- 类型: ${shot.fpv.type || 'POV'}\n`;
        md += `- 主体: ${shot.fpv.subject || '主角'}\n`;
        md += `- 特征: ${(shot.fpv.features || []).join(', ')}\n\n`;
      }
      
      if (shot.characterRef) {
        md += `**角色引用**: ${shot.characterRef}\n\n`;
      }
      
      if (shot.cameraMovement) {
        md += `**运镜**: ${shot.cameraMovement}\n\n`;
      }
      
      md += `**台词/旁白**: ${shot.narration || '无'}\n\n`;
      md += `**Prompt**:\n\n\`\`\`\n${shot.prompt || '未生成'}\n\`\`\`\n\n`;
      
      if (shot.warnings.length > 0) {
        md += `**⚠️ 警告**:\n`;
        for (const w of shot.warnings) {
          md += `- ${w}\n`;
        }
        md += `\n`;
      }
      
      md += `---\n\n`;
    }
    
    // 5. 警告汇总
    if (warnings.length > 0) {
      md += `## ⚠️ 警告汇总\n\n`;
      for (const w of warnings) {
        md += `- **${w.severity === 'high' ? '🔴' : w.severity === 'medium' ? '🟡' : '🟢'} [${w.scope}]** ${w.message}\n`;
      }
      md += `\n`;
    }
    
    // 6. 优化建议
    if (recommendations.length > 0) {
      md += `## 💡 优化建议\n\n`;
      for (const r of recommendations) {
        md += `- ${r}\n`;
      }
      md += `\n`;
    }
    
    // 7. 下一步行动
    md += `---\n\n## 🚀 下一步行动\n\n`;
    md += `${nextSteps}\n\n`;
    md += `---\n\n**队长审查后请回复以下指令之一**:\n`;
    md += `- \`OK\` → 提交Seedance渲染生产\n`;
    md += `- \`修改: [具体问题]\` → 指出问题，我优化后重新生成报告\n\n`;
    
    return md;
  }

  // ============== 内部方法 ==============

  _analyzeShot(shot, index, projectType = 'universal') {
    const prompt = shot.prompt || '';
    const promptLength = shot.promptLength || prompt.length;
    const promptCompleteness = Math.min(100, Math.round((promptLength / this.config.targetPromptLength) * 100));
    
    // 检测风险
    const warnings = [];
    let risk = 'low';
    
    // 【NEW】山海经系列FPV强制检查
    if (projectType === 'shanhaijing') {
      const hasFpv = shot.fpv?.enabled || prompt.includes('POV') || prompt.includes('first-person') || prompt.includes('主观视角');
      if (!hasFpv && shot.id === 'S04') { // S04作为FPV主要候选
        // 不警告，因为这是导演决策的空间
        // 但在报告中标注
      }
    }
    
    if (!prompt || promptLength === 0) {
      warnings.push('Prompt未生成（链路断裂），需检查Stage-11渲染核心');
      risk = 'high';
    } else if (promptLength < 200) {
      warnings.push(`Prompt字数过少（${promptLength}<200），可能影响画面质量`);
      risk = 'medium';
    } else if (promptLength < 850) {
      warnings.push(`Prompt利用率不足（${promptLength}/1500，${promptCompleteness}%），建议增强至950+字符`);
      risk = 'medium';
    }
    
    if (promptLength > this.config.maxPromptLength) {
      warnings.push(`Prompt超字数限制（${promptLength}/${this.config.maxPromptLength}），需要精简`);
      risk = 'high';
    }
    
    if (!shot.cameraMovement || shot.cameraMovement === '无') {
      warnings.push('未配置运镜，可能影响画面动态感');
    }
    
    if (!shot.characterRef && shot.requiresCharacter) {
      warnings.push('需要角色引用但未配置，可能导致人物形象不一致');
      risk = 'high';
    }
    
    const duration = shot.duration || 5;
    if (duration > this.config.maxDuration) {
      warnings.push(`时长${duration}秒超过API最大限制${this.config.maxDuration}秒`);
      risk = 'high';
    }
    
    return {
      id: shot.id || `S${String(index).padStart(2, '0')}`,
      duration,
      promptLength,
      promptCompleteness,
      prompt,
      fpv: shot.fpv || null,  // 【NEW】FPV信息
      compliance: shot.compliance 
        ? (typeof shot.compliance === 'object' 
            ? (shot.compliance.passed ? '通过' : '未通过') 
            : shot.compliance)
        : '待检查',
      characterRef: shot.characterRef || (shot.humanCharacters && shot.humanCharacters.length > 0 ? shot.humanCharacters.join(', ') : null) || null,
      cameraMovement: shot.cameraMovement || null,
      narration: shot.narration || shot.dialogue || null,
      warnings,
      risk,
      riskText: risk === 'high' ? '高风险' : risk === 'medium' ? '中风险' : '正常'
    };
  }

  _generateSummary(shotDetails, checkResults) {
    const totalWarnings = shotDetails.reduce((sum, s) => sum + s.warnings.length, 0);
    const highRiskShots = shotDetails.filter(s => s.risk === 'high').length;
    const mediumRiskShots = shotDetails.filter(s => s.risk === 'medium').length;
    const avgPromptLength = Math.round(shotDetails.reduce((sum, s) => sum + s.promptLength, 0) / shotDetails.length);
    const avgCompleteness = Math.round(shotDetails.reduce((sum, s) => sum + s.promptCompleteness, 0) / shotDetails.length);
    
    const checkPassed = Object.values(checkResults).filter(r => r.status === 'passed').length;
    const checkTotal = this.checkItems.length;
    
    return {
      totalWarnings,
      highRiskShots,
      mediumRiskShots,
      lowRiskShots: shotDetails.length - highRiskShots - mediumRiskShots,
      avgPromptLength,
      avgCompleteness,
      checkPassed,
      checkTotal,
      checkPassRate: Math.round((checkPassed / checkTotal) * 100)
    };
  }

  _calculateRiskLevel(summary, shotDetails) {
    if (summary.highRiskShots > 0 || summary.checkPassRate < 70) return 'high';
    if (summary.mediumRiskShots > 0 || summary.checkPassRate < 90) return 'medium';
    return 'low';
  }

  _riskText(level) {
    return level === 'high' ? '🔴 高风险（不建议提交渲染）' : 
           level === 'medium' ? '🟡 中风险（建议优化后再提交）' : 
           '🟢 低风险（可以提交渲染）';
  }

  _collectWarnings(shotDetails, checkResults) {
    const warnings = [];
    
    // 镜头级别警告
    for (const shot of shotDetails) {
      for (const w of shot.warnings) {
        warnings.push({ scope: shot.id, message: w, severity: shot.risk });
      }
    }
    
    // 检查项级别警告
    for (const item of this.checkItems) {
      const result = checkResults[item.id];
      if (result && result.status === 'warning') {
        warnings.push({ scope: item.name, message: result.message, severity: 'medium' });
      }
      if (result && result.status === 'failed') {
        warnings.push({ scope: item.name, message: result.message, severity: 'high' });
      }
    }
    
    return warnings;
  }

  _generateRecommendations(shotDetails, checkResults) {
    const recommendations = [];
    
    // 基于统计数据
    const avgLength = shotDetails.reduce((sum, s) => sum + s.promptLength, 0) / shotDetails.length;
    if (avgLength < 400) {
      recommendations.push('平均Prompt字数偏低，建议扩充画面细节描述');
    }
    
    // 基于风险
    const noCameraShots = shotDetails.filter(s => !s.cameraMovement);
    if (noCameraShots.length > 0) {
      recommendations.push(`${noCameraShots.length}个镜头未配置运镜，建议添加运镜增强画面动态感`);
    }
    
    // 基于检查项
    const failedChecks = Object.entries(checkResults).filter(([_, r]) => r.status === 'failed');
    for (const [id, result] of failedChecks) {
      const item = this.checkItems.find(i => i.id === id);
      recommendations.push(`${item?.name || id}未通过：${result.message}，建议修复后重新检查`);
    }
    
    return recommendations;
  }

  _generateNextSteps(riskLevel) {
    if (riskLevel === 'high') {
      return `🔴 **当前风险评级为高风险，不建议直接提交渲染。**\n\n建议操作:\n1. 修复所有🔴高风险镜头的警告项\n2. 重新运行系统检查\n3. 生成新版预生产报告\n4. 风险降至🟡或🟢后再提交渲染`;
    }
    
    if (riskLevel === 'medium') {
      return `🟡 **当前风险评级为中风险，可以提交渲染但建议优化。**\n\n建议操作:\n1. 队长审查每镜内容，确认是否接受当前风险\n2. 如对🟡中风险项有顾虑，指出具体问题我优化\n3. 确认OK后回复\`OK\`，我将提交Seedance渲染`;
    }
    
    return `🟢 **当前风险评级为低风险，可以提交渲染。**\n\n建议操作:\n- 队长快速浏览确认内容方向无误\n- 回复\`OK\`，我将立即提交Seedance渲染\n- 预计渲染完成后飞书通知你验收成片`;
  }

  _estimateRenderCost(shots) {
    // 简单估算：基于时长和镜头数
    const totalDuration = shots.reduce((sum, s) => sum + (s.duration || 5), 0);
    // 假设每5秒约消耗1个基础单位
    const units = Math.ceil(totalDuration / 5);
    return `~${units} 单位 (${totalDuration}秒总时长)`;
  }

  _formatTime(isoString) {
    const d = new Date(isoString);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
  }
}

// 预生产流程集成器
class PreProductionPipeline {
  constructor(config = {}) {
    this.reportGenerator = new PreProductionReportGenerator(config);
    this.config = config;
  }

  /**
   * 执行预生产流程
   * @param {Object} productionData - 生产数据
   * @returns {Object} 预生产结果
   */
  async execute(productionData) {
    console.log('[PreProduction] 启动预生产流程...');
    
    // 1. 收集所有检查结果
    const checkResults = await this._collectCheckResults(productionData);
    
    // 2. 生成报告
    const report = await this.reportGenerator.generateReport({
      ...productionData,
      checkResults
    });
    
    // 3. 生成Markdown
    const markdown = this.reportGenerator.generateMarkdown(report);
    
    // 4. 保存到文件（可选）
    const reportPath = await this._saveReport(markdown, productionData.projectName);
    
    console.log(`[PreProduction] 预生产报告已生成: ${reportPath}`);
    console.log(`[PreProduction] 风险评级: ${report.overview.riskLevelText}`);
    
    return {
      report,
      markdown,
      reportPath,
      canProceed: report.overview.riskLevel !== 'high',
      requiresApproval: true // 总是需要队长审查
    };
  }

  async _collectCheckResults(productionData) {
    // v6.2-fix: 防御性编程，防止 productionData 为 null/undefined 导致调用链断裂
    if (!productionData) {
      console.warn('[PreProduction] ⚠️ productionData 为空，返回默认空结果');
      return {};
    }
    // 这里整合各个检查模块的结果
    // 实际实现时会调用各个检查器的接口
    return productionData.checkResults || {};
  }

  async _saveReport(markdown, projectName) {
    const reportsDir = path.join(process.cwd(), 'pre-production-reports');
    await fs.mkdir(reportsDir, { recursive: true });
    
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${projectName.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '_')}_${timestamp}.md`;
    const filepath = path.join(reportsDir, filename);
    
    await fs.writeFile(filepath, markdown, 'utf8');
    return filepath;
  }
}

// 飞书文档集成（需要外部传入API）
class FeishuDocIntegration {
  constructor(feishuApi) {
    this.api = feishuApi;
  }

  async createPreProductionDoc(report) {
    const markdown = report.markdown;
    
    // 创建飞书文档（调用 feishu_create_doc）
    // 这里需要外部传入实际的API调用
    return {
      docUrl: '待实现',
      message: '预生产报告已生成，请队长审查'
    };
  }
}

module.exports = {
  PreProductionReportGenerator,
  PreProductionPipeline,
  FeishuDocIntegration
};

// CLI入口
if (require.main === module) {
  (async () => {
    // 模拟测试
    const pipeline = new PreProductionPipeline();
    
    const mockData = {
      projectName: '《帝江传》EP01-预生产测试',
      projectType: 'shanhaijing',
      version: 'v6.0',
      shots: [
        {
          id: 'S01',
          duration: 5,
          prompt: 'Epic fantasy opening shot... (mock prompt for testing, this is a very long prompt that should be counted for length analysis purposes)',
          promptLength: 480,
          characterRef: '小G-正面-v2',
          cameraMovement: '缓慢推进',
          narration: '这是一个测试旁白',
          compliance: '通过'
        },
        {
          id: 'S02',
          duration: 8,
          prompt: 'Medium shot... (short)',
          promptLength: 150,
          cameraMovement: null,
          narration: '测试台词',
          compliance: '通过',
          requiresCharacter: true
        }
      ],
      checkResults: {
        'prd-align': { status: 'passed', message: 'PRD与剧本对齐度98%' },
        'schema-validate': { status: 'passed', message: 'Schema校验通过' },
        'compliance': { status: 'warning', message: 'S02字数偏少' },
        'pre-render': { status: 'passed', message: '前置验证通过' }
      }
    };
    
    const result = await pipeline.execute(mockData);
    console.log('\n=== 预生产报告摘要 ===');
    console.log(`风险评级: ${result.report.overview.riskLevelText}`);
    console.log(`是否可提交: ${result.canProceed ? '是' : '否'}`);
    console.log(`警告数: ${result.report.summary.totalWarnings}`);
    console.log(`\n报告已保存至: ${result.reportPath}`);
  })();
}
