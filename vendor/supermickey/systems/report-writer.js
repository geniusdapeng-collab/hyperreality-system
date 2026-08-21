'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('report-writer');

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function buildTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function writeJsonReport(outputDir, prefix, data) {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `${prefix}-${buildTimestamp()}.json`);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  logger.info('JSON报告已写入', { filePath });
  return filePath;
}

function writeMarkdownReport(outputDir, prefix, content) {
  ensureDir(outputDir);
  const filePath = path.join(outputDir, `${prefix}-${buildTimestamp()}.md`);
  fs.writeFileSync(filePath, content, 'utf8');
  logger.info('Markdown报告已写入', { filePath });
  return filePath;
}

module.exports = { writeJsonReport, writeMarkdownReport };
