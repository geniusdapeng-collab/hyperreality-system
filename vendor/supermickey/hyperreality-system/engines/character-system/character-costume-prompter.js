/**
 * CharacterCostumePrompter — 角色服装 Prompt 系统性注入器
 */
class CharacterCostumePrompter {
  constructor(options = {}) {
    this.strictMode = options.strictMode !== false;
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[CharacterCostume]';

    this.costumeKeywords = {
      tops: ['西装', '衬衫', 'T恤', '夹克', '外套', '毛衣', '风衣', '旗袍', '汉服', '制服', '背心', '卫衣'],
      bottoms: ['长裤', '短裤', '裙子', '牛仔裤', '西裤', '运动裤'],
      footwear: ['皮鞋', '运动鞋', '高跟鞋', '靴子', '凉鞋'],
      accessories: ['眼镜', '手表', '项链', '耳环', '帽子', '围巾', '领带', '腰带'],
      materials: ['棉质', '丝绸', '皮革', '牛仔', '羊毛', '亚麻']
    };

    this.forbiddenAdditions = ['墨镜', '面具', '头盔', '头巾'];
  }

  enhance(shots, characters = []) {
    if (!this.enabled || !shots || shots.length === 0) return shots;

    console.log(`${this.logPrefix} 开始服装增强: ${shots.length} 镜头, ${characters.length} 角色`);
    let enhancedCount = 0;

    for (const shot of shots) {
      const originalPrompt = shot.prompt || '';
      let enhancedPrompt = originalPrompt;

      for (const character of characters) {
        if (!character || !character.name) continue;
        const costumeAnchor = this._extractCostumeAnchor(character);
        if (!costumeAnchor) continue;

        const hasCostumeDesc = this._hasCostumeDescription(originalPrompt, character.name);
        if (!hasCostumeDesc) {
          enhancedPrompt = this._injectCostumeDescription(enhancedPrompt, character.name, costumeAnchor);
          enhancedCount++;
        } else {
          enhancedPrompt = this._validateAndFixCostume(enhancedPrompt, character);
        }
      }

      enhancedPrompt = this._checkForbiddenAdditions(enhancedPrompt, characters);
      shot.prompt = enhancedPrompt;
      shot.promptCharCount = enhancedPrompt.length;
    }

    console.log(`${this.logPrefix} 服装增强完成: ${enhancedCount} 处注入`);
    return shots;
  }

  _extractCostumeAnchor(character) {
    if (character.description) {
      const costumeDesc = this._extractCostumeFromText(character.description);
      if (costumeDesc) return costumeDesc;
    }
    if (character.tags && Array.isArray(character.tags)) {
      const costumeTags = character.tags.filter(tag =>
        Object.values(this.costumeKeywords).flat().some(kw => tag.includes(kw))
      );
      if (costumeTags.length > 0) return costumeTags.join('，');
    }
    return null;
  }

  _extractCostumeFromText(text) {
    if (!text) return null;
    const allKeywords = Object.values(this.costumeKeywords).flat();
    const foundItems = [];
    for (const keyword of allKeywords) {
      if (text.includes(keyword)) {
        const idx = text.indexOf(keyword);
        const start = Math.max(0, idx - 10);
        const end = Math.min(text.length, idx + keyword.length + 10);
        foundItems.push(text.substring(start, end));
      }
    }
    return foundItems.length > 0 ? foundItems.join('，') : null;
  }

  _hasCostumeDescription(prompt, characterName) {
    const allKeywords = Object.values(this.costumeKeywords).flat();
    const charIdx = prompt.indexOf(characterName);
    if (charIdx === -1) return false;
    const context = prompt.substring(charIdx, charIdx + 100);
    return allKeywords.some(kw => context.includes(kw));
  }

  _injectCostumeDescription(prompt, characterName, costumeAnchor) {
    const charIdx = prompt.indexOf(characterName);
    if (charIdx === -1) return `【服装锁定】${costumeAnchor}\n${prompt}`;
    const insertIdx = charIdx + characterName.length;
    return prompt.slice(0, insertIdx) + `（${costumeAnchor}）` + prompt.slice(insertIdx);
  }

  _validateAndFixCostume(prompt, character) {
    const costumeAnchor = this._extractCostumeAnchor(character);
    if (!costumeAnchor) return prompt;
    const currentCostume = this._extractCostumeFromText(prompt);
    if (!currentCostume) return prompt;

    const anchorItems = costumeAnchor.split('，');
    for (const item of anchorItems) {
      if (item.length < 2) continue;
      if (this._isCostumeChanged(currentCostume, item)) {
        console.warn(`${this.logPrefix} 检测到服装变更: ${character.name} 的 "${item}" 被修改`);
        if (this.strictMode) {
          prompt = prompt.replace(currentCostume, costumeAnchor);
        }
      }
    }
    return prompt;
  }

  _isCostumeChanged(current, anchor) {
    const anchorKeywords = anchor.split(/[，、]/).filter(k => k.length >= 2);
    return anchorKeywords.some(kw => !current.includes(kw));
  }

  _checkForbiddenAdditions(prompt, characters) {
    for (const forbidden of this.forbiddenAdditions) {
      if (prompt.includes(forbidden)) {
        console.warn(`${this.logPrefix} 检测到禁止项: ${forbidden}`);
        if (this.strictMode) {
          prompt = prompt.replace(forbidden, '');
        }
      }
    }
    return prompt;
  }
}

module.exports = { CharacterCostumePrompter };
