/**
 * DualArraySync — shots 与 prompts 双数组安全同步器
 * 解决三个根本问题：
 * 1. shots 和 prompts 共享对象引用（影分身bug）
 * 2. shots.find() O(n) 线性查找（性能灾难）
 * 3. 模块修改 shots 后忘记同步 prompts（同步遗漏）
 */
const { deepClone } = require('./safe-clone');

class DualArraySync {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false;
    this.logPrefix = options.logPrefix || '[DualArraySync]';
    this._shotMap = new Map(); // shotId -> { shotIndex, promptIndex }
    this._stats = { syncCalls: 0, totalTimeMs: 0 };
  }

  /**
   * 初始化：建立 shots 和 prompts 之间的索引映射
   * 调用时机：produce() 返回后，任何增强模块之前
   */
  initialize(shots, prompts) {
    this._shotMap.clear();

    for (let i = 0; i < shots.length; i++) {
      const shotId = shots[i].shotId || shots[i].shot_id;
      if (shotId) {
        this._shotMap.set(shotId, { shotIndex: i, promptIndex: -1 });
      }
    }

    for (let i = 0; i < prompts.length; i++) {
      const promptId = prompts[i].shotId || prompts[i].shot_id;
      if (promptId && this._shotMap.has(promptId)) {
        this._shotMap.get(promptId).promptIndex = i;
      }
    }

    let orphanedShots = 0;
    for (const [, entry] of this._shotMap) {
      if (entry.promptIndex === -1) orphanedShots++;
    }
    if (orphanedShots > 0) {
      console.warn(`${this.logPrefix} ${orphanedShots} 个 shot 没有匹配的 prompt`);
    }

    console.log(`${this.logPrefix} 索引建立: ${this._shotMap.size} 对映射`);
    return this;
  }

  /** O(1) 获取 prompt 对应的 shot */
  getShot(prompt, shots) {
    const shotId = prompt.shotId || prompt.shot_id;
    const entry = this._shotMap.get(shotId);
    return (entry && entry.shotIndex >= 0) ? shots[entry.shotIndex] : null;
  }

  /** O(1) 获取 shot 对应的 prompt */
  getPrompt(shot, prompts) {
    const shotId = shot.shotId || shot.shot_id;
    const entry = this._shotMap.get(shotId);
    return (entry && entry.promptIndex >= 0) ? prompts[entry.promptIndex] : null;
  }

  /**
   * 安全的 shots→prompts 同步（O(n) 但使用索引，不是 find）
   */
  syncShotsToPrompts(moduleName, shots, prompts, fields = ['prompt', 'promptCharCount']) {
    const start = Date.now();
    let syncCount = 0;

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];
      const shotId = shot.shotId || shot.shot_id;
      const entry = this._shotMap.get(shotId);

      if (entry && entry.promptIndex >= 0) {
        const prompt = prompts[entry.promptIndex];
        for (const field of fields) {
          if (shot[field] !== undefined && shot[field] !== prompt[field]) {
            prompt[field] = shot[field];
            syncCount++;
          }
        }
      }
    }

    this._stats.syncCalls++;
    this._stats.totalTimeMs += Date.now() - start;

    if (syncCount > 0) {
      console.log(`${this.logPrefix} [${moduleName}] shots→prompts 同步: ${syncCount} 个字段 (${Date.now() - start}ms)`);
    }
    return { syncCount, timeMs: Date.now() - start };
  }

  /**
   * 安全的 prompts→shots 同步
   */
  syncPromptsToShots(moduleName, shots, prompts, fields = ['prompt', 'promptCharCount']) {
    const start = Date.now();
    let syncCount = 0;

    for (let i = 0; i < prompts.length; i++) {
      const prompt = prompts[i];
      const promptId = prompt.shotId || prompt.shot_id;
      const entry = this._shotMap.get(promptId);

      if (entry && entry.shotIndex >= 0) {
        const shot = shots[entry.shotIndex];
        for (const field of fields) {
          if (prompt[field] !== undefined && prompt[field] !== shot[field]) {
            shot[field] = prompt[field];
            syncCount++;
          }
        }
      }
    }

    this._stats.syncCalls++;
    this._stats.totalTimeMs += Date.now() - start;

    if (syncCount > 0) {
      console.log(`${this.logPrefix} [${moduleName}] prompts→shots 同步: ${syncCount} 个字段 (${Date.now() - start}ms)`);
    }
    return { syncCount, timeMs: Date.now() - start };
  }

  /**
   * 深度分离：创建 shots 和 prompts 的独立深拷贝
   * 调用时机：produce() 返回后立即调用，打破共享引用
   */
  detach(shots, prompts) {
    const detachedShots = deepClone(shots);
    const detachedPrompts = deepClone(prompts);
    this.initialize(detachedShots, detachedPrompts);
    console.log(`${this.logPrefix} 引用分离完成: shots 和 prompts 现在是独立的对象`);
    return { shots: detachedShots, prompts: detachedPrompts };
  }

  /**
   * 不可变更新：保留元数据的数组替换
   * 解决 bug #37: shots 数组被替换时元数据丢失
   */
  immutableUpdate(shots, newShots) {
    const metaFields = [
      '_context', '_validated', '_validatedAt', '_fieldGuardReport',
      '_commercialEnhanced', '_brandOverlay', '_fpvEnhanced', '_sportType',
      '_appliedSkills', '_directorStyle', '_emotionInjected', '_qualityEnhanced',
      '_microMotion', '_guardianFixed', '_normalized', '_promptLengthSynced',
      '_promptLengthSyncedBy', '_promptLengthSyncedAt'
    ];

    const merged = newShots.map((newShot) => {
      const shotId = newShot.shotId || newShot.shot_id;
      const oldShot = shots.find(s => (s.shotId || s.shot_id) === shotId);

      if (oldShot) {
        for (const field of metaFields) {
          if (oldShot[field] !== undefined && newShot[field] === undefined) {
            newShot[field] = oldShot[field];
          }
        }
      }
      return newShot;
    });

    console.log(`${this.logPrefix} 不可变更新: ${merged.length} 个 shot，元数据已保留`);
    return merged;
  }

  getStats() {
    return { ...this._stats };
  }
}

module.exports = { DualArraySync };
