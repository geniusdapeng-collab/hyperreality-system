/**
 * PromptSync - Prompt 长度自动同步器
 */
class PromptSync {
  constructor(options = {}) {
    this.logPrefix = options.logPrefix || '[PromptSync]';
    this.maxLength = options.maxLength || 12000;
    this.warnThreshold = options.warnThreshold || 0.9;
  }

  sync(shot, moduleName = 'unknown') {
    if (!shot) return shot;
    const prompt = shot.prompt || shot._generatedPrompt || '';
    const charCount = prompt.length;
    shot.promptCharCount = charCount;
    shot._promptLengthSynced = true;
    shot._promptLengthSyncedBy = moduleName;
    shot._promptLengthSyncedAt = new Date().toISOString();

    if (charCount > this.maxLength) {
      console.warn(`${this.logPrefix} [${moduleName}] Prompt 超长: ${charCount}/${this.maxLength} (shot: ${shot.shotId})`);
      shot._promptOversized = true;
    } else if (charCount > this.maxLength * this.warnThreshold) {
      console.warn(`${this.logPrefix} [${moduleName}] Prompt 接近上限: ${charCount}/${this.maxLength} (shot: ${shot.shotId})`);
      shot._promptNearLimit = true;
    }
    return shot;
  }

  syncAll(shots, moduleName = 'unknown') {
    if (!Array.isArray(shots)) return shots;
    for (const shot of shots) this.sync(shot, moduleName);
    return shots;
  }

  truncateIfNeeded(shot, maxLength = this.maxLength) {
    if (!shot || !shot.prompt) return shot;
    if (shot.prompt.length > maxLength) {
      const originalLength = shot.prompt.length;
      const truncated = shot.prompt.substring(0, maxLength);
      const lastSentenceEnd = Math.max(truncated.lastIndexOf('。'), truncated.lastIndexOf('.'), truncated.lastIndexOf('\n'));
      if (lastSentenceEnd > maxLength * 0.8) shot.prompt = truncated.substring(0, lastSentenceEnd + 1);
      else shot.prompt = truncated;
      shot.promptCharCount = shot.prompt.length;
      shot._promptTruncated = true;
      shot._promptOriginalLength = originalLength;
      console.warn(`${this.logPrefix} Prompt 已从 ${originalLength} 截断至 ${shot.promptCharCount} (shot: ${shot.shotId})`);
    }
    return shot;
  }
}

module.exports = { PromptSync };
