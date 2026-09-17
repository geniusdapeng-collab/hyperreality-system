/**
 * Requirement Alignment Gate — 需求对齐闸机 (SuperMickey 适配版)
 *
 * 来源: 暴风战斧 requirement-alignment-gate.js
 * 适配: SuperMickey 四层架构，在最终返回前调用
 *
 * 核心能力：
 * 1. 需求契约提取：从用户意图中提取"不可协商元素"
 * 2. 多阶段对齐验证：检查各阶段是否保留契约元素
 * 3. 最终对齐评分：渲染前最后一道防线
 * 4. 反向追溯：从最终 prompts 反推是否包含原始故事
 */

class RequirementAlignmentGate {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.threshold = options.threshold || 0.7; // 对齐评分阈值
    this.strictMode = options.strictMode || false; // 严格模式：低于阈值阻止渲染

    // 道具误匹配排除列表（中文自然语言中的常见假阳性）
    this.propFalsePositives = [
      // 成语/固定搭配中的"元素字"
      '风采', '当年的风', '当年风', '的风', '之波', '云里', '雾里',
      // 非道具语境
      '风光', '风景', '风格', '风云', '风雨', '风暴', '风气',
      '水面', '水里', '水上', '水中',
      '光线', '光明', '光彩', '目光',
      '电影', '电视', '电话', '电脑', '电流', '电路',
      '天气', '空气', '氧气', '气温',
      '声音', '音乐', '音响'
    ];

    // 动作关键词库
    this.actionKeywords = [
      '大战', '对决', '激战', '交锋', '碰撞', '追逐', '逃亡', '变身',
      '施展', '祭出', '释放', '挥舞', '横扫', '刺穿', '击碎', '闪避',
      '腾空', '飞跃', '坠落', '撞击', '炸裂', '爆发', '凝聚', '消散',
      'battle', 'clash', 'showdown', 'confrontation', 'collision', 'impact',
      'chase', 'pursuit', 'transform', 'perform', 'execute', 'cast',
      'unleash', 'swing', 'strike', 'shatter', 'dodge', 'evade',
      'leap', 'fly', 'fall', 'crash', 'explode', 'erupt', 'gather', 'dissipate'
    ];

