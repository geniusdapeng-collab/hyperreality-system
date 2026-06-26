/**
 * 连续性检查器 (Continuity Checker)
 * 
 * 职责：
 * - 检查角色连续性
 * - 检查时序连续性
 * - 检测叙事断裂
 */

class ContinuityChecker {
  constructor() {}

  /**
   * 执行连续性检查
   * @param {Array} prompts - 镜头数组
   * @returns {Object} 检查结果
   */
  check(prompts) {
    const issues = [];

    // 检查角色连续性(从 characterRef 解析)
    const characterMentions = prompts.map((p, idx) => {
      const chars = this._parseCharacterRefForContinuity(p.characterRef);
      return { idx, chars };
    });

    // 检查时序连续性
    for (let i = 1; i < prompts.length; i++) {
      const prev = prompts[i - 1];
      const curr = prompts[i];

      const prevChars = this._parseCharacterRefForContinuity(prev.characterRef);
      const currChars = this._parseCharacterRefForContinuity(curr.characterRef);

      // 检查是否有共享角色
      const sharedChars = prevChars.filter(c => currChars.includes(c));

      if (sharedChars.length === 0 && prevChars.length > 0 && currChars.length > 0) {
        issues.push({
          type: 'character_gap',
          between: [prev.shotId, curr.shotId],
          message: '相邻镜头无共享角色,可能导致叙事断裂'
        });
      }
    }

    return {
      passed: issues.length === 0,
      issues,
      promptCount: prompts.length
    };
  }

  /**
   * v6.37-P0: 从 characterRef 解析角色名(用于连续性检查)
   */
  _parseCharacterRefForContinuity(characterRef) {
    if (!characterRef || characterRef === 'NONE') return [];

    const chars = [];
    const parts = characterRef.split('; ');

    for (const part of parts) {
      const match = part.match(/(.+?):\s*/);
      if (match) {
        chars.push(match[1].trim());
      }
    }

    return chars;
  }
}

module.exports = { ContinuityChecker };
