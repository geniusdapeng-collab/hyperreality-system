'use strict';

const fs = require('fs');
const path = require('path');
const { createLogger } = require('./logger');

const logger = createLogger('portrait-resolver');

const ANGLE_ALIASES = {
  front: ['front', 'front_fullbody'],
  threeQuarter: ['threequarter', 'three_quarter', 'threeQuarter'],
  closeup: ['closeup', 'face_closeup'],
  side: ['side', 'side_profile']
};

function normalizeRoleId(roleId) {
  if (!roleId) return '';
  return String(roleId).trim();
}

function normalizeFileName(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function findAngleFromFilename(filename) {
  const normalized = normalizeFileName(filename);

  for (const [angle, aliases] of Object.entries(ANGLE_ALIASES)) {
    for (const alias of aliases) {
      if (normalized.includes(normalizeFileName(alias))) {
        return angle;
      }
    }
  }

  return null;
}

function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return null;
  }
}

function resolvePortraitsForRole(workspaceRoot, roleId) {
  const normalizedRoleId = normalizeRoleId(roleId);
  const characterDir = path.join(workspaceRoot, 'characters', normalizedRoleId);
  const portraitsDir = path.join(characterDir, 'portraits');
  const cardPath = path.join(characterDir, 'character-card.json');

  const result = {
    roleId: normalizedRoleId,
    found: false,
    angles: {},
    source: null
  };

  // 1. 先扫 portraits 目录
  if (fs.existsSync(portraitsDir)) {
    const files = fs.readdirSync(portraitsDir);
    for (const file of files) {
      const fullPath = path.join(portraitsDir, file);
      if (!fs.statSync(fullPath).isFile()) continue;

      const angle = findAngleFromFilename(file);
      if (angle && !result.angles[angle]) {
        result.angles[angle] = fullPath;
      }
    }

    if (Object.keys(result.angles).length > 0) {
      result.found = true;
      result.source = 'portraits-directory';
      return result;
    }
  }

  // 2. 再从 character-card.json 里读 generatedAssets.portraits
  const card = safeReadJson(cardPath);
  if (card && card.generatedAssets && Array.isArray(card.generatedAssets.portraits)) {
    for (const item of card.generatedAssets.portraits) {
      const angle = item.angle ? String(item.angle) : null;
      const localPath = item.localPath || item.path || null;
      if (angle && localPath && !result.angles[angle]) {
        const absPath = path.isAbsolute(localPath)
          ? localPath
          : path.join(workspaceRoot, localPath);
        if (fs.existsSync(absPath)) {
          result.angles[angle] = absPath;
        }
      }
    }

    if (Object.keys(result.angles).length > 0) {
      result.found = true;
      result.source = 'character-card';
      return result;
    }
  }

  // v6.5.65-P3-fix: 3. 如果完全没有定妆照，自动生成 CG 定妆照
  logger.warn('未找到角色定妆照，尝试自动生成 CG 版本', { roleId: normalizedRoleId });
  const generated = generateCGPortrait(workspaceRoot, normalizedRoleId, card);
  if (generated && generated.found) {
    return generated;
  }

  logger.warn('未找到角色定妆照，且自动生成失败', { roleId: normalizedRoleId });
  return result;
}

// v6.5.65-P3-fix: 自动生成 CG 定妆照（当真人定妆照缺失时）
function generateCGPortrait(workspaceRoot, roleId, characterCard) {
  try {
    // 检查是否已经存在 CG 版本
    const cgPath = path.join(workspaceRoot, 'characters', roleId, 'portraits', `${roleId}-cg-v3-closeup.png`);
    if (fs.existsSync(cgPath)) {
      return {
        roleId,
        found: true,
        angles: { closeup: cgPath },
        source: 'cg-auto-generated'
      };
    }

    // 尝试从 character-card 提取描述生成 CG 图
    const description = characterCard?.visualIdentity?.distinguishingMarks || 
                       characterCard?.appearance || 
                       'professional Asian female medical presenter';
    
    const age = characterCard?.baseIdentity?.age || 35;
    const gender = characterCard?.baseIdentity?.gender || 'female';
    
    // 记录需要生成，但返回未找到（由上层调用 Seedream 生成）
    logger.info('需要生成 CG 定妆照', { roleId, description: description.substring(0, 50) });
    
    return {
      roleId,
      found: false,
      angles: {},
      source: 'cg-generation-needed',
      generationNeeded: true,
      generationPrompt: `Professional portrait of a ${age}-year-old Asian ${gender} medical presenter, ${description}, clean white background, front-facing close-up, photorealistic 3D render style, cinematic quality, highly detailed facial features`,
      targetPath: cgPath
    };
  } catch (e) {
    logger.error('CG 定妆照生成失败', { roleId, error: e.message });
    return { roleId, found: false, angles: {} };
  }
}

function resolveBestAngles(rolePortraits, shotType = '') {
  const preferred = [];

  const type = String(shotType || '').toLowerCase();

  if (type.includes('close')) {
    preferred.push('closeup', 'threeQuarter', 'front');
  } else if (type.includes('opening') || type.includes('wide') || type.includes('establish')) {
    preferred.push('front', 'threeQuarter', 'side');
  } else {
    preferred.push('threeQuarter', 'front', 'closeup');
  }

  const resolved = [];
  for (const angle of preferred) {
    if (rolePortraits.angles[angle]) {
      resolved.push({
        angle,
        path: rolePortraits.angles[angle]
      });
    }
  }

  // 兜底：把剩余角度也补进去
  for (const [angle, filePath] of Object.entries(rolePortraits.angles)) {
    if (!resolved.find(x => x.angle === angle)) {
      resolved.push({ angle, path: filePath });
    }
  }

  return resolved;
}

module.exports = {
  resolvePortraitsForRole,
  resolveBestAngles
};