'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('output-cleaner');

function cleanOutputFiles(outputDir, options = {}) {
  const { keyword = '', exts = ['.json', '.md'], dryRun = false } = options;

  if (!fs.existsSync(outputDir)) {
    logger.info('输出目录不存在，跳过清理', { outputDir });
    return [];
  }

  const removed = [];
  const files = fs.readdirSync(outputDir);

  for (const file of files) {
    const matchKeyword = keyword ? file.includes(keyword) : true;
    const matchExt = exts.some(ext => file.endsWith(ext));

    if (matchKeyword && matchExt) {
      const fullPath = path.join(outputDir, file);
      if (!dryRun) {
        fs.unlinkSync(fullPath);
      }
      removed.push(fullPath);
    }
  }

  logger.info('输出清理完成', { outputDir, removedCount: removed.length, dryRun });
  return removed;
}

module.exports = { cleanOutputFiles };
