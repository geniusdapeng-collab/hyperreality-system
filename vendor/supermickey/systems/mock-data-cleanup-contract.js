/**
 * Mock数据自动清理契约
 * 渲染前强制扫描并拦截残留的Mock/测试数据
 */

const fs = require('fs').promises;
const path = require('path');

class MockDataCleanupContract {
  constructor(options = {}) {
    this.config = {
      patterns: [
        '*-mock-*',
        '*-test-*',
        'tmp-*',
        'draft-*',
        '*-backup-*',
        '*-old-*',
        'e2e-*-report*'
      ],
      protectedDirs: [
        'node_modules',
        '.git',
        'docs',
        'logs'
      ],
      workDir: options.workDir || process.cwd()
    };
    this.violations = [];
  }

  async enforce() {
    this.violations = [];
    const scanDirs = [
      this.config.workDir,
      path.join(this.config.workDir, 'stories'),
      path.join(this.config.workDir, 'scripts'),
      path.join(this.config.workDir, 'systems'),
      path.join(this.config.workDir, 'data')
    ];

    for (const dir of scanDirs) {
      try {
        await this.scanDir(dir);
      } catch (e) {
        // 目录不存在则跳过
      }
    }

    if (this.violations.length > 0) {
      const msg = `🚫 Mock数据清理拦截：发现 ${this.violations.length} 个残留文件/目录：\n` +
        this.violations.map(v => `   • ${v}`).join('\n') +
        `\n\n必须清理后才能提交生产渲染！`;
      throw new Error(msg);
    }

    return { clean: true, violations: 0 };
  }

  async scanDir(dir) {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(this.config.workDir, fullPath);

      // 跳过保护目录
      if (this.config.protectedDirs.some(pd => relativePath.includes(pd))) {
        continue;
      }

      // 检查是否匹配Mock模式
      const isMock = this.config.patterns.some(p => {
        const regex = new RegExp(p.replace(/\*/g, '.*'));
        return regex.test(entry.name);
      });

      if (isMock) {
        this.violations.push(relativePath);
      }

      // 递归扫描子目录（但不再深入已匹配目录）
      if (entry.isDirectory() && !isMock) {
        await this.scanDir(fullPath);
      }
    }
  }

  /**
   * 自动清理（危险操作，需确认）
   */
  async autoCleanup() {
    await this.enforce(); // 先扫描

    for (const v of this.violations) {
      const fullPath = path.join(this.config.workDir, v);
      try {
        const stat = await fs.stat(fullPath);
        if (stat.isDirectory()) {
          await fs.rm(fullPath, { recursive: true });
        } else {
          await fs.unlink(fullPath);
        }
      } catch (e) {
        console.error(`清理失败 ${v}: ${e.message}`);
      }
    }

    return { cleaned: this.violations.length };
  }
}

module.exports = { MockDataCleanupContract };
