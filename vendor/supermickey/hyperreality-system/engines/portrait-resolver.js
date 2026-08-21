/**
 * PortraitResolver - 定妆照双模式解析器
 * v2.2.1-fix: 支持上传定妆照 + 文字描述 fallback
 */

const fs = require('fs');
const path = require('path');

class PortraitResolver {
  constructor(options = {}) {
    this.charactersDir = options.charactersDir || path.join(process.cwd(), 'characters');
    this.supportedExts = ['.png', '.jpg', '.jpeg', '.webp'];
  }

  /**
   * 解析定妆照
   * @param {Array} prompts - 镜头提示词数组
   * @param {Array} characters - 角色定义数组
   * @param {Object} studioManifest - 【v2.8.0】PortraitStudio 定妆照集 manifest（可选，优先于目录扫描）
   * @returns {Object} { bindings: [...] }
   */
  resolve(prompts, characters, studioManifest = null) {
    const bindings = [];
    
    // 扫描上传的定妆照
    const uploadedFiles = this._scanUploadedPortraits();
    
    for (const char of characters || []) {
      const charName = char.name || char.id || '';
      const charId = char.id || char.name || '';
      
      // 【v2.8.0】第一优先级：PortraitStudio 定妆照集中已完成的产物
      const studioPortraits = this._matchStudioPortraits(charName, charId, studioManifest);
      
      if (studioPortraits.length > 0) {
        bindings.push({
          character: charName,
          mode: 'studio',
          source: `portrait-set://${charId || charName}`,
          portraits: studioPortraits,
          file: studioPortraits[0].outputFile
        });
        continue;
      }
      
      // 第二优先级：上传文件匹配
      const matchedFile = this._matchUploadedPortrait(charName, charId, uploadedFiles);
      
      if (matchedFile) {
        bindings.push({
          character: charName,
          mode: 'uploaded',
          source: `image://characters/${matchedFile}`,
          file: matchedFile
        });
      } else {
        // 文字描述模式
        const visualDesc = char.visual_anchor || char.appearance || char.description || '';
        bindings.push({
          character: charName,
          mode: 'text',
          source: visualDesc ? `文字定妆：${visualDesc}` : '未定义',
          description: visualDesc
        });
      }
    }
    
    // 回写到 prompts
    this._injectIntoPrompts(prompts, bindings);
    
    return { bindings };
  }

  /**
   * 【v2.8.0】从 PortraitStudio 定妆照集 manifest 匹配角色定妆照产物
   */
  _matchStudioPortraits(charName, charId, manifest) {
    if (!manifest || !Array.isArray(manifest.characters)) return [];
    const nameLower = (charName || '').toLowerCase();
    const idLower = (charId || '').toLowerCase();
    
    const entry = manifest.characters.find(c =>
      (c.characterName || '').toLowerCase() === nameLower ||
      (c.characterId || '').toLowerCase() === idLower
    );
    if (!entry) return [];
    
    return (entry.portraits || [])
      .filter(p => p.status === 'completed' && p.outputFile)
      .map(p => ({
        angle: p.angle,
        angleName: p.angleName,
        outputFile: p.outputFile
      }));
  }

  _scanUploadedPortraits() {
    try {
      if (!fs.existsSync(this.charactersDir)) return [];
      return fs.readdirSync(this.charactersDir)
        .filter(f => this.supportedExts.includes(path.extname(f).toLowerCase()));
    } catch (e) {
      console.warn(`[PortraitResolver] 扫描定妆照目录失败: ${e.message}`);
      return [];
    }
  }

  _matchUploadedPortrait(charName, charId, files) {
    const nameLower = (charName || '').toLowerCase();
    const idLower = (charId || '').toLowerCase();
    
    for (const file of files) {
      const fileBase = path.basename(file, path.extname(file)).toLowerCase();
      // 文件名包含角色名或角色ID（互相包含即命中）
      if (fileBase.includes(nameLower) || fileBase.includes(idLower) ||
          nameLower.includes(fileBase) || idLower.includes(fileBase)) {
        return file;
      }
    }
    return null;
  }

  _injectIntoPrompts(prompts, bindings) {
    for (const prompt of prompts || []) {
      if (!prompt.prompt || typeof prompt.prompt !== 'string') continue;
      
      // 找出涉及角色的镜头
      const involvedChars = bindings.filter(b => 
        prompt.prompt.includes(b.character) || 
        (prompt.characterRef && prompt.characterRef.includes(b.character))
      );
      
      if (involvedChars.length > 0) {
        const portraitSection = involvedChars.map(b => 
          `【定妆照】${b.character}: ${b.source}`
        ).join('\n');
        
        // 注入到 prompt 中（在角色一致性约束附近）
        if (prompt.prompt.includes('角色一致性')) {
          prompt.prompt = prompt.prompt.replace(
            /角色一致性[^【】]*约束[：:]/,
            match => `${match}\n${portraitSection}`
          );
        }
        
        // 记录绑定关系
        prompt.portraitBindings = involvedChars;
      }
    }
  }
}

module.exports = { PortraitResolver };
