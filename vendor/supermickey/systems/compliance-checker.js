/**
 * 合规检查器 v1.0
 * 检查Prompt和内容是否符合规范
 * 
 * 功能：
 * - 禁用词检查（中国风/古风/动漫等）
 * - 字数合规检查
 * - 角色一致性检查
 * - 场景合规检查
 * - 生成合规报告
 * 
 * @version v1.0
 * @author 小G
 */

class ComplianceChecker {
  constructor(options = {}) {
    this.mode = options.mode || 'nirath';
    this.maxPromptLength = options.maxPromptLength || 1500;
    this.minPromptLength = options.minPromptLength || 300;
    
    // 禁用关键词（按严重程度分级）
    this.bannedKeywords = {
      L1: [
        '中国风', '古风', '传统', '水墨', '国风', '仙侠', '武侠',
        'chinese style', 'traditional chinese', 'ink wash', 'oriental',
        'lo-fi', 'anime', 'cartoon', 'cartoony', 'stylized', 'toon'
      ],
      L2: [
        '地球', 'earth', 'terrestrial', '现实', 'real world',
        '现代科技', 'modern technology', '科幻', 'sci-fi'
      ],
      L3: [
        '简单', 'simple', '粗糙', 'rough', '低质量', 'low quality'
      ]
    };
    
    // Nirath场景白名单
    this.nirathScenes = [
      '永夜裂谷', '青丘灵原', '钟山之巅', '银色湖泊', '建木林',
      '昆仑虚', '幽都暗域', '流沙瀚海', '归墟之海', '不周山脉'
    ];
    
    // 角色白名单
    this.validCharacters = [
      'xiaoG', '暖暖', '白泽', '陈女士', '教练',
      'zhu-long', 'qing-qiu', 'phoenix', 'qilin'
    ];
  }

  /**
   * 检查Prompt合规性（核心方法）
   * @param {string} prompt - Prompt文本
   * @param {Object} shot - 镜头信息（可选）
   * @returns {Object} 合规检查结果
   */
  checkPrompt(prompt, shot = null) {
    const startTime = Date.now();
    console.log(`[ComplianceChecker] 🔍 开始合规检查 | Prompt长度: ${prompt?.length || 0}`);
    
    const issues = [];
    
    // 1. 基础检查
    if (!prompt || prompt.trim().length === 0) {
      issues.push({
        level: 'error',
        type: 'empty_prompt',
        message: 'Prompt为空',
        severity: 'blocking'
      });
      return this._buildResult(false, issues, 0);
    }
    
    // 2. 字数检查
    const length = prompt.length;
    if (length > this.maxPromptLength) {
      issues.push({
        level: 'error',
        type: 'length_overflow',
        message: `Prompt超长: ${length} > ${this.maxPromptLength}`,
        severity: 'blocking',
        detail: { current: length, max: this.maxPromptLength }
      });
    } else if (length < this.minPromptLength) {
      issues.push({
        level: 'warning',
        type: 'length_underflow',
        message: `Prompt字数偏少: ${length} < ${this.minPromptLength}`,
        severity: 'warning',
        detail: { current: length, min: this.minPromptLength }
      });
    }
    
    // 3. 禁用词检查
    const bannedResults = this._checkBannedKeywords(prompt);
    issues.push(...bannedResults);
    
    // 4. Nirath风格检查（Nirath模式）
    if (this.mode === 'nirath') {
      const nirathResults = this._checkNirathStyle(prompt);
      issues.push(...nirathResults);
    }
    
    // 5. 场景合规检查
    if (shot && shot.scene) {
      const sceneResults = this._checkSceneCompliance(shot.scene);
      issues.push(...sceneResults);
    }
    
    // 6. 角色合规检查
    if (shot && shot.characters) {
      const charResults = this._checkCharacterCompliance(shot.characters);
      issues.push(...charResults);
    }
    
    // 7. 结构检查
    const structureResults = this._checkStructure(prompt);
    issues.push(...structureResults);
    
    // 计算结果
    const blockingIssues = issues.filter(i => i.severity === 'blocking');
    const warningIssues = issues.filter(i => i.severity === 'warning');
    const passed = blockingIssues.length === 0;
    
    const duration = Date.now() - startTime;
    console.log(`[ComplianceChecker] ✅ 合规检查完成 | 通过: ${passed} | 阻塞: ${blockingIssues.length} | 警告: ${warningIssues.length} | 耗时: ${duration}ms`);
    
    return this._buildResult(passed, issues, duration);
  }

  /**
   * 检查批量Prompt
   */
  checkBatch(prompts) {
    const results = [];
    let allPassed = true;
    
    for (const item of prompts) {
      const result = this.checkPrompt(item.prompt, item.shot);
      results.push({
        shotId: item.shotId,
        ...result
      });
      
      if (!result.passed) allPassed = false;
    }
    
    return {
      passed: allPassed,
      results,
      totalIssues: results.reduce((sum, r) => sum + r.issueCount, 0)
    };
  }