    // 场景排除词
    this.sceneExcludeWords = ['天庭', '下令', '追捕', '请缨', '展开', '最终', '同时', '约定', '英雄'];
  }

  /**
   * SuperMickey 主入口：对齐验证
   * @param {string} intent - 用户原始意图
   * @param {Object} metadata - 元数据
   * @param {Object} result - 最终创作结果（包含 stages, shots, prompts）
   * @returns {Object} { pass, score, missing, report }
   */
  validate(intent, metadata, result) {
    if (!this.enabled || !intent || !result) {
      return { pass: true, score: 1.0, missing: [], report: {} };
    }

    console.log('\n🔍 [RequirementAlignmentGate] 需求对齐验证...');

    // 1. 提取需求契约
    const contract = this._extractContract(intent, metadata);

    // 2. 反向追溯：从最终结果反推
    const prompts = result.prompts || [];
    const shots = result.shots || [];

    const foundCharacters = this._checkCharacters(contract.characters, prompts, shots);
    const foundScenes = this._checkScenes(contract.scenes, prompts, shots);
    const foundActions = this._checkActions(contract.actions, prompts, shots);
    const foundProps = this._checkProps(contract.props, prompts, shots);
    const foundEmotion = this._checkEmotion(contract.emotion, prompts, shots);
    const foundStyle = this._checkStyle(contract.style, prompts, shots);

    // 3. 计算对齐评分
    const totalElements = contract.elementsCount;
    const foundElements = foundCharacters.found + foundScenes.found + foundActions.found + foundProps.found + (foundEmotion ? 1 : 0) + (foundStyle ? 1 : 0);
    const score = totalElements > 0 ? foundElements / totalElements : 1.0;

    const missing = [];
    if (foundCharacters.missing.length > 0) missing.push(`角色: ${foundCharacters.missing.join(', ')}`);
    if (foundScenes.missing.length > 0) missing.push(`场景: ${foundScenes.missing.join(', ')}`);
    if (foundActions.missing.length > 0) missing.push(`动作: ${foundActions.missing.join(', ')}`);
    if (foundProps.missing.length > 0) missing.push(`道具: ${foundProps.missing.join(', ')}`);
    if (!foundEmotion) missing.push(`情绪: ${contract.emotion}`);
    if (!foundStyle) missing.push(`风格: ${contract.style}`);

    const pass = score >= this.threshold;

    console.log(`   ${pass ? '✅' : '⚠️'} 对齐评分: ${(score * 100).toFixed(0)}% (阈值: ${(this.threshold * 100).toFixed(0)}%)`);
    if (missing.length > 0) {
      console.log(`   缺失元素: ${missing.slice(0, 3).join(' | ')}${missing.length > 3 ? '...' : ''}`);
    }

    return {
      pass,
      score,
      missing,
      report: {
        contract,
        foundCharacters,
        foundScenes,
        foundActions,
        foundProps,
        foundEmotion,
        foundStyle
      }
    };
  }

  // ========== 私有方法 ==========

  _extractContract(intent, metadata) {
    const text = intent || '';
    const characters = [];
    const scenes = [];
    const actions = [];
    const props = [];

    // 1. 提取角色（从 metadata 或意图）
    if (metadata.characters && Array.isArray(metadata.characters)) {
      for (const char of metadata.characters) {
        const name = typeof char === 'string' ? char : (char.name || char);
        if (name) characters.push(name);
      }
    }

    // 2. 提取场景关键词
    // 【P1-QUAL-06 修复】支持中英文场景名和科幻/抽象场景
    const scenePatterns = [
      // 中文场景：花果山、天庭、水帘洞等
      /([\u4e00-\u9fa5]{2,6})(?:山|谷|林|海|湖|河|城|宫|殿|塔|洞|崖|原|野|空|庭|院|阁|楼)/g,
      // 中文场景+方位：在花果山上、在天庭中
      /在([\u4e00-\u9fa5]{2,6})(?:上|中|里|内|外|下|前|后)/g,
      // 英文场景：on Mount Huaguo, in Heaven, at Waterfall Curtain
      /(?:on|in|at|near)\s+([A-Z][a-zA-Z\s]{2,30})/g,
      // 科幻/抽象场景：cyberpunk city, virtual space, data center
      /(cyberpunk|virtual|digital|holographic|neon|futuristic|sci-fi|space\s+station|spacecraft|mecha|robot|android|AI|matrix|simulation|metaverse|blockchain|quantum|nanotech|biotech|cyborg|genetic|clone|dystopia|utopia|parallel|dimension|multiverse|timewarp|wormhole|black\s+hole|supernova|nebula|galaxy|star\s+system|planet|moon\s+base|space\s+colony|orbital|zero-gravity|deep\s+space|void|abyss|ether|aether|astral|ethereal|spectral|phantom|ghost|spirit|entity|being|creature|monster|dragon|phoenix|unicorn|griffin|chimera|hydra|kraken|leviathan|behemoth|titan|giant|colossus|golem|elemental|fae|fairy|elf|dwarf|orc|troll|ogre|goblin|vampire|werewolf|zombie|skeleton|lich|necromancer|sorcerer|wizard|mage|warlock|witch|enchanter|druid|shaman|paladin|knight|samurai|ninja|assassin|rogue|bard|ranger|hunter|barbarian|berserker|viking|spartan|gladiator|centurion|legionnaire|crusader|templar|inquisitor|exorcist|monk|priest|cleric|healer|alchemist|artificer|engineer|pilot|captain|commander|admiral|general|marshal|chancellor|emperor|king|queen|prince|princess|lord|lady|duke|duchess|count|countess|baron|baroness|sir|dame|majesty|highness|grace|eminence|holiness|excellency|lordship|ladyship|worship|sire|madam|mistress|master|chief|head|leader|boss|chieftain|patriarch|matriarch|elder|senior|ancestor|forefather|founder|creator|maker|builder|architect|designer|planner|strategist|tactician|skipper|driver|rider|jockey|equestrian|cavalier|cuirassier|dragoon|hussar|lancer|uhlan|cossack|hunn|vandal|visigoth|ostrogoth|goth|teuton|frank|saxon|angle|jute|norman|varangian|rus|slav|magyar|hungarian|tatar|turk|ottoman|persian|arab|berber|moor|saracen|hospitaller|teutonic|shogun|daimyo|ronin|sohei|yamabushi|onmyoji|miko|geisha|kabuki|noh|bunraku|rakugo|manzai|kyogen)/gi
    ];
    for (const pattern of scenePatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const sceneName = match[1];
        // 【A201-fix】过滤以虚词/代词结尾的碎片和常见口语碎片，消除误报
        const FRAGMENT_STOP = /[和与的了是有只在那我你他她它们，。、？！—…]$/;
        if (sceneName.length >= 2
          && !FRAGMENT_STOP.test(sceneName)
          && !/^(总有|那只|这只|一只|没有|什么|怎么)/.test(sceneName)
          && !this.sceneExcludeWords.includes(sceneName)
          && !characters.includes(sceneName)) {
          if (!scenes.includes(sceneName)) scenes.push(sceneName);
        }
      }
    }

    // 3. 提取动作关键词
    for (const keyword of this.actionKeywords) {
      if (text.includes(keyword)) {
        if (!actions.includes(keyword)) actions.push(keyword);
      }
    }

    // 4. 提取道具/武器
    const propPatterns = [
      /(?:[手持挥舞横扫刺穿击碎]{1,2})([\u4e00-\u9fa5]{1,4}(?:棒|刀|剑|枪|戟|叉|鞭|锤|斧|弓|箭|盾))/g,
      /([\u4e00-\u9fa5]{1,4}(?:棒|刀|剑|枪|戟|叉|鞭|锤|斧|弓|箭|盾|甲|袍|衣|冠|盔))/g,
      /([\u4e00-\u9fa5]{1,4}(?:火|水|风|雷|电|光|影|雾|云|气|波))/g,
      // 【P1-QUAL-06 修复】英文道具和武器
      /\b(sword|blade|dagger|knife|bow|gun|rifle|pistol|shotgun|staff|wand|mace|axe|hammer|shield|armor|helmet|lightsaber|blaster|phaser|artifact|relic|crystal|gem|potion|scroll|tome|grimoire|amulet|talisman|ring|necklace|bracelet|cloak|cape|robe|tunic)/gi
    ];
    for (const pattern of propPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const prop = match[1].trim();
        // 【v2.1.11 修复】过滤自然语言中的假阳性道具
        if (prop.length >= 2 && !props.includes(prop) && !this._isFalsePositiveProp(prop, text)) {
          props.push(prop);
        }
      }
    }

    // 5. 提取情绪
    // 【P1-QUAL-06 修复】支持中英文情绪关键词
    const emotionKeywords = {
      // 中文
      '热血': 'epic', '暗黑': 'dark', '悬疑': 'suspense', '感人': 'emotional',
      '治愈': 'healing', '恐怖': 'horror', '史诗': 'epic', '悲壮': 'tragic',
      '激昂': 'epic', '紧张': 'tense', '温馨': 'warm', '震撼': 'shocking',
      '忧郁': 'melancholy', '欢快': 'joyful', '浪漫': 'romantic', '神秘': 'mysterious',
      // 英文
      'epic': 'epic', 'dark': 'dark', 'suspense': 'suspense', 'emotional': 'emotional',
      'healing': 'healing', 'horror': 'horror', 'tragic': 'tragic', 'tense': 'tense',
      'warm': 'warm', 'shocking': 'shocking', 'melancholy': 'melancholy',
      'joyful': 'joyful', 'romantic': 'romantic', 'mysterious': 'mysterious',
      'thrilling': 'thrilling', 'dramatic': 'dramatic', 'calm': 'calm'
    };
    let emotion = null;
    for (const [cn, en] of Object.entries(emotionKeywords)) {
      // 【P1-QUAL-06 修复】同时检查中英文关键词和metadata.style
      if (text.includes(cn) || text.includes(en) || (metadata.style && metadata.style.primary === cn) || (metadata.style && metadata.style.primary === en)) {
        emotion = cn;
        break;
      }
    }

    // 6. 提取风格
    const style = metadata.style?.primary || null;

    const elementsCount = characters.length + scenes.length + actions.length + props.length + (emotion ? 1 : 0) + (style ? 1 : 0);

    return {
      characters,
      scenes,
      actions,
      props,
      emotion,
      style,
      elementsCount
    };
  }

  _checkCharacters(characters, prompts, shots) {
    let found = 0;
    const missing = [];
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');

    for (const char of characters) {
      if (allText.includes(char)) {
        found++;
      } else {
        missing.push(char);
      }
    }

    return { found, missing, total: characters.length };
  }

  _checkScenes(scenes, prompts, shots) {
    let found = 0;
    const missing = [];
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');

    for (const scene of scenes) {
      if (allText.includes(scene)) {
        found++;
      } else {
        missing.push(scene);
      }
    }

    return { found, missing, total: scenes.length };
  }

  _checkActions(actions, prompts, shots) {
    let found = 0;
    const missing = [];
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');

    for (const action of actions) {
      if (allText.includes(action)) {
        found++;
      } else {
        missing.push(action);
      }
    }

    return { found, missing, total: actions.length };
  }

  _checkProps(props, prompts, shots) {
    let found = 0;
    const missing = [];
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');

    for (const prop of props) {
      if (allText.includes(prop)) {
        found++;
      } else {
        missing.push(prop);
      }
    }

    return { found, missing, total: props.length };
  }

  _checkEmotion(emotion, prompts, shots) {
    if (!emotion) return true;
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');
    return allText.includes(emotion);
  }

  _checkStyle(style, prompts, shots) {
    if (!style) return true;
    const allText = [...prompts.map(p => p.prompt || ''), ...shots.map(s => s.description || s.prompt || '')].join(' ');
    return allText.includes(style);
  }

  /**
   * 【v2.1.11 修复】检查道具是否为自然语言中的假阳性
   * 中文自然语言中"风/云/水"等元素字常出现在成语/固定搭配中，
   * 并非真实道具（如"不减当年的风采"中的"风"）
   */
  _isFalsePositiveProp(prop, fullText) {
    // 1. 直接匹配已知假阳性列表
    if (this.propFalsePositives.includes(prop)) return true;

    // 2. 如果包含结构词"的/是/在/当"，大概率是自然语言而非道具
    if (/[的是在当]/g.test(prop)) return true;

    // 3. 如果"元素字"前面是常见非修饰字（如"年/月/日/天"），排除
    const elementChars = /(火|水|风|雷|电|光|影|雾|云|气|波)$/;
    if (elementChars.test(prop)) {
      const prefix = prop.replace(elementChars, '');
      if (prefix.length >= 1 && /[年月日天年当]/g.test(prefix)) return true;
    }

    return false;
  }
}

module.exports = { RequirementAlignmentGate };
