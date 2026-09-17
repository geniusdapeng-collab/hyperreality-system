'use strict';

function requireEnv(name) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    throw new Error(`缺少环境变量: ${name}`);
  }
  return String(value).trim();
}

function optionalEnv(name, defaultValue = null) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  return String(value).trim();
}

function optionalNumberEnv(name, defaultValue) {
  const value = process.env[name];
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultValue;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : defaultValue;
}

module.exports = {
  requireEnv,
  optionalEnv,
  optionalNumberEnv
};