  /**
   * 检查禁用词
   */
  _checkBannedKeywords(prompt) {
    const issues = [];
    
    for (const [level, keywords] of Object.entries(this.bannedKeywords)) {
      for (const keyword of keywords) {
        const regex = /[\u4e00-\u9fa5]/.test(keyword)
          ? new RegExp(keyword, 'gi')
          : new RegExp(`\\b${keyword}\\b`, 'gi');
        
        if (regex.test(prompt)) {
          issues.push({
            level,
            type: 'banned_keyword',
            message: `发现禁用词 [${level}]: "${keyword}"`,
            severity: level === 'L1' ? 'blocking' : 'warning',
            detail: { keyword, level }
          });
        }
      }
    }
    
    return issues;
  }

  /**
   * 检查Nirath风格
   */
  _checkNirathStyle(prompt) {
    const issues = [];
    
    // 检查是否包含Nirath风格参数
    const nirathParams = [
      'hyper-realistic',
      'Unreal Engine 5',
      'Lumen',
      'Nanite',
      'dual',
      'bioluminescent'
    ];
    
    const missing = nirathParams.filter(p => !prompt.includes(p));
    if (missing.length > 0) {
      issues.push({
        level: 'warning',
        type: 'nirath_style_missing',
        message: `Nirath风格参数缺失: ${missing.join(', ')}`,
        severity: 'warning',
        detail: { missing }
      });
    }
    
    // 检查16:9比例
    if (!prompt.includes('16:9') && !prompt.includes('widescreen')) {
      issues.push({
        level: 'warning',
        type: 'ratio_missing',
        message: '未指定16:9横屏比例',
        severity: 'warning'
      });
    }
    
    return issues;
  }

  /**
   * 检查场景合规
   */
  _checkSceneCompliance(sceneName) {
    const issues = [];
    
    // 提取基础场景名
    const baseName = sceneName.split('-')[0].trim();
    
    // 检查是否在白名单中
    if (!this.nirathScenes.includes(baseName) && !this.nirathScenes.includes(sceneName)) {
      issues.push({
        level: 'warning',
        type: 'unknown_scene',
        message: `场景 "${sceneName}" 不在Nirath场景库中`,
        severity: 'warning',
        detail: { scene: sceneName, validScenes: this.nirathScenes }
      });
    }
    
    return issues;
  }

  /**
   * 检查角色合规
   */
  _checkCharacterCompliance(characters) {
    const issues = [];
    
    for (const char of characters) {
      if (!this.validCharacters.includes(char)) {
        issues.push({
          level: 'warning',
          type: 'unknown_character',
          message: `角色 "${char}" 不在角色库中`,
          severity: 'warning',
          detail: { character: char, validCharacters: this.validCharacters }
        });
      }
    }
    
    return issues;
  }

  /**
   * 检查Prompt结构
   */
  _checkStructure(prompt) {
    const issues = [];
    
    // 检查是否有过多的重复词
    const words = prompt.toLowerCase().split(/\s+/);
    const wordCounts = {};
    for (const word of words) {
      wordCounts[word] = (wordCounts[word] || 0) + 1;
    }
    
    const repetitions = Object.entries(wordCounts).filter(([word, count]) => count > 3 && word.length > 3);
    if (repetitions.length > 0) {
      issues.push({
        level: 'warning',
        type: 'word_repetition',
        message: `Prompt中单词重复过多: ${repetitions.map(([w, c]) => `${w}(${c}次)`).join(', ')}`,
        severity: 'warning',
        detail: { repetitions }
      });
    }
    
    return issues;
  }

  /**
   * 构建结果
   */
  _buildResult(passed, issues, duration) {
    const blockingIssues = issues.filter(i => i.severity === 'blocking');
    const warningIssues = issues.filter(i => i.severity === 'warning');
    
    return {
      passed,
      issueCount: issues.length,
      blockingCount: blockingIssues.length,
      warningCount: warningIssues.length,
      issues: issues.map(i => ({
        level: i.level,
        type: i.type,
        message: i.message,
        severity: i.severity
      })),
      blockingIssues: blockingIssues.map(i => i.message),
      warningIssues: warningIssues.map(i => i.message),
      duration
    };
  }
}

module.exports = { ComplianceChecker };

// CLI入口
if (require.main === module) {
  const checker = new ComplianceChecker({ mode: 'nirath' });
  
  const testPrompt = '16:9 widescreen cinematic shot. Epic establishing shot, Eternal Night Canyon of Nirath, obsidian cliffs with bioluminescent veins. hyper-realistic 3D digital human render, Unreal Engine 5, Lumen global illumination. Characters: young protagonist with warm expression. Atmospheric mood: calm anticipation, soft ambient lighting. Binary star system visible in sky, dual-source lighting.';
  
  const result = checker.checkPrompt(testPrompt);
  
  console.log('\n=== 合规检查结果 ===');
  console.log(`通过: ${result.passed}`);
  console.log(`问题数: ${result.issueCount}`);
  console.log(`阻塞问题: ${result.blockingCount}`);
  console.log(`警告: ${result.warningCount}`);
  
  if (result.issues.length > 0) {
    console.log('\n=== 问题详情 ===');
    for (const issue of result.issues) {
      console.log(`[${issue.severity}] ${issue.message}`);
    }
  }
}
