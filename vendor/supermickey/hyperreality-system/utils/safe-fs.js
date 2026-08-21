/**
 * SafeFS - 安全的文件系统操作
 * 防止文件句柄泄漏和 EMFILE 错误
 */
const fs = require('fs');
const path = require('path');

class SafeFS {
  constructor(options = {}) {
    this.maxConcurrentWrites = options.maxConcurrentWrites || 10;
    this.writeQueue = [];
    this.activeWrites = 0;
    this.pendingCloses = new Set();
  }

  async writeFile(filePath, data, options = {}) {
    if (this.activeWrites >= this.maxConcurrentWrites) {
      await new Promise((resolve) => this.writeQueue.push(resolve));
    }
    this.activeWrites++;
    try {
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      await fs.promises.writeFile(filePath, data, options);
    } finally {
      this.activeWrites--;
      if (this.writeQueue.length > 0) { const next = this.writeQueue.shift(); next(); }
    }
  }

  writeFileSync(filePath, data, options = {}) {
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(filePath, data, options);
  }

  async writeBatch(items, concurrency = 5) {
    const results = [];
    for (let i = 0; i < items.length; i += concurrency) {
      const batch = items.slice(i, i + concurrency);
      const batchResults = await Promise.all(
        batch.map((item) => this.writeFile(item.path, item.data).catch((err) => ({ error: err.message, path: item.path })))
      );
      results.push(...batchResults);
    }
    return results;
  }

  registerFd(fd) { this.pendingCloses.add(fd); }
  closeAll() {
    for (const fd of this.pendingCloses) { try { fs.closeSync(fd); } catch (_) {} }
    this.pendingCloses.clear();
  }
}

const defaultSafeFS = new SafeFS();
module.exports = {
  SafeFS,
  writeFile: (p, d, o) => defaultSafeFS.writeFile(p, d, o),
  writeFileSync: (p, d, o) => defaultSafeFS.writeFileSync(p, d, o),
  writeBatch: (i, c) => defaultSafeFS.writeBatch(i, c)
};
