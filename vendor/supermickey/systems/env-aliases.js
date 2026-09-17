'use strict';

/**
 * env-aliases.js — SUPERMICKEY_* 环境变量别名桥（v2.2.8 审计新增）
 *
 * 背景：引擎层 37 处读取 STORMAXE_* 环境变量（历史项目命名残留），
 * 而 .env.example 从未文档化这些变量，新开发者无法发现可配置项。
 *
 * 本模块在进程启动早期把 SUPERMICKEY_* 新名映射到 STORMAXE_* 旧名
 * （SUPERMICKEY_* 为现行规范名，一旦设置即覆盖同名旧变量，确保"新名优先"），
 * 使全部存量读取点对两个名字同时生效，零改动兼容。
 *
 * 用法（入口文件顶部 require 一次即可）：
 *   require('./systems/env-aliases');        // 或相应相对路径
 *
 * 变量对照表：
 *   SUPERMICKEY_LLM_MODEL               ←→ STORMAXE_LLM_MODEL
 *   SUPERMICKEY_LLM_FAST_MODEL          ←→ STORMAXE_LLM_FAST_MODEL
 *   SUPERMICKEY_TOTAL_DEADLINE_MS       ←→ STORMAXE_TOTAL_DEADLINE_MS
 *   SUPERMICKEY_MIN_LONG_TASK_TIMEOUT_MS←→ STORMAXE_MIN_LONG_TASK_TIMEOUT_MS
 *   SUPERMICKEY_USER_INTENT             ←→ STORMAXE_USER_INTENT
 *   SUPERMICKEY_FORCE_RUN               ←→ STORMAXE_FORCE_RUN
 */

const ALIAS_PAIRS = [
  ['SUPERMICKEY_LLM_MODEL', 'STORMAXE_LLM_MODEL'],
  ['SUPERMICKEY_LLM_FAST_MODEL', 'STORMAXE_LLM_FAST_MODEL'],
  ['SUPERMICKEY_TOTAL_DEADLINE_MS', 'STORMAXE_TOTAL_DEADLINE_MS'],
  ['SUPERMICKEY_MIN_LONG_TASK_TIMEOUT_MS', 'STORMAXE_MIN_LONG_TASK_TIMEOUT_MS'],
  ['SUPERMICKEY_USER_INTENT', 'STORMAXE_USER_INTENT'],
  ['SUPERMICKEY_FORCE_RUN', 'STORMAXE_FORCE_RUN'],
];

function applyEnvAliases(env = process.env) {
  for (const [newName, legacyName] of ALIAS_PAIRS) {
    // SUPERMICKEY_* 为现行规范名：一旦设置即覆盖同名旧变量，确保"新名优先"语义唯一。
    if (env[newName] !== undefined) {
      env[legacyName] = env[newName];
    }
  }
}

applyEnvAliases();

module.exports = { applyEnvAliases, ALIAS_PAIRS };
