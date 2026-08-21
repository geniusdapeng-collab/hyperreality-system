/**
 * IdentityPersistenceSystem — 人物身份持续提示系统
 */
class IdentityPersistenceSystem {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.logPrefix = options.logPrefix || '[IdentityPersist]';
    this.injectionFrequency = options.injectionFrequency || 1;
  }

  persist(shots, characters = [], scenes = []) {
    if (!this.enabled || !shots || shots.length === 0 || !characters || characters.length === 0) {
      return shots;
    }

    console.log(`${this.logPrefix} 身份持续提示: ${shots.length} 镜头, ${characters.length} 角色`);
    const identityCards = characters.map(c => this._buildIdentityCard(c));

    for (let i = 0; i < shots.length; i++) {
      const shot = shots[i];

      if (i % this.injectionFrequency === 0) {
        const identityHint = this._generateIdentityHint(identityCards, shot, scenes[i]);
        if (identityHint && !shot.prompt.includes('身份持续')) {
          shot.prompt = this._injectIdentity(shot.prompt, identityHint);
          shot.promptCharCount = shot.prompt.length;
        }
      }

      shot.prompt = this._ensureCharacterIdentity(shot.prompt, identityCards);
    }

    return shots;
  }

  _buildIdentityCard(character) {
    const card = {
      name: character.name || '未知角色',
      id: character.id || character.name || '',
      role: character.role || '',
      description: character.description || '',
      age: character.age || '',
      gender: character.gender || '',
      occupation: character.occupation || '',
      clothing: character.clothing || '',
      features: character.features || character.tags || []
    };
    card.identityText = this._formatIdentity(card);
    return card;
  }

  _formatIdentity(card) {
    const parts = [card.name];
    if (card.age) parts.push(`${card.age}岁`);
    if (card.gender) parts.push(card.gender);
    if (card.occupation) parts.push(card.occupation);
    if (card.clothing) parts.push(`身穿${card.clothing}`);
    const desc = parts.join('，');
    if (card.features && card.features.length > 0) {
      return `${desc}。特征：${card.features.join('、')}`;
    }
    return desc;
  }

  _generateIdentityHint(identityCards, shot, scene) {
    if (!shot || !scene) return null;
    const sceneChars = scene.characters || [];
    const relevantCards = identityCards.filter(card =>
      sceneChars.includes(card.id) || sceneChars.includes(card.name)
    );
    if (relevantCards.length === 0) return null;
    const hints = relevantCards.map(card => card.identityText);
    return `【身份持续】${hints.join('；')}`;
  }

  _injectIdentity(prompt, hint) {
    return `${hint}\n${prompt}`;
  }

  _ensureCharacterIdentity(prompt, identityCards) {
    for (const card of identityCards) {
      // 【P1-DATA-04 修复】token-aware截断替代固定20字符
      const maxTokens = 20; // 目标token数
      const tokenLength = this._calculateTokenLength(card.identityText);
      const truncateLen = tokenLength > maxTokens ? this._getTokenAwareTruncateLength(card.identityText, maxTokens) : card.identityText.length;
      if (prompt.includes(card.name) && !prompt.includes(card.identityText.substring(0, truncateLen))) {
        const briefIdentity = `${card.name}(${card.role}${card.occupation ? '，' + card.occupation : ''})`;
        prompt = prompt.replace(card.name, briefIdentity);
      }
    }
    return prompt;
  }

  // 【P1-DATA-04 修复】token-aware截断辅助方法
  _calculateTokenLength(text) {
    let tokens = 0;
    for (const char of String(text)) {
      // 中文字符算2个token，英文/数字算1个token
      tokens += (char.charCodeAt(0) > 127) ? 2 : 1;
    }
    return tokens;
  }

  _getTokenAwareTruncateLength(text, maxTokens) {
    let tokens = 0;
    let length = 0;
    for (const char of String(text)) {
      tokens += (char.charCodeAt(0) > 127) ? 2 : 1;
      length++;
      if (tokens >= maxTokens) break;
    }
    return length;
  }
}

module.exports = { IdentityPersistenceSystem };
