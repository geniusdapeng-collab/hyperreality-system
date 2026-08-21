/**
 * SafePromise - 安全的 Promise 工具
 * 解决 Promise.race 悬空 rejection 崩溃问题
 */
class SafePromise {
  static async race(promises, options = {}) {
    const { timeout, label = 'race' } = options;
    const wrappedPromises = promises.map((p) => {
      if (p && typeof p.catch === 'function') p.catch(() => {});
      return p;
    });
    if (timeout && timeout > 0) {
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`[${label}] 超时(${timeout}ms)`)), timeout);
      });
      return Promise.race([...wrappedPromises, timeoutPromise]);
    }
    return Promise.race(wrappedPromises);
  }

  static withTimeout(promise, timeoutMs, label = 'timeout') {
    if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    const timeoutPromise = new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${label}] 超时(${timeoutMs}ms)`)), timeoutMs);
      promise.finally(() => clearTimeout(timer)).catch(() => {});
    });
    return Promise.race([promise, timeoutPromise]);
  }

  static async allSettledWithTimeout(promises, options = {}) {
    const { timeout = 300000, label = 'allSettled' } = options;
    const wrapped = promises.map((p) =>
      SafePromise.withTimeout(
        Promise.resolve(p).catch((err) => ({ error: err.message, _failed: true })),
        timeout,
        label
      )
    );
    return Promise.all(wrapped);
  }

  /**
   * 【v2.1.8-fix】批量处理，限制并发数
   * @param {Array} items - 待处理数组
   * @param {Function} mapper - 映射函数 (item, index) => Promise
   * @param {number} concurrency - 最大并发数
   * @returns {Array} 结果数组
   */
  static async mapBatch(items, mapper, concurrency = 5) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchPromises = batch.map((item, idx) => {
        return Promise.resolve(mapper(item, i + idx)).catch((err) => {
          console.warn(`[SafePromise.mapBatch] 索引 ${i + idx} 失败: ${err.message}`);
          return { _failed: true, error: err.message, index: i + idx };
        });
      });
      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);
    }
    return results;
  }
}

module.exports = { SafePromise };
