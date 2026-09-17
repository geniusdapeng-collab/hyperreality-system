/**
 * AsyncInitGuard - 异步初始化守卫
 */
class AsyncInitGuard {
  constructor(options = {}) {
    this.initTimeout = options.initTimeout || 30000;
    this.retryAttempts = options.retryAttempts || 3;
    this.retryDelay = options.retryDelay || 1000;
    this._initialized = false;
    this._initializing = false;
    this._initError = null;
    this._waiters = [];
  }

  async initialize(initFn) {
    if (this._initialized) return;
    if (this._initializing) return this._waitForInit();
    this._initializing = true;

    for (let attempt = 1; attempt <= this.retryAttempts; attempt++) {
      try {
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error('初始化超时')), this.initTimeout)
        );
        await Promise.race([initFn(), timeoutPromise]);
        this._initialized = true;
        this._initializing = false;
        this._resolveWaiters();
        return;
      } catch (error) {
        console.warn(`[AsyncInitGuard] 初始化尝试 ${attempt}/${this.retryAttempts} 失败: ${error.message}`);
        this._initError = error;
        if (attempt < this.retryAttempts) await new Promise((r) => setTimeout(r, this.retryDelay));
      }
    }
    this._initializing = false;
    this._rejectWaiters(this._initError);
    throw new Error(`[AsyncInitGuard] 初始化失败(${this.retryAttempts}次): ${this._initError.message}`);
  }

  async _waitForInit() {
    if (this._initialized) return;
    if (this._initError) throw this._initError;
    return new Promise((resolve, reject) => this._waiters.push({ resolve, reject }));
  }

  _resolveWaiters() { for (const w of this._waiters) w.resolve(); this._waiters = []; }
  _rejectWaiters(error) { for (const w of this._waiters) w.reject(error); this._waiters = []; }

  ensureInitialized() {
    if (!this._initialized) throw new Error('[AsyncInitGuard] 模块未初始化');
  }

  get isInitialized() { return this._initialized; }
}

module.exports = { AsyncInitGuard };
