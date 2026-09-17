
/**
 * CreativeThemeGenerator - 创意主题生成器
 * 位置: 全链路最开头
 * 职责: 将任意用户输入转化为结构化的12字段创意主题
 * v2.1.7: 新增模块，解决用户输入→标准化需求的断层
 */

const { EventBus } = require('../../infrastructure/event-bus');
const { DynamicTypeResolver } = require('./dynamic-type-resolver');

// ============ 配置常量 ============
// 【v2.1.8-fix】扩展类型库，增加文学/情绪/氛围类关键词（P5修复）
const TYPE_LIBRARY = {
  '医疗急救': ['医疗', '医院', '急救', '手术', '医生', '护士', '抢救'],
  '硬科幻': ['科幻', '太空', '未来', '火星', '星际', '宇宙', '飞船'],
  '赛博朋克': ['赛博', '朋克', '霓虹', '黑客', '义体', '未来都市'],
  '武侠动作': ['武侠', '古装', '剑客', '江湖', '功夫', '门派'],
  '恐怖悬疑': ['恐怖', '惊悚', '悬疑', '鬼', '灵异', '密室', '推理', '凶手', '杀人', '侦探'],
  '自然纪录片': ['自然', '动物', '森林', '海洋', '纪录片', '生态', '雨林', '极地', '深海'],
  '美食文化': ['美食', '餐厅', '料理', '烹饪', '厨师', '食材', '深夜食堂', '舌尖上的'],
  '商业广告': ['商业', '广告', '产品', '品牌', '宣传', '营销', 'TVC', '宣传片', 'slogan', 'logo', '品牌故事'],
  '科普教育': ['科普', '教育', '知识', '科学', '教学', '讲解', '小学生', '数据可视化', '动画版'],
  '音乐MV': ['音乐', '舞蹈', 'MV', '节奏', '歌曲', '演唱会', '编舞', '歌舞'],
  '家庭温情': ['家庭', '亲情', '温情', '父母', '孩子', '团圆', '成长', '纪念', '宝宝', '女儿', '儿子'],
  '浪漫爱情': ['爱情', '浪漫', '恋爱', '约会', '情侣', '告白', '甜蜜', '心动'],
  '喜剧荒诞': ['喜剧', '搞笑', '幽默', '荒诞', '无厘头', '讽刺', '猫咪', '逆袭', '反转', '搞笑'],
  '历史战争': ['历史', '战争', '古代', '朝代', '战场', '将军', '史诗', '帝王', '王朝'],
  '艺术实验': ['艺术', '实验', '抽象', '意识', '先锋', '独立', '诗歌', '海子', '文学', '意象', '隐喻', '孤独', '氛围', '樱花季', '物哀'],
  '社会现实': ['社会', '现实', '底层', '民生', '阶层', '都市', '城中村', '快递员', '环卫工人', '小摊贩', '工人', '医院', '观察'],
  '运动竞技': ['运动', '体育', '竞技', '比赛', '运动员', '冠军'],
  '文化遗产': ['文化', '遗产', '传统', '工艺', '非遗', '文物', '油纸伞', '手艺人', '传承', '故宫', '修复', '敦煌'],
  '旅游推广': ['旅游', '景点', 'City', ' viral', '抖音', '推广', ' viral', '旅行', '风景', '城市']
};

const TONE_LIBRARY = {
  '紧张压抑': ['紧张', '压抑', '窒息', '紧迫', '危机', '危急'],
  '温暖治愈': ['温暖', '治愈', '感人', '温情', '暖心', '感动'],
  '黑色幽默': ['搞笑', '幽默', '荒诞', '无厘头', '讽刺', '喜剧'],
  '心理恐惧': ['恐怖', '吓人', '诡异', '阴森', '毛骨悚然'],
  '热血感动': ['热血', '激动', '燃', '震撼', '励志', '拼搏'],
  'bittersweet': ['浪漫', '甜蜜', '苦涩', '遗憾', '错过'],
  '神秘敬畏': ['神秘', '未知', '探索', '好奇', '浩瀚', '深邃'],
  '冷酷精密': ['冷酷', '冰冷', '无情', '机械', '理性', '精准'],
  '诗意哀伤': ['诗意', '抒情', '忧伤', '哀愁', '孤独', '怀旧'],
  '肃杀诗意': ['肃杀', '冷峻', '凌厉', '悲壮', '苍凉'],
  '轻快明朗': ['欢快', '明亮', '轻松', '愉快', '阳光'],
  '史诗悲壮': ['史诗', '宏大', '悲壮', '英雄', '牺牲']
};

const DIFFICULTY_KEYWORDS = {
  '极高': ['极限', '硬核', '地狱', '不可能', '疯狂', '终极'],
  '高': ['有挑战', '有压力', '困难', '高级', '复杂'],
  '中': ['中等', '正常', '标准', '普通', '一般'],
  '低': ['简单', '入门', '基础', '轻松', '容易']
};

const PRESSURE_ANCHORS = [
  { id: 'PA-01', name: '物理模拟', tags: ['流体', '刚体', '布料', '粒子', '烟雾', '火焰'], types: ['硬科幻', '灾难', '武侠动作'] },
  { id: 'PA-02', name: '微表情/表演', tags: ['面部', '瞳孔', '呼吸', '眼神'], types: ['医疗急救', '浪漫爱情', '家庭温情'] },
  { id: 'PA-03', name: '群像调度', tags: ['多角色', '站位', '视线', '走位'], types: ['历史战争', '武侠动作', '商业广告'] },
  { id: 'PA-04', name: '一镜到底', tags: ['长镜头', '无剪辑', '连续性'], types: ['艺术实验', '动作', '恐怖悬疑'] },
  { id: 'PA-05', name: '科学可视化', tags: ['抽象概念', '公式', '数据', '微观'], types: ['硬科幻', '科普教育'] },
  { id: 'PA-06', name: '文化遗产', tags: ['历史精确', '工艺', '服饰', '道具'], types: ['历史战争', '文化遗产', '武侠动作'] },
  { id: 'PA-07', name: '零重力/特殊物理', tags: ['太空', '深海', '微观', '非地球'], types: ['硬科幻', '自然纪录片'] },
  { id: 'PA-08', name: '音乐/节拍同步', tags: ['视听同步', 'BPM', '节奏', '舞蹈'], types: ['音乐MV', '艺术实验'] },
  { id: 'PA-09', name: '非线性叙事', tags: ['时间跳跃', '意识流', '记忆碎片'], types: ['艺术实验', '恐怖悬疑', '心理'] },
  { id: 'PA-10', name: '行业术语精确', tags: ['医学', '法律', '军事', '工程'], types: ['医疗急救', '历史战争'] },
  { id: 'PA-11', name: '生物力学', tags: ['运动', '变形', '病理', '古生物'], types: ['运动竞技', '自然纪录片', '武侠动作'] },
  { id: 'PA-12', name: '视觉欺骗', tags: ['透视违反', '超现实', '非欧几何'], types: ['艺术实验', '恐怖悬疑'] }
];

const FILM_REFERENCES = {
  '医疗急救': ['《急诊室的故事》', '《白色巨塔》', '《机智医生生活》'],
  '硬科幻': ['《星际穿越》', '《2001太空漫游》', '《降临》'],
  '赛博朋克': ['《银翼杀手2049》', '《攻壳机动队》', '《阿基拉》'],
  '武侠动作': ['《卧虎藏龙》', '《绣春刀》', '《一代宗师》'],
  '恐怖悬疑': ['《怪形》', '《恐怖游轮》', '《遗传厄运》'],
  '自然纪录片': ['《蓝色星球》', '《绿色星球》', '《我们的星球》'],
  '商业广告': ['苹果发布会风格', '《她》科技美学'],
  '科普教育': ['《宇宙时空之旅》', '《细胞》', '《人体奥秘》'],
  '音乐MV': ['《爱乐之城》', '《幻想曲2000》', '《创：战纪》'],
  '家庭温情': ['《海街日记》', '《步履不停》', '《美丽人生》'],
  '浪漫爱情': ['《爱》', '《本杰明·巴顿奇事》', '《时空恋旅人》'],
  '喜剧荒诞': ['《楚门的世界》', '《布达佩斯大饭店》', '《摩登时代》'],
  '历史战争': ['《拯救大兵瑞恩》', '《1917》', '《大明王朝1566》'],
  '社会现实': ['贾樟柯作品风格', '《十二怒汉》', '《我不是药神》'],
  '艺术实验': ['《镜子》', '《永恒和一日》', '《入侵脑细胞》'],
  '运动竞技': ['《烈火战车》', '《极速车王》', '《摔跤吧爸爸》'],
  '美食文化': ['《舌尖上的中国》', '《主厨的餐桌》', '《小森林》'],
  '文化遗产': ['《我在故宫修文物》', '《数字敦煌》', '《至爱梵高》'],
  '旅游推广': ['《航拍中国》', '《地球脉动》', '抖音 viral 风格']  // 【v2.1.8-fix】P5修复
};

const TYPE_DURATION_RANGES = {
  '医疗急救': { min: 40, max: 60 },
  '硬科幻': { min: 45, max: 60 },
  '赛博朋克': { min: 35, max: 55 },
  '武侠动作': { min: 40, max: 60 },
  '恐怖悬疑': { min: 35, max: 50 },
  '自然纪录片': { min: 40, max: 60 },
  '美食文化': { min: 30, max: 45 },
  '商业广告': { min: 15, max: 30 },
  '科普教育': { min: 30, max: 50 },
  '音乐MV': { min: 30, max: 60 },
  '家庭温情': { min: 30, max: 50 },
  '浪漫爱情': { min: 30, max: 50 },
  '喜剧荒诞': { min: 25, max: 45 },
  '历史战争': { min: 45, max: 60 },
  '艺术实验': { min: 40, max: 60 },
  '社会现实': { min: 35, max: 50 },
  '运动竞技': { min: 35, max: 55 },
  '文化遗产': { min: 40, max: 60 },
  '旅游推广': { min: 15, max: 30 }  // 【v2.1.8-fix】P5修复
};

const TYPE_AUDIENCE = {
  '医疗急救': '医学专业人士/医疗剧爱好者',
  '硬科幻': '科幻迷/科技从业者',
  '赛博朋克': '科幻游戏玩家/视觉系观众',
  '武侠动作': '武侠片爱好者/动作片观众',
  '恐怖悬疑': '惊悚片爱好者/年轻成人',
  '自然纪录片': '自然爱好者/全年龄',
  '美食文化': '美食爱好者/生活方式受众',
  '商业广告': '目标消费者/品牌受众',
  '科普教育': '学生/知识爱好者',
  '音乐MV': '音乐爱好者/年轻群体',
  '家庭温情': '家庭观众/亲情主题爱好者',
  '浪漫爱情': '爱情片观众/年轻女性',
  '喜剧荒诞': '喜剧爱好者/全年龄',
  '历史战争': '历史爱好者/男性观众',
  '艺术实验': '电影节观众/艺术爱好者',
  '社会现实': '文艺片观众/关注社会议题者',
  '运动竞技': '体育爱好者/年轻男性',
  '文化遗产': '文化爱好者/高知群体',
  '旅游推广': '旅行者/城市探索者/短视频用户'  // 【v2.1.8-fix】P5修复
};

// ============ 输入规范化器 ============
class InputNormalizer {
  /**
   * 将任意格式输入统一规范化
   * 支持: JSON、Python dict、纯文本、Markdown 等
   * 【v2.1.8-fix】保留原始结构化字段，不只是转换为文本
   */
  normalize(input) {
    // 【v2.1.8-fix】如果输入已经是对象，直接提取字段
    if (input && typeof input === 'object' && !Array.isArray(input)) {
      return this._extractFromObject(input, 'object');
    }
    
    const text = String(input || '').trim();
    
    // 【v2.1.8-fix】P3修复：检测 Markdown 表格
    if (text.includes('|') && text.includes('\n')) {
      const tableResult = this._normalizeMarkdownTable(text);
      if (tableResult) return tableResult;
    }
    
    // 场景1: JSON 格式
    if ((text.startsWith('{') && text.endsWith('}')) || 
        (text.startsWith('[') && text.endsWith(']'))) {
      return this._normalizeJSON(text);
    }
    
    // 场景2: Python dict 格式 (key='value' 或 key="value")
    if (text.includes("='") || text.includes('="') || text.includes('": ')) {
      const pythonResult = this._normalizePythonDict(text);
      if (pythonResult) return pythonResult;
    }
    
    // 场景3: 代码块 (```json/```python)
    if (text.includes('```')) {
      const codeResult = this._normalizeCodeBlock(text);
      if (codeResult) return codeResult;
    }
    
    // 场景4: 纯文本（直接返回）
    return { text, format: 'text', sourceFields: {} };
  }
  
  _normalizeJSON(text) {
    try {
      const data = JSON.parse(text);
      return this._extractFromObject(data, 'json');
    } catch (e) {
      // JSON 解析失败，可能是截断或不完整的 JSON，尝试提取关键字段
      return this._extractFieldsFromText(text, 'json-partial');
    }
  }
  
  _normalizePythonDict(text) {
    // 尝试匹配 key='value' 或 key="value" 或 key: value 模式
    const fieldPatterns = [
      // "key": "value" 或 'key': 'value'
      /['"](\w+)['"]\s*:\s*['"]([^'"]+)['"]/g,
      // key='value'
      /(\w+)\s*=\s*['"]([^'"]+)['"]/g,
      // key: value (无引号字符串)
      /['"](\w+)['"]\s*:\s*([^,\n\r]+)/g
    ];
    
    const rawFields = {};
    for (const pattern of fieldPatterns) {
      let match;
      while ((match = pattern.exec(text)) !== null) {
        const [, key, value] = match;
        if (key && value) {
          rawFields[key] = value.trim();
        }
      }
    }
    
    if (Object.keys(rawFields).length < 2) return null;
    
    // 【v2.1.8-fix】使用 fieldMap 映射非标准字段名（如 genre -> type）
    const fieldMap = {
      'type': ['type', '类型', 'category', 'genre', 'kind'],
      'theme': ['theme', '主题', 'title', 'name', 'idea', 'concept'],
      'description': ['description', '描述', 'desc', 'content', 'prompt', 'story', 'plot', 'narrative'],
      'duration_sec': ['duration_sec', 'duration', '时长', 'length', 'time'],
      'tone': ['tone', '情绪', 'mood', 'emotion', 'atmosphere', 'vibe'],
      'visual_style': ['visual_style', 'visual', 'style', '画风'],
      'dialogue_requirement': ['dialogue_requirement', 'dialogue', '对白', '台词'],
      'special_notes': ['special_notes', 'special', '备注', 'notes', 'twist', '反转'],
      'target_audience': ['target_audience', 'audience', '受众', 'target'],
      'creative_style': ['creative_style', 'creative', 'creativity'],
      'difficulty': ['difficulty', '难度', 'level'],
      'task_id': ['task_id', 'id', 'taskId']
    };
    
    const fields = {};
    for (const [rawKey, rawValue] of Object.entries(rawFields)) {
      let mapped = false;
      for (const [canonical, aliases] of Object.entries(fieldMap)) {
        if (aliases.includes(rawKey.toLowerCase()) || aliases.includes(rawKey)) {
          fields[canonical] = rawValue;
          mapped = true;
          break;
        }
      }
      if (!mapped) {
        fields[rawKey] = rawValue; // 保留未映射的原始字段
      }
    }
    
    return this._buildTextFromFields(fields, 'python-dict');
  }
  
  _normalizeCodeBlock(text) {
    // 提取 ```json/```python 等代码块内容
    const codeBlockPattern = /```(?:json|python)?\s*\n?([\s\S]*?)```/;
    const match = text.match(codeBlockPattern);
    if (match) {
      const content = match[1].trim();
      // 递归处理代码块内的内容
      return this.normalize(content);
    }
    return null;
  }
  
  /**
   * 【v2.1.8-fix】P3修复：解析 Markdown 表格
   */
  _normalizeMarkdownTable(text) {
    // 检测是否为 Markdown 表格（至少两行，包含 | 分隔符）
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    if (lines.length < 2) return null;
    
    // 检查是否有表格分隔行（如 |---|---|）
    const hasSeparator = lines.some(l => /^\|[\s-:|]+\|$/.test(l));
    const hasPipeRows = lines.filter(l => l.startsWith('|') && l.endsWith('|')).length >= 2;
    
    if (!hasSeparator && !hasPipeRows) return null;
    
    // 解析表格
    const tableLines = lines.filter(l => l.startsWith('|') && l.endsWith('|'));
    if (tableLines.length < 2) return null;
    
    // 提取表头（第一行）
    const headerLine = tableLines[0];
    const headers = headerLine.split('|').map(h => h.trim()).filter(h => h.length > 0);
    if (headers.length === 0) return null;
    
    // 提取数据行（跳过表头和分隔行）
    const dataRows = [];
    for (let i = 1; i < tableLines.length; i++) {
      const line = tableLines[i];
      // 跳过分隔行
      if (/^\|[\s-:|]+\|$/.test(line)) continue;
      
      const cells = line.split('|').map(c => c.trim()).filter(c => c.length > 0);
      if (cells.length > 0) {
        dataRows.push(cells);
      }
    }
    
    if (dataRows.length === 0) return null;
    
    // 构建结构化文本：将表格转换为场景描述
    const parts = [];
    
    // 检测是否有场景/情绪等关键列
    const sceneIndex = headers.findIndex(h => /场景|地点|环境/.test(h));
    const characterIndex = headers.findIndex(h => /角色|人物|主角/.test(h));
    const actionIndex = headers.findIndex(h => /动作|行为|事件/.test(h));
    const emotionIndex = headers.findIndex(h => /情绪|情感|心情/.test(h));
    
    for (const row of dataRows) {
      const sceneDesc = [];
      if (sceneIndex >= 0 && row[sceneIndex]) sceneDesc.push(`在${row[sceneIndex]}`);
      if (characterIndex >= 0 && row[characterIndex]) sceneDesc.push(`${row[characterIndex]}`);
      if (actionIndex >= 0 && row[actionIndex]) sceneDesc.push(`${row[actionIndex]}`);
      if (emotionIndex >= 0 && row[emotionIndex]) sceneDesc.push(`感到${row[emotionIndex]}`);
      
      if (sceneDesc.length > 0) {
        parts.push(sceneDesc.join('，'));
      }
    }
    
    const description = parts.join('；');
    const fields = { description };
    
    // 推断类型：根据表格内容
    if (description.includes('办公室') || description.includes('白领')) {
      fields._typeHint = '社会现实';
    }
    
    return this._buildTextFromFields(fields, 'markdown-table', { 
      _tableData: { headers, rows: dataRows },
      description 
    });
  }
  
  _extractFromObject(data, format) {
    const fields = {};
    
    // 【v2.1.8-fix】提取所有字段，支持标准字段和非标准字段（P2修复）
    const fieldMap = {
      'type': ['type', '类型', 'category', 'genre', 'kind', '种类', '题材'],
      'theme': ['theme', '主题', 'title', 'name', 'idea', 'concept', '创意', '想法'],
      'description': ['description', '描述', 'desc', 'content', 'prompt', 'story', 'plot', '情节', '梗概', 'summary', 'narrative'],
      'duration_sec': ['duration_sec', 'duration', '时长', 'length', 'time', '时长'],
      'tone': ['tone', '情绪', 'mood', 'emotion', 'atmosphere', 'vibe', '氛围', '感觉', 'feeling'],
      'visual_style': ['visual_style', 'visual', '视觉风格', 'style', '画风', '美术风格'],
      'dialogue_requirement': ['dialogue_requirement', 'dialogue', '对白', '台词', '台词要求', '对话'],
      'special_notes': ['special_notes', 'special', '备注', 'notes', 'requirements', 'twist', '反转', '要求', '注意', '关键点'],
      'target_audience': ['target_audience', 'audience', '受众', '观众', 'target', '目标人群', '人群'],
      'creative_style': ['creative_style', 'creative', '创意系数', 'creativity', 'creative_intensity'],
      'difficulty': ['difficulty', '难度', 'level', '复杂程度'],
      'task_id': ['task_id', 'id', '编号', 'taskId']
    };
    
    for (const [canonical, aliases] of Object.entries(fieldMap)) {
      for (const alias of aliases) {
        if (data[alias] !== undefined) {
          fields[canonical] = data[alias];
          break;
        }
      }
    }
    
    // 【v2.1.8-fix】从非标准字段推断 type（如 idea/genre 包含类型关键词）
    if (!fields.type) {
      const typeHints = data.idea || data.genre || data.concept || data.题材 || '';
      if (typeHints) {
        fields._typeHint = typeHints;
      }
    }
    
    // 【v2.1.8-fix】从 protagonist/主角/character 推断角色信息
    if (!fields.theme && (data.protagonist || data.主角 || data.character || data.角色)) {
      const protagonist = data.protagonist || data.主角 || data.character || data.角色;
      fields._protagonistHint = protagonist;
    }
    
    return this._buildTextFromFields(fields, format, data);
  }
  
  _buildTextFromFields(fields, format, originalData = null) {
    // 构建规范化文本：优先使用 description，其次是 theme + 其他字段
    const parts = [];
    
    // 1. 类型信息（如果有）
    if (fields.type) {
      parts.push(String(fields.type));
    }
    
    // 2. 主题信息（如果有）
    if (fields.theme) {
      parts.push(String(fields.theme));
    }
    
    // 3. 核心描述（最重要）
    if (fields.description) {
      parts.push(String(fields.description));
    }
    
    // 4. 其他补充信息
    const extraFields = ['dialogue_requirement', 'visual_style', 'special_notes', 'tone', 'target_audience'];
    for (const field of extraFields) {
      if (fields[field] && !parts.includes(String(fields[field]))) {
        parts.push(String(fields[field]));
      }
    }
    
    // 5. 时长信息
    if (fields.duration_sec) {
      parts.push(`${fields.duration_sec}秒`);
    }
    
    const normalizedText = parts.join('，');
    
    return {
      text: normalizedText,
      format,
      sourceFields: fields,
      // 【v2.1.8-fix】保留原始完整数据
      _originalData: originalData
    };
  }
  
  _extractFieldsFromText(text, format) {
    // 从非标准文本中提取可能的字段
    const fields = {};
    
    // 尝试匹配 "key": "value" 模式（可能是不完整的 JSON）
    const pairPattern = /['"](\w+)['"]\s*:\s*['"]([^'"]+)['"]/g;
    let match;
    while ((match = pairPattern.exec(text)) !== null) {
      fields[match[1]] = match[2];
    }
    
    if (Object.keys(fields).length >= 2) {
      return this._buildTextFromFields(fields, format);
    }
    
    // 回退：返回清理后的文本
    const cleanText = text.replace(/[{}[\]"']/g, ' ').replace(/\s+/g, ' ').trim();
    return { text: cleanText, format, sourceFields: {} };
  }
}

// ============ 输入解析器 ============
class InputParser {
  parse(input) {
    // 【v2.1.8-fix】先规范化输入（支持 JSON/Python/纯文本等多种格式）
    const normalizer = new InputNormalizer();
    const normalized = normalizer.normalize(input);
    const text = normalized.text;
    
    console.log(`[InputParser] 输入格式: ${normalized.format}, 长度: ${text.length}字符`);
    
    // 场景C：无输入/随机
    if (!text || this._isRandomRequest(text)) {
      return { scene: 'C', input: text, sourceFields: normalized.sourceFields, _originalData: normalized._originalData };
    }
    
    // 场景D：长篇文本
    if (text.length > 500) {
      return { scene: 'D', input: text, sourceFields: normalized.sourceFields, _originalData: normalized._originalData };
    }
    
    // 场景B：单个关键词（需排除有语法结构的短中文描述）
    if (text.length < 20 && !text.includes(' ')) {
      // 【v2.1.8-fix-sceneB】中文文本若包含语法助词/介词/量词，则不是单个关键词
      const chineseGrammarMarkers = /[在的了一是过到和跟与向从]/;
      const hasStructure = chineseGrammarMarkers.test(text);
      if (!hasStructure) {
        return { scene: 'B', input: text, sourceFields: normalized.sourceFields, _originalData: normalized._originalData };
      }
      // 有语法结构 → 继续后续检测，不按Scene B处理
    }
    
    // 场景E：部分字段检测（基于规范化后的文本）
    const partialFields = this._detectPartialFields(text, normalized.sourceFields);
    if (partialFields.length >= 2) {
      return { scene: 'E', input: text, partialFields, sourceFields: normalized.sourceFields, _originalData: normalized._originalData };
    }
    
    // 场景A：自然语言描述
    return { scene: 'A', input: text, sourceFields: normalized.sourceFields, _originalData: normalized._originalData };
  }
  
  _isRandomRequest(text) {
    const triggers = ['随便', '随机', '来一个', '推荐', '创意主题', '随便来', '来几个'];
    return triggers.some(t => text.includes(t));
  }
  
  _detectPartialFields(text, sourceFields = {}) {
    const fields = [];
    
    // 检测类型（基于描述内容而非关键词）
    const typeFromSource = sourceFields?.type;
    if (typeFromSource) {
      // 如果原始输入明确提供了类型，优先使用
      const normalizedType = this._normalizeTypeName(typeFromSource);
      if (normalizedType) {
        fields.push({ field: 'type', value: normalizedType });
      }
    }
    
    // 基于内容推断类型（仅在明确指定时才推断，避免误匹配）
    if (!fields.find(f => f.field === 'type')) {
      // 【v2.1.8-fix】P4修复：不在 InputNormalizer 中推断类型，避免辅助词误匹配
      // 类型推断留给 FieldCompleter._inferTypeWeighted 处理
      // const inferredType = this._inferTypeWeighted(text);
      // if (inferredType) {
      //   fields.push({ field: 'type', value: inferredType });
      // }
    }
    
    // 【v2.1.8-fix】检测时长（P1修复：匹配所有时间值，选择目标时长附近的合理值）
    const allDurations = [];
    const durationRegex = /(\d+)\s*(秒|分钟|分|s|min)/g;
    let durationMatch;
    while ((durationMatch = durationRegex.exec(text)) !== null) {
      const num = parseInt(durationMatch[1]);
      const unit = durationMatch[2];
      const sec = unit === '分钟' || unit === '分' || unit === 'min' ? num * 60 : num;
      allDurations.push({ value: sec, raw: num + unit, index: durationMatch.index });
    }
    
    if (allDurations.length > 0) {
      // 策略：选择最接近目标视频时长的值（30-120秒范围内的）
      // 如果没有在合理范围内，选择最小的值（通常是目标时长）
      const reasonable = allDurations.filter(d => d.value >= 15 && d.value <= 120);
      if (reasonable.length > 0) {
        // 选择最小值（通常是目标时长）
        const selected = reasonable.sort((a, b) => a.value - b.value)[0];
        fields.push({ field: 'duration_sec', value: selected.value });
      } else {
        // 都不在合理范围，选择最小的
        const selected = allDurations.sort((a, b) => a.value - b.value)[0];
        fields.push({ field: 'duration_sec', value: selected.value });
      }
    }
    
    // 检测情绪
    for (const [tone, keywords] of Object.entries(TONE_LIBRARY)) {
      if (keywords.some(k => text.includes(k))) {
        fields.push({ field: 'tone', value: tone });
        break;
      }
    }
    return fields;
  }
  
  /**
   * 规范化类型名称（处理用户自定义类型）
   */
  _normalizeTypeName(typeName) {
    const typeMappings = {
      '音乐舞蹈·编舞同步': '音乐MV',
      '音乐MV': '音乐MV',
      '音乐': '音乐MV',
      '舞蹈': '音乐MV',
      '编舞': '音乐MV',
      '纪录片': '自然纪录片',
      '科幻': '硬科幻',
      '武侠': '武侠动作',
      '恐怖': '恐怖悬疑',
      '悬疑': '恐怖悬疑',  // 【v2.1.8-fix】P2修复
      '推理': '恐怖悬疑',
      '广告': '商业广告',
      '宣传片': '商业广告',
      '科普': '科普教育',
      '教育': '科普教育',
      '美食': '美食文化',
      '家庭': '家庭温情',
      '爱情': '浪漫爱情',
      '浪漫': '浪漫爱情',
      '喜剧': '喜剧荒诞',
      '搞笑': '喜剧荒诞',
      '历史': '历史战争',
      '战争': '历史战争',
      '运动': '运动竞技',
      '体育': '运动竞技',
      '文化': '文化遗产',
      '社会': '社会现实',
      '艺术': '艺术实验',
      '实验': '艺术实验'
    };
    
    const normalized = String(typeName).trim();
    return typeMappings[normalized] || null;
  }
  
  /**
   * 加权类型推断（避免单一关键词误匹配）
   * 策略: 统计每个类型的关键词命中数，选择得分最高的
   */
  /**
   * 加权类型推断（避免单一关键词误匹配）
   * 策略: 统计每个类型的关键词命中数，选择得分最高的
   * 【v2.1.8-fix】P4修复：排除辅助词修饰和否定语境中的关键词
   */
  _inferTypeWeighted(text) {
    const scores = {};
    
    // 【v2.1.8-fix-context】高置信度上下文推断（优先于关键词匹配）
    const contextType = this._inferTypeByContext(text);
    if (contextType) {
      console.log(`[CreativeThemeGenerator] 🎯 上下文推断命中: ${contextType}`);
      return contextType;
    }
    
    // 预处理：标记否定语境（"不要..."、"不需要..."）
    const negationPattern = /(不要|不需要|不是|没有|不含|禁止|拒绝)[\s\w\u4e00-\u9fa5]{0,10}?(音乐|歌曲|舞蹈|节奏)/gi;
    const negatedRanges = [];
    let negMatch;
    while ((negMatch = negationPattern.exec(text)) !== null) {
      negatedRanges.push({ start: negMatch.index, end: negMatch.index + negMatch[0].length });
    }
    
    // 【v2.1.8-fix】P4修复：辅助词黑名单——这些词修饰后的关键词直接排除
    const auxiliaryPatterns = [
      /背景\s*音乐/gi,      // "背景音乐" 不算音乐MV
      /配\s*乐/gi,          // "配乐" 不算音乐MV
      /辅助\s*音乐/gi,      // "辅助音乐" 不算音乐MV
      /不要\s*.{0,5}音乐/gi, // "不要...音乐" 否定语境
      /不需要\s*.{0,5}音乐/gi,
      /煽情\s*音乐/gi       // "煽情音乐" 否定语境
    ];
    
    // 【v2.1.8-fix-context】排除规则：特定组合不应匹配某类型
    const exclusionRules = [
      { pattern: /动物园/, excludeType: '自然纪录片', reason: '动物园是场所 visit，不是自然纪录片' },
      { pattern: /宝宝|婴儿|小孩|女儿|儿子|孩子.*动物园|动物园.*孩子/, excludeType: '自然纪录片', reason: '亲子游动物园应归类家庭温情' },
      { pattern: /宝宝|婴儿|小孩|女儿|儿子|孩子.*医院|医院.*孩子/, excludeType: '医疗急救', reason: '儿童医院场景应归类家庭温情' }
    ];
    const excludedTypes = new Set();
    for (const rule of exclusionRules) {
      if (rule.pattern.test(text)) {
        excludedTypes.add(rule.excludeType);
      }
    }
    
    for (const [type, keywords] of Object.entries(TYPE_LIBRARY)) {
      // 跳过被排除的类型
      if (excludedTypes.has(type)) {
        continue;
      }
      
      let score = 0;
      for (const keyword of keywords) {
        // 使用正则匹配完整词
        const regex = new RegExp(keyword, 'gi');
        let matches;
        while ((matches = regex.exec(text)) !== null) {
          const matchStart = matches.index;
          const matchEnd = matchStart + matches[0].length;
          
          // 检查是否在否定语境中
          const isNegated = negatedRanges.some(r => 
            (matchStart >= r.start && matchStart <= r.end) ||
            (matchEnd >= r.start && matchEnd <= r.end)
          );
          
          if (isNegated) continue; // 否定语境中直接跳过
          
          // 【v2.1.8-fix】检查是否被辅助词修饰
          const matchedText = text.substring(Math.max(0, matchStart - 5), Math.min(text.length, matchEnd + 5));
          const isAuxiliary = auxiliaryPatterns.some(p => p.test(matchedText));
          
          if (isAuxiliary) continue; // 辅助词修饰直接跳过
          
          // 长关键词权重更高
          score += matches[0].length * 2;
        }
      }
      if (score > 0) {
        scores[type] = score;
      }
    }
    
    // 选择得分最高的类型
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null;
    
    // 如果最高分明显领先（> 第二名的1.5倍），直接采用
    if (sorted.length === 1 || sorted[0][1] > sorted[1][1] * 1.5) {
      return sorted[0][0];
    }
    
    // 分数接近时，返回 null（让上层使用更多上下文判断）
    return null;
  }
  
  /**
   * 【v2.1.8-fix-context】基于上下文的类型推断
   * 通过语义组合（而非关键词子串匹配）推断高置信度类型
   */
  _inferTypeByContext(text) {
    // 规则1: 宝宝/孩子 + 场所（动物园/公园/游乐园等）→ 家庭温情
    const childPattern = /(宝宝|婴儿|小孩|孩子|女[儿婴]|儿[子童]|小香|小名|宝贝|幼[儿童])/;
    const placePattern = /(动物园|海洋馆|游乐园|公园|游乐场|亲子|一家[几口人])/;
    if (childPattern.test(text) && placePattern.test(text)) {
      return '家庭温情';
    }
    
    // 规则2: 医院 + 观察/纪实/一天（非急救场景）→ 社会现实
    if (/医院.*(一天|日常|观察|百态|纪实)/.test(text) || /(一天|日常|观察|百态|纪实).*医院/.test(text)) {
      return '社会现实';
    }
    
    // 规则3: 明确的食物/烹饪/餐厅相关 → 美食文化
    if (/(炒饭|烧烤|火锅|餐厅|厨师|料理|食材|美食|味道)/.test(text)) {
      return '美食文化';
    }
    
    return null; // 无高置信度上下文匹配
  }
}

// ============ 字段补全器 ============
class FieldCompleter {
  complete(fields, scene, input) {
    const result = { ...fields };
    
    // task_id
    if (!result.task_id) {
      result.task_id = this._generateTaskId(scene);
    }
    
    // 【v2.1.8-fix】type 规范化：如果 type 存在但不在标准库中，保留用户自定义类型
    if (result.type) {
      const normalized = this._normalizeTypeName(result.type);
      if (normalized) {
        // 能映射到标准类型（如用户写"科幻"→"硬科幻"）
        result.type = normalized;
      } else if (TYPE_LIBRARY[result.type]) {
        // 已经是标准类型，保留
        // noop
      } else {
        // 用户自定义类型，不在标准库中——保留！不重新推断
        // 标记为自定义类型，供下游参考
        result._customType = true;
      }
    }
    
    // type
    if (!result.type) {
      result.type = this._inferTypeWeighted(input);
    }
    
    // theme
    if (!result.theme) {
      result.theme = this._generateTheme(result.type, input);
    }
    
    // description
    if (!result.description) {
      result.description = this._generateDescription(result.type, result.theme, input);
    }
    
    // duration_sec
    if (!result.duration_sec) {
      result.duration_sec = this._deriveDuration(result.type, result.difficulty);
    }
    
    // creative_style（放宽到 null/空字符串都兜底）
    if (result.creative_style == null || result.creative_style === '') {
      result.creative_style = this._deriveCreativeStyle(result.type, result.difficulty, result.theme || input);
    }
    
    // tone
    if (!result.tone) {
      result.tone = this._inferTone(input) || this._defaultTone(result.type);
    }
    
    // dialogue_requirement
    if (!result.dialogue_requirement) {
      result.dialogue_requirement = this._generateDialogueRequirement(result.type);
    }
    
    // visual_style
    if (!result.visual_style) {
      result.visual_style = this._generateVisualStyle(result.type);
    }
    
    // special_notes
    if (!result.special_notes) {
      result.special_notes = this._generateSpecialNotes(result.type, result.pressureAnchors || []);
    }
    
    // target_audience
    if (!result.target_audience) {
      result.target_audience = TYPE_AUDIENCE[result.type] || '一般观众';
    }
    
    // difficulty
    if (!result.difficulty) {
      result.difficulty = this._deriveDifficulty(result.pressureAnchors || []);
    }
    
    return result;
  }
  
  _generateTaskId(scene) {
    const prefix = scene === 'C' ? 'R' : scene === 'D' ? 'N' : 'C';
    const seq = String(Math.floor(Math.random() * 900) + 100);
    return `${prefix}-${seq}`;
  }
  
  /**
   * 【v2.1.8-fix】类型名称规范化
   */
  _normalizeTypeName(typeName) {
    const typeMappings = {
      '音乐舞蹈·编舞同步': '音乐MV',
      '音乐MV': '音乐MV',
      '音乐': '音乐MV',
      '舞蹈': '音乐MV',
      '编舞': '音乐MV',
      '纪录片': '自然纪录片',
      '科幻': '硬科幻',
      '武侠': '武侠动作',
      '恐怖': '恐怖悬疑',
      '悬疑': '恐怖悬疑',
      '推理': '恐怖悬疑',
      '广告': '商业广告',
      '宣传片': '商业广告',
      '科普': '科普教育',
      '教育': '科普教育',
      '美食': '美食文化',
      '家庭': '家庭温情',
      '爱情': '浪漫爱情',
      '浪漫': '浪漫爱情',
      '喜剧': '喜剧荒诞',
      '搞笑': '喜剧荒诞',
      '历史': '历史战争',
      '战争': '历史战争',
      '运动': '运动竞技',
      '体育': '运动竞技',
      '文化': '文化遗产',
      '社会': '社会现实',
      '艺术': '艺术实验',
      '实验': '艺术实验'
    };
    
    const normalized = String(typeName).trim();
    return typeMappings[normalized] || null;
  }
  
  _inferType(input) {
    const text = String(input || '').toLowerCase();
    for (const [type, keywords] of Object.entries(TYPE_LIBRARY)) {
      if (keywords.some(k => text.includes(k.toLowerCase()))) {
        return type;
      }
    }
    return '艺术实验'; // 默认
  }
  
  /**
   * 加权类型推断（改进版，避免单一关键词误匹配）
   * 【v2.1.8-fix】P4修复：排除辅助词修饰和否定语境中的关键词
   * 【v2.1.8-fix-context】新增上下文推断优先机制
   */
  _inferTypeWeighted(input) {
    const text = String(input || '').toLowerCase();
    
    // 【v2.1.8-fix-context】高置信度上下文推断（优先于关键词匹配）
    const contextType = this._inferTypeByContext(text);
    if (contextType) {
      console.log(`[FieldCompleter] 🎯 上下文推断命中: ${contextType}`);
      return contextType;
    }
    
    const scores = {};
    
    // 预处理：标记否定语境
    const negationPattern = /(不要|不需要|不是|没有|不含|禁止|拒绝)[\s\w\u4e00-\u9fa5]{0,10}?(音乐|歌曲|舞蹈|节奏)/gi;
    const negatedRanges = [];
    let negMatch;
    while ((negMatch = negationPattern.exec(text)) !== null) {
      negatedRanges.push({ start: negMatch.index, end: negMatch.index + negMatch[0].length });
    }
    
    // 辅助词黑名单
    const auxiliaryPatterns = [
      /背景\s*音乐/gi,
      /配\s*乐/gi,
      /辅助\s*音乐/gi,
      /不要\s*.{0,5}音乐/gi,
      /不需要\s*.{0,5}音乐/gi,
      /煽情\s*音乐/gi
    ];
    
    // 【v2.1.8-fix-context】排除规则：特定组合不应匹配某类型
    const exclusionRules = [
      { pattern: /动物园/, excludeType: '自然纪录片', reason: '动物园是场所visit，不是自然纪录片' },
      { pattern: /宝宝|婴儿|小孩|女儿|儿子|孩子.*动物园|动物园.*孩子/, excludeType: '自然纪录片', reason: '亲子游动物园应归类家庭温情' },
      { pattern: /宝宝|婴儿|小孩|女儿|儿子|孩子.*医院|医院.*孩子/, excludeType: '医疗急救', reason: '儿童医院场景应归类家庭温情' }
    ];
    const excludedTypes = new Set();
    for (const rule of exclusionRules) {
      if (rule.pattern.test(text)) {
        excludedTypes.add(rule.excludeType);
      }
    }
    
    for (const [type, keywords] of Object.entries(TYPE_LIBRARY)) {
      // 跳过被排除的类型
      if (excludedTypes.has(type)) {
        continue;
      }
      
      let score = 0;
      for (const keyword of keywords) {
        const regex = new RegExp(keyword.toLowerCase(), 'gi');
        let matches;
        while ((matches = regex.exec(text)) !== null) {
          const matchStart = matches.index;
          const matchEnd = matchStart + matches[0].length;
          
          // 检查否定语境
          const isNegated = negatedRanges.some(r => 
            (matchStart >= r.start && matchStart <= r.end) ||
            (matchEnd >= r.start && matchEnd <= r.end)
          );
          if (isNegated) continue;
          
          // 检查辅助词
          const matchedText = text.substring(Math.max(0, matchStart - 5), Math.min(text.length, matchEnd + 5));
          const isAuxiliary = auxiliaryPatterns.some(p => p.test(matchedText));
          if (isAuxiliary) continue;
          
          score += matches[0].length * 2;
        }
      }
      if (score > 0) {
        scores[type] = score;
      }
    }
    
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
    if (sorted.length === 0) return null; // 【v2.1.8】分数为0，不fallback，让DynamicTypeResolver处理
    
    if (sorted.length === 1 || sorted[0][1] > sorted[1][1] * 1.5) {
      return sorted[0][0];
    }
    
    return null; // 【v2.1.8】分数接近，不fallback到艺术实验
  }
  
  /**
   * 【v2.1.8-fix-context】基于上下文的类型推断
   * 通过语义组合（而非关键词子串匹配）推断高置信度类型
   */
  _inferTypeByContext(text) {
    // 规则1: 宝宝/孩子 + 场所（动物园/公园/游乐园等）→ 家庭温情
    const childPattern = /(宝宝|婴儿|小孩|孩子|女[儿婴]|儿[子童]|小香|小名|宝贝|幼[儿童])/;
    const placePattern = /(动物园|海洋馆|游乐园|公园|游乐场|亲子|一家[几口人])/;
    if (childPattern.test(text) && placePattern.test(text)) {
      return '家庭温情';
    }
    
    // 规则2: 医院 + 观察/纪实/一天（非急救场景）→ 社会现实
    if (/医院.*(一天|日常|观察|百态|纪实)/.test(text) || /(一天|日常|观察|百态|纪实).*医院/.test(text)) {
      return '社会现实';
    }
    
    // 规则3: 明确的食物/烹饪/餐厅相关 → 美食文化
    if (/(炒饭|烧烤|火锅|餐厅|厨师|料理|食材|美食|味道)/.test(text)) {
      return '美食文化';
    }
    
    return null; // 无高置信度上下文匹配
  }

  _generateTheme(type, input) {
    // 【v2.1.15-fix 主题漂移】最优先：从用户输入提取核心主题
    // 原实现顺序颠倒（先随机池后提取），且窗口 <100 字符，108字符输入直接掉进随机池
    const inputText = String(input || '');
    if (inputText.length > 5 && inputText.length <= 150) {
      const coreTheme = this._extractCoreTheme(inputText);
      if (coreTheme && coreTheme.length >= 4) {
        console.log(`[FieldCompleter] 📝 从输入提取主题: "${coreTheme}"`);
        return coreTheme;
      }
    }

    // ⭐ v2.1.8: 其次使用动态类型配置的主题池
    if (this._currentTypeConfig && this._currentTypeConfig.themes) {
      const themes = this._currentTypeConfig.themes;
      return themes[Math.floor(Math.random() * themes.length)];
    }
    
    // 【v2.1.8-fix-context】当输入包含明确的主题信息时，直接用输入生成主题
    const text = String(input || '');
    if (text.length > 5 && text.length < 100) {
      // 提取核心主题短语：去除时间/地点介词，保留主谓宾核心
      const coreTheme = this._extractCoreTheme(text);
      if (coreTheme && coreTheme.length >= 4) {
        console.log(`[FieldCompleter] 📝 从输入提取主题: "${coreTheme}"`);
        return coreTheme;
      }
    }
    
    const themes = {
      '医疗急救': ['创伤中心黄金10分钟', '深夜急诊室', '手术台上的抉择'],
      '硬科幻': ['火星沙尘暴中的救援', '深空信号', '最后一艘方舟'],
      '赛博朋克': ['霓虹雨夜', '义体医生的黄昏', '数据幽灵'],
      '武侠动作': ['竹林对决', '雪夜单刀', '破庙中的秘籍'],
      '恐怖悬疑': ['阁楼里的录音带', '最后一班地铁', '镜子里的陌生人'],
      '自然纪录片': ['深海发光生物', '极地追踪', '雨林隐秘王国'],
      '美食文化': ['深夜食堂', '最后的祖传秘方', '街头米其林'],
      '商业广告': ['下一秒，改变一切', '唤醒感官', '超越期待'],
      '科普教育': ['DNA的双螺旋之舞', '黑洞边缘', '细胞内的城市'],
      '音乐MV': ['雨中的节奏', '霓虹梦', '最后一支舞'],
      '家庭温情': ['爸爸的便当', '回家的路', '老照片'],
      '浪漫爱情': ['便利店的暖光', '迟到的告白', '平行时空的相遇'],
      '喜剧荒诞': ['冰箱里的宇宙', '会说话的猫', '时间管理局'],
      '历史战争': ['烽火家书', '最后的骑兵', '战壕里的钢琴'],
      '艺术实验': ['光影迷宫', '时间的形状', '记忆的碎片'],
      '社会现实': ['城中村的星空', '快递员的地图', '凌晨四点的早餐铺'],
      '运动竞技': ['0.01秒的差距', '逆风翻盘', '最后一投'],
      '文化遗产': ['故宫的晨钟', '修复时光', '非遗新生'],
      '旅游推广': ['一城一故事', '行走的风景', '遇见南昌']
    };
    const typeThemes = themes[type] || ['未命名主题'];
    return typeThemes[Math.floor(Math.random() * typeThemes.length)];
  }
  
  /**
   * 【v2.1.8-fix-context】从用户输入中提取核心主题短语
   */
  _extractCoreTheme(text) {
    // 【v2.1.15-fix】策略升级：取第一个语义完整的子句作为主题（标点边界，不腰斩句子）
    // 例："滕王阁穿越记：60多岁奶奶抱着..." → "滕王阁穿越记"
    if (!text) return '';
    const cleaned = String(text).trim();

    // 优先取冒号前的标题式短语（"滕王阁穿越记：..." → "滕王阁穿越记"）
    const titleMatch = cleaned.match(/^([^：:，。！？；]{2,20})[：:]/);
    if (titleMatch) return titleMatch[1].trim();

    // 其次取第一个子句（逗号/句号/分号边界），≤30字
    const clause = cleaned.split(/[，。！？；]/)[0].trim();
    const candidate = clause.length <= 30 ? clause : clause.substring(0, 30);
    const result = candidate.replace(/[，。！？]/g, '').trim();

    // 太短（<4字）不构成主题，返回空让上层走配置池
    return result.length >= 4 ? result : '';
  }

  /**
   * 【v2.1.8-fix-context】从用户输入中提取核心主题短语（保留旧注释说明）
   */
  _generateDescription(type, theme, input) {
    // ⭐ v2.1.8: 优先使用动态类型配置的描述模板
    if (this._currentTypeConfig && this._currentTypeConfig.descriptionTemplate) {
      return this._currentTypeConfig.descriptionTemplate
        .replace(/{theme}/g, theme || '未知主题')
        .replace(/{type}/g, type || '未知类型');
    }
    
    // 【v2.1.7-fix】基于输入和类型生成核心描述，不再使用随机占位符
    const cleanInput = String(input || '').replace(/[，。！？]/g, ' ').trim();
    
    // 如果输入已包含具体场景/情节描述，直接提取作为核心描述
    if (cleanInput.length > 5) {
      // 提取核心动作/事件：过滤掉修饰词和数字时间
      const core = cleanInput
        .replace(/\b(制作|生成|一个|视频|短片|关于|的|了|在|和|与|以及|需要|想要|给我|帮我|请|一下|秒|分钟|分钟|30|60|90|15|10|5|20)\b/g, '')
        .trim();
      if (core.length > 3) {
        return `${core}主题叙事，融合视觉冲击力与情感深度，展现独特的世界观与角色张力`;
      }
    }
    
    // 回退：基于类型生成结构化描述
    const typeDesc = {
      '医疗急救': '围绕生死边缘的紧张抉择展开，展现医疗团队的专业与温度',
      '硬科幻': '在未知宇宙边界中探索人类命运，融合硬核科技想象与哲学追问',
      '武侠动作': '古典侠义精神与现代视觉语言交融，展现极致动作美学与江湖情义',
      '恐怖悬疑': '在心理恐惧与未知真相之间构建张力，层层剥茧直至核心反转',
      '自然纪录片': '捕捉自然世界的壮丽与脆弱，用镜头语言讲述生命共生故事',
      '浪漫爱情': '在情感流动中刻画人性柔软，用视觉诗意呈现爱的不同形态',
      '家庭温情': '在日常细节中发掘深层情感，以温暖视角审视家庭与归属',
      '喜剧荒诞': '以荒诞镜像折射现实，在笑声中包裹尖锐的社会观察',
      '历史战争': '重现史诗时刻中的人性抉择，用视觉宏大叙事承载历史重量',
      '艺术实验': '打破常规叙事边界，用视觉与声音实验探索感知新维度',
      '社会现实': '扎根真实生活切片，用克制而有力的镜头呈现时代切片',
      '运动竞技': '捕捉极限瞬间中的身体美学与意志力量，展现竞技精神',
      '文化遗产': '在现代语境中重新激活传统，让文化遗产获得当代视觉表达',
      '商业广告': '以精准视觉策略传递品牌价值，创造 memorable 的感官记忆',
      '科普教育': '将抽象知识转化为可感知的视觉体验，让认知过程充满美感',
      '音乐MV': '用视听通感放大音乐情绪，创造沉浸式的感官旅程'
    };
    return typeDesc[type] || '融合视觉冲击力与情感深度的原创叙事';
  }
  
  _deriveDuration(type, difficulty) {
    // ⭐ v2.1.8: 优先使用动态类型配置的时长范围
    if (this._currentTypeConfig && this._currentTypeConfig.typicalDuration) {
      const range = this._currentTypeConfig.typicalDuration;
      const base = Math.floor((range.min + range.max) / 2);
      if (difficulty === '极高') return Math.min(range.max, base + 10);
      if (difficulty === '高') return base;
      if (difficulty === '低') return Math.max(range.min, base - 10);
      return base;
    }
    
    const range = TYPE_DURATION_RANGES[type] || { min: 30, max: 60 };
    const base = Math.floor((range.min + range.max) / 2);
    if (difficulty === '极高') return Math.min(range.max, base + 10);
    if (difficulty === '高') return base;
    if (difficulty === '低') return Math.max(range.min, base - 10);
    return base;
  }
  
  _deriveCreativeStyle(type, difficulty, seedText = '') {
    const ranges = {
      '医疗急救': [0.35, 0.60], '硬科幻': [0.70, 0.98], '赛博朋克': [0.65, 0.90],
      '武侠动作': [0.55, 0.80], '恐怖悬疑': [0.50, 0.75], '自然纪录片': [0.55, 0.80],
      '美食文化': [0.45, 0.70], '商业广告': [0.40, 0.65], '科普教育': [0.45, 0.70],
      '音乐MV': [0.60, 0.85], '家庭温情': [0.40, 0.65], '浪漫爱情': [0.50, 0.75],
      '喜剧荒诞': [0.55, 0.80], '历史战争': [0.50, 0.75], '艺术实验': [0.75, 1.0],
      '社会现实': [0.40, 0.65], '运动竞技': [0.50, 0.75], '文化遗产': [0.45, 0.70]
    };
    const [min, max] = ranges[type] || [0.4, 0.8];
    // 【2026-07-17 修复】去随机化：同一 (类型+难度+主题) 永远得到同一指数
    // 原实现 Math.random() 导致每次运行指数漂移，不可复现、无法 A/B
    const seed = `${type}|${difficulty || ''}|${seedText}`;
    let hash = 0;
    for (let i = 0; i < seed.length; i++) {
      hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
    }
    const ratio = (Math.abs(hash) % 1000) / 1000; // 0-1 确定性落点
    let csc = min + ratio * (max - min);
    if (difficulty === '极高') csc = Math.min(1.0, csc + 0.1);
    if (difficulty === '中') csc = Math.max(0.2, csc - 0.05);
    return parseFloat(csc.toFixed(2));
  }
  
  _inferTone(input) {
    const text = String(input || '');
    for (const [tone, keywords] of Object.entries(TONE_LIBRARY)) {
      if (keywords.some(k => text.includes(k))) return tone;
    }
    return null;
  }
  
  _defaultTone(type) {
    // ⭐ v2.1.8: 优先使用动态类型配置的情绪基调
    if (this._currentTypeConfig && this._currentTypeConfig.toneOptions && this._currentTypeConfig.toneOptions.length > 0) {
      return this._currentTypeConfig.toneOptions[0];
    }
    
    const defaults = {
      '医疗急救': '紧张压抑', '硬科幻': '神秘敬畏', '赛博朋克': '冷酷精密',
      '武侠动作': '肃杀诗意', '恐怖悬疑': '心理恐惧', '自然纪录片': '神秘敬畏',
      '美食文化': '温暖治愈', '商业广告': '轻快明朗', '科普教育': '轻快明朗',
      '音乐MV': '热血感动', '家庭温情': '温暖治愈', '浪漫爱情': 'bittersweet',
      '喜剧荒诞': '黑色幽默', '历史战争': '史诗悲壮', '艺术实验': '诗意哀伤',
      '社会现实': '冷酷精密', '运动竞技': '热血感动', '文化遗产': '诗意哀伤'
    };
    return defaults[type] || '神秘敬畏';
  }
  
  _generateDialogueRequirement(type) {
    // ⭐ v2.1.8: 优先使用动态类型配置的台词模式
    if (this._currentTypeConfig && this._currentTypeConfig.dialoguePattern) {
      return this._currentTypeConfig.dialoguePattern;
    }
    
    const requirements = {
      '医疗急救': '不超过6句医疗指令，每句不超过12字，包含一句关键诊断结论',
      '硬科幻': '科学解释+情感对白交织，不超过5句',
      '武侠动作': '武侠风格对白，含一句标志性台词',
      '恐怖悬疑': '暗示性对白，避免直白解释',
      '商业广告': 'slogan+产品卖点，不超过3句',
      '音乐MV': '歌词片段或情绪哼唱，配合节奏',
      '家庭温情': '自然日常对话，含一句情感金句',
      '浪漫爱情': '含蓄告白或遗憾独白，含一句记忆点台词',
      '喜剧荒诞': '反转对白或荒诞台词，含一句笑点',
      '历史战争': '简短有力的命令或家书式独白',
      '自然纪录片': '旁白解说，不超过100字',
      '科普教育': '解释性旁白+关键术语，不超过4句'
    };
    return requirements[type] || '根据场景需要设计对白，不超过5句';
  }
  
  _generateVisualStyle(type) {
    // ⭐ v2.1.8: 优先使用动态类型配置的视觉特征
    if (this._currentTypeConfig) {
      const refs = this._currentTypeConfig.filmReferences || ['经典电影风格'];
      const ref = refs[Math.floor(Math.random() * refs.length)];
      const features = this._currentTypeConfig.visualFeatures || ['电影级质感', '专业摄影'];
      return `${ref}风格，${features.join('，')}`;
    }
    
    const refs = FILM_REFERENCES[type] || ['经典电影风格'];
    const ref = refs[Math.floor(Math.random() * refs.length)];
    const features = {
      '医疗急救': '冷白无影灯照明，手持摄影，仪器UI界面清晰',
      '硬科幻': '宏大尺度，科学精确，冷峻色调，IMAX质感',
      '赛博朋克': '霓虹光污染，雨夜反光，全息投影，未来都市',
      '武侠动作': '水墨意境，雨丝质感，慢动作美学，古典色调',
      '恐怖悬疑': '低光氛围，暗示性恐怖，声音设计，心理压迫',
      '自然纪录片': '微距细节，自然光，延时摄影，生态真实',
      '美食文化': '微距食物纹理，蒸汽，暖光，质感丰富',
      '商业广告': '极简构图，产品光效，留白，高级感',
      '科普教育': '科学可视化，动画解释，信息图层，清晰易懂'
    };
    return `${ref}风格，${features[type] || '电影级质感，专业摄影'}`;
  }
  
  _generateSpecialNotes(type, pressureAnchors) {
    const notes = [];
    
    // ⭐ v2.1.8: 优先使用动态类型配置的特殊说明
    if (this._currentTypeConfig && this._currentTypeConfig.specialNotes) {
      notes.push(this._currentTypeConfig.specialNotes);
    }
    
    // 根据类型生成至少3条
    const typeNotes = {
      '医疗急救': [
        '除颤器放电瞬间需展现电流从电极片扩散至胸腔的皮下透光效果',
        '心电监护仪波形需医学准确：室颤→平直→窦性心律的三阶段转变',
        '一镜到底：从走廊推车进入→推开手术室门→overhead无影灯亮起'
      ],
      '硬科幻': [
        '太空场景需展现零重力下物体漂浮的物理真实感',
        '星际航行场景需包含相对论时间膨胀的视觉暗示',
        '外星环境需设计独特的光照和大气散射效果'
      ],
      '武侠动作': [
        '武器碰撞需展现金属质感和火花粒子效果',
        '轻功场景需展现衣物飘动和气流扰动',
        '内功场景需设计能量流动的可视化表现'
      ],
      '恐怖悬疑': [
        '阴影区域需保留足够细节同时维持恐怖氛围',
        '镜面反射需设计渐进式恐怖 reveal',
        '声音设计需与视觉不同步制造不安感'
      ]
    };
    const defaultNotes = [
      '确保画面构图符合电影级标准，避免电视感',
      '光照需自然真实，避免过度后期感',
      '角色动作需流畅自然，避免机械感'
    ];
    const selected = typeNotes[type] || defaultNotes;
    return selected.slice(0, 3).map((n, i) => `①②③`[i] + n).join(' ');
  }
  
  _deriveDifficulty(pressureAnchors) {
    const count = pressureAnchors.length;
    if (count >= 3) return '极高';
    if (count === 2) return '高';
    if (count === 1) return '中';
    return '低';
  }
}

// ============ 压力锚点选择器 ============
class PressureAnchorSelector {
  select(type, input) {
    // 根据类型推荐相关PA
    const related = PRESSURE_ANCHORS.filter(pa => pa.types.includes(type));
    if (related.length === 0) {
      // 随机选1-2个
      return this._randomSelect(1, 2);
    }
    // 选1-3个不重复的
    const count = Math.min(3, Math.max(1, Math.floor(Math.random() * 3) + 1));
    const shuffled = this._shuffle([...related]);
    return shuffled.slice(0, count).map(pa => pa.id);
  }
  
  _randomSelect(min, max) {
    const count = Math.floor(Math.random() * (max - min + 1)) + min;
    const shuffled = this._shuffle([...PRESSURE_ANCHORS]);
    return shuffled.slice(0, count).map(pa => pa.id);
  }
  
  _shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
  }
}

// ============ 质量检查器 ============
class QualityChecker {
  check(task) {
    const checks = [];
    
    // 1. 画面感测试（放宽：用户自定义描述不需要包含镜头术语）
    checks.push({
      name: '画面感测试',
      pass: this._hasVisualImagery(task.description) || task._source === 'user_structured' || task.description.length > 20,
      message: '描述能否形成视觉画面'
    });
    
    // 2. 可执行性测试
    checks.push({
      name: '可执行性测试',
      pass: task.type && task.theme && task.duration_sec > 0,
      message: 'AI视频系统能否生成具体提示词'
    });
    
    // 3. 时长合理性（放宽：支持3分钟以内的家庭/纪实类视频）
    checks.push({
      name: '时长合理性',
      pass: task.duration_sec >= 15 && task.duration_sec <= 180,
      message: '时长是否在合理范围内（15秒-3分钟）'
    });
    
    // 4. 参考影片（放宽：用户自定义类型不一定需要影片参考）
    // 【v2.1.8-fix】对旅游推广等类型放宽要求
    const noFilmReferenceNeeded = ['旅游推广', '商业广告', '科普教育'];
    checks.push({
      name: '参考影片',
      pass: !task.visual_style || task.visual_style.includes('《') || task._source === 'user_structured' || noFilmReferenceNeeded.includes(task.type),
      message: '是否包含具体影片参考'
    });
    
    // 5. 特殊要求（放宽：用户自定义类型不一定需要编号列表）
    checks.push({
      name: '特殊要求',
      pass: !task.special_notes || task.special_notes.length > 10 || task.special_notes.includes('①'),
      message: '是否包含特殊要求说明'
    });
    
    const passed = checks.filter(c => c.pass).length;
    return {
      total: checks.length,
      passed,
      failed: checks.length - passed,
      checks,
      passed: passed === checks.length
    };
  }
  
  _hasVisualImagery(description) {
    const visualWords = ['镜头', '画面', '特写', '全景', '光影', '色彩', '构图', '景别', '推轨', '手持'];
    const count = visualWords.filter(w => description.includes(w)).length;
    return count >= 2;
  }
}

// ============ 主类：创意主题生成器 ============
class CreativeThemeGenerator {
  constructor(options = {}) {
    this.inputParser = new InputParser();
    this.fieldCompleter = new FieldCompleter();
    this.paSelector = new PressureAnchorSelector();
    this.qualityChecker = new QualityChecker();
    this.eventBus = options.eventBus || new EventBus();
    
    // ⭐ v2.2.1-hotfix: 保存 llmEngine 到主类（此前只注入 typeResolver，
    // 导致 needsLLM 判断恒 false，LLM 提取被静默跳过）
    this.llmEngine = options.llmEngine || null;
    
    // ⭐ v2.1.8: LLM 动态类型配置生成器
    this.typeResolver = new DynamicTypeResolver({
      llmEngine: options.llmEngine || null,
      cacheEnabled: true
    });
    this._currentTypeConfig = null; // 当前类型的动态配置缓存
  }
  
  /**
   * 主入口：生成创意主题
   * @param {string} input - 用户输入（任意格式）
   * @returns {Object} 包含tasks数组的结果
   */
  async generate(input) {
    console.log('[CreativeThemeGenerator] 开始解析用户输入...');
    // ⭐ v2.2.1-fix: 记录用户原始输入，确认单必须完整携带
    this._lastInput = typeof input === 'string' ? input : JSON.stringify(input, null, 2);
    
    // Step 1: 解析输入场景（含规范化）
    const parseResult = this.inputParser.parse(input);
    console.log(`[CreativeThemeGenerator] 识别场景: ${parseResult.scene}`);
    
    // Step 2: 提取已有字段（优先用户明确指定的，无论输入格式）
    const extractedFields = this._extractFields(parseResult);
    console.log(`[CreativeThemeGenerator] 用户已定义字段: ${Object.keys(extractedFields).filter(k => !['pressureAnchors', '_source'].includes(k)).join(', ')}`);
    
    // ⭐ v2.2.1-fix: 自由文本场景（A/D/E）且有 LLM 时，用 LLM 从原文提取 12 字段
    const needsLLM = ['A', 'D', 'E'].includes(parseResult.scene)
      && (!extractedFields.theme || !extractedFields.type);
    if (needsLLM && this.llmEngine) {
      try {
        const llmFields = await this._extractFieldsWithLLM(parseResult.input);
        for (const [k, v] of Object.entries(llmFields)) {
          if (extractedFields[k] === undefined && v !== undefined && v !== '') {
            extractedFields[k] = v;
          }
        }
        console.log(`[CreativeThemeGenerator] 🧠 LLM 字段提取完成: ${Object.keys(llmFields).join(', ')}`);
      } catch (e) {
        console.warn(`[CreativeThemeGenerator] ⚠️ LLM 字段提取失败: ${e.message}`);
        extractedFields._degraded = 'llm_extract_failed';
      }
    }

    // Step 3: 选择压力锚点
    let type = extractedFields.type || this.fieldCompleter._inferTypeWeighted(parseResult.input);
    
    // ⭐ v2.1.8: LLM 动态类型配置解析（TYPE_LIBRARY 未命中或推断为null时）
    if (!type || (!TYPE_LIBRARY[type] && !this.fieldCompleter._normalizeTypeName(type))) {
      // 【v2.1.15-fix 主题漂移】类型标签仅作缓存键与兜底名；
      // 完整用户输入通过 context.userInput 全量传给 LLM。
      // 原实现只把输入截断为20字符+context全空 → LLM只能自由发挥 → "故宫的晨钟"式漂移
      const typeNameForResolver = type || parseResult.input?.substring(0, 20).replace(/[，。！？]/g, '').trim() || '通用';
      console.log(`[CreativeThemeGenerator] 🧠 类型 "${typeNameForResolver}" 不在静态库中，调用 DynamicTypeResolver...`);
      try {
        this._currentTypeConfig = await this.typeResolver.resolve(typeNameForResolver, {
          theme: extractedFields.theme,
          description: extractedFields.description,
          tone: extractedFields.tone,
          userInput: parseResult.input || '', // ★ 完整输入全文（108字符不再丢失）
          scene: parseResult.scene
        });
        console.log(`[DynamicTypeResolver] ✅ 动态配置已加载: ${this._currentTypeConfig.typeName}`);
        // 使用 resolver 返回的类型名称
        type = this._currentTypeConfig.typeName || typeNameForResolver;
      } catch (e) {
        console.warn(`[CreativeThemeGenerator] ⚠️ 动态类型解析失败: ${e.message}`);
        this._currentTypeConfig = null;
        if (!type) type = '艺术实验'; // 终极fallback
      }
    } else {
      this._currentTypeConfig = null; // 静态库命中，不需要动态配置
    }
    
    const pressureAnchors = this.paSelector.select(type, parseResult.input);
    extractedFields.pressureAnchors = pressureAnchors;
    
    // ⭐ v2.1.8: 将动态解析的类型和配置注入到字段中
    if (type && !extractedFields.type) {
      extractedFields.type = type;
    }
    if (this._currentTypeConfig) {
      const cfg = this._currentTypeConfig;
      // 【v2.1.15-fix 主题漂移】theme 优先从用户完整输入提取（如"滕王阁穿越记"），
      // 其次采用动态配置的 themes[0]；原实现直接采用 LLM 自由发挥的主题池首项
      if (!extractedFields.theme) {
        const coreTheme = this.fieldCompleter._extractCoreTheme(parseResult.input);
        if (coreTheme) {
          extractedFields.theme = coreTheme;
          console.log(`[CreativeThemeGenerator] 📝 主题从用户输入提取: "${coreTheme}"`);
        } else if (cfg.themes) {
          extractedFields.theme = cfg.themes[0];
        }
      }
      if (!extractedFields.description && cfg.descriptionTemplate) extractedFields.description = cfg.descriptionTemplate.replace(/{theme}/g, cfg.themes?.[0] || '未知主题');
      if (!extractedFields.tone && cfg.toneOptions) extractedFields.tone = cfg.toneOptions[0];
      if (!extractedFields.visual_style && cfg.visualFeatures) extractedFields.visual_style = `${cfg.filmReferences?.[0] || '经典电影风格'}风格，${cfg.visualFeatures.join('，')}`;
      if (!extractedFields.dialogue_requirement && cfg.dialoguePattern) extractedFields.dialogue_requirement = cfg.dialoguePattern;
      if (!extractedFields.special_notes && cfg.specialNotes) extractedFields.special_notes = cfg.specialNotes;
      if (!extractedFields.target_audience && cfg.targetAudience) extractedFields.target_audience = cfg.targetAudience;
      extractedFields._customType = true;
      console.log(`[CreativeThemeGenerator] 💉 动态配置字段已注入: theme=${extractedFields.theme}, tone=${extractedFields.tone}`);
    }
    
    // Step 4: 补全所有字段（已有字段保留，只补缺失）
    const completedTask = this.fieldCompleter.complete(extractedFields, parseResult.scene, parseResult.input);
    
    // Step 5: 质量检查（放宽对用户自定义类型的约束）
    const quality = this.qualityChecker.check(completedTask);
    console.log(`[CreativeThemeGenerator] 质量检查: ${quality.passed}/${quality.total} 通过`);
    
    // Step 6: 组装输出
    const result = {
      meta: {
        version: '2.1.8-fix-context',
        generated_at: new Date().toISOString().split('T')[0],
        total_tasks: 1,
        batch_name: '用户定制生成',
        purpose: '基于用户输入的定向创意主题生成'
      },
      tasks: [completedTask],
      quality: quality
    };

    // 【方案A-fix】保留原始故事文本直通下游
    // 将用户完整输入附加到 result，供后续层（剧本/镜头/PromptFusion）直接消费
    result._originalStoryText = parseResult.input || '';
    if (result._originalStoryText) {
      console.log(`[CreativeThemeGenerator] 📖 原始故事文本已保留，长度: ${result._originalStoryText.length}字符`);
    }
    
    // 发布事件
    this.eventBus.emit('creative-theme:generated', {
      taskId: completedTask.task_id,
      type: completedTask.type,
      theme: completedTask.theme
    });
    
    return result;
  }
  
  /**
   * ⭐ v2.2.1-fix: LLM 字段提取（自由文本场景）
   */
  async _extractFieldsWithLLM(text) {
    const prompt = `你是一位拿过国际短片节奖项的选题策划，正在为 AI 视频生成系统把用户的自由表达提炼成 12 个标准字段。只输出严格 JSON，不要 markdown，不要解释。

【提炼心法】
1. theme（≤10字）是"提炼"不是"摘抄"：找到故事里那组最有张力的矛盾（人vs时间/小人物vs大仪式/柔软vs坚硬），用一个有画面的短语命名它。坏例子：'C_007_成都川剧变脸'；好例子：'绳结守护祇园祭'、'最后一场雪说'。
2. description（≤80字）必须包含：主角（一个具体的人）+ 困境（一个具体的坎）+ 动作（他做了什么）+ 余味（一句情绪钩子），四要素缺一重写。
3. type 选择要服务于传播而非分类正确：同一故事，选那个"全球观众不看字幕也想点进来"的类型。
4. tone（4-8字）用情绪对撞词，不用单义词。好例子：'沉静庄重、克制深情'；坏例子：'感人'。
5. visual_style 必须点名可参考的影片/导演美学+光线策略，禁止'唯美''震撼'这类无效词。
6. dialogue_requirement 如果原文给了台词（'台词：xxx'），必须原样保留这句钉子台词，一字不改。
7. special_notes 提取原文中所有'特写：'与物理细节（老年斑/旧茧/无钉子等），这些是全片的视觉锚点，一条都不许丢。

字段 schema 与规则（duration/creative_style 取值等）维持原要求不变。
用户输入：
${text}`;
    let content = '';
    if (typeof this.llmEngine.generate === 'function') {
      const r = await this.llmEngine.generate(prompt, { maxTokens: 2000, temperature: 1 });
      content = r.content || '';
    } else if (typeof this.llmEngine.reason === 'function') {
      const r = await this.llmEngine.reason(prompt, { maxTokens: 2000, temperature: 1 });
      content = r.content || '';
    } else if (typeof this.llmEngine.chat === 'function') {
      const r = await this.llmEngine.chat('你是严格输出 JSON 的结构化提取器。', prompt, 1);
      content = r.content || r.data || '';
    } else {
      throw new Error('LLM 引擎无可用调用方法');
    }
    const m = content.match(/\{[\s\S]*\}/);
    if (!m) throw new Error('LLM 输出中未找到 JSON');
    const parsed = JSON.parse(m[0]);
    if (parsed.duration_sec) parsed.duration_sec = parseInt(parsed.duration_sec, 10) || 60;
    if (parsed.creative_style) parsed.creative_style = Math.min(0.95, Math.max(0.3, parseFloat(parsed.creative_style) || 0.6));
    return parsed;
  }

  /**
   * 从解析结果中提取字段
   */
  _extractFields(parseResult) {
    const fields = {};
    
    // 优先使用原始输入中的明确字段（如 JSON 中的 type、theme 等）
    if (parseResult.sourceFields) {
      Object.assign(fields, parseResult.sourceFields);
    }
    
    // 如果原始数据包含更多字段（如 _originalData），也提取
    if (parseResult._originalData && typeof parseResult._originalData === 'object') {
      for (const [key, value] of Object.entries(parseResult._originalData)) {
        if (fields[key] === undefined && value !== undefined && value !== '') {
          fields[key] = value;
        }
      }
    }
    
    // 然后叠加 partialFields
    if (parseResult.partialFields) {
      for (const pf of parseResult.partialFields) {
        // 如果 sourceFields 中已有该字段，优先保留（用户明确指定的）
        if (fields[pf.field] === undefined) {
          fields[pf.field] = pf.value;
        }
      }
    }
    
    // 标记来源：如果用户提供了明确的结构化字段，标记为 user_structured
    if (parseResult.sourceFields && Object.keys(parseResult.sourceFields).length >= 3) {
      fields._source = 'user_structured';
    }
    
    return fields;
  }
  
  /**
   * 生成用户确认用的摘要文本
   * 【v2.1.9-fix】补全遗漏的 special_notes 字段，确保12字段完整显示
   */
  /**
   * 生成用户确认用的摘要文本
   * 【v2.1.9-fix】补全遗漏的 special_notes 字段，确保12字段完整显示
   * 【v2.1.15-fix 确认单截断】长文本智能换行显示完整内容，不再硬截断36字符
   *   原实现 description/visual_style 等只显示前36字符，用户无法审阅完整内容
   */
  generateConfirmationSummary(result) {
    const task = result.tasks[0];
    // 盒内可用宽度 40 字符（中文按 2 宽度计）
    const wrap = (text) => this._wrapBoxLines(String(text ?? ''), 38);
    const box = (label, text) => {
      const lines = wrap(text);
      return lines.map(l => `║ ${l}║`).join('\n');
    };
    
    // 【方案A-fix】原始故事文本加入确认单，让用户审阅完整内容
    const originalStory = result._originalStoryText || '';
    const storyBox = originalStory ? `
╠══════════════════════════════════════════╣
║ 📖 原始故事文本（完整版）:               ║
${box('📖', originalStory)}
` : '';

    return `
╔══════════════════════════════════════════╗
║      🎬 创意主题生成确认单               ║
╠══════════════════════════════════════════╣
║ 类型: ${String(task.type).padEnd(30)}║
║ 主题: ${String(task.theme).padEnd(30)}║
║ 时长: ${String(task.duration_sec + '秒').padEnd(30)}║
║ 难度: ${String(task.difficulty).padEnd(30)}║
║ 创意系数: ${String(task.creative_style).padEnd(26)}║
║ 情绪基调: ${String(task.tone).padEnd(28)}║
╠══════════════════════════════════════════╣
║ 📋 核心描述:                             ║
${box('📋', task.description)}
╠══════════════════════════════════════════╣
║ 🎨 视觉风格:                             ║
${box('🎨', task.visual_style)}
╠══════════════════════════════════════════╣
║ 💬 台词要求:                             ║
${box('💬', task.dialogue_requirement)}
╠══════════════════════════════════════════╣
║ 📝 特别备注:                             ║
${box('📝', task.special_notes || '无')}
╠══════════════════════════════════════════╣
║ 🎯 目标受众:                             ║
${box('🎯', task.target_audience)}${storyBox}
╚══════════════════════════════════════════╝

请确认以上创意主题是否符合您的预期：
• 回复 "确认" 或 "OK" → 进入视频生成链路
• 回复 "调整:字段=值" → 修改指定字段
• 回复 "重新生成" → 基于相同输入重新生成
• 回复具体修改意见 → 我将据此调整
`;
  }

  /**
   * 【v2.1.15-fix】文本按显示宽度换行（中文按2宽度计），并右补齐到盒宽
   * @param {string} text - 原始文本
   * @param {number} width - 每行显示宽度
   * @returns {string[]} 补齐后的行数组
   */
  _wrapBoxLines(text, width) {
    const lines = [];
    let current = '';
    let currentWidth = 0;

    for (const ch of text) {
      // 换行符直接断行
      if (ch === '\n') {
        lines.push(current);
        current = '';
        currentWidth = 0;
        continue;
      }
      const w = ch.charCodeAt(0) > 255 ? 2 : 1; // 中文/全角按2宽度
      if (currentWidth + w > width) {
        lines.push(current);
        current = ch;
        currentWidth = w;
      } else {
        current += ch;
        currentWidth += w;
      }
    }
    if (current) lines.push(current);
    if (lines.length === 0) lines.push('');

    // 右补齐到统一盒宽
    return lines.map(l => {
      let lw = 0;
      for (const ch of l) lw += ch.charCodeAt(0) > 255 ? 2 : 1;
      return l + ' '.repeat(Math.max(0, width + 2 - lw));
    });
  }

  /**
   * 根据用户反馈调整任务
   */
  adjustTask(result, adjustments) {
    const task = { ...result.tasks[0] };
    
    for (const [field, value] of Object.entries(adjustments)) {
      if (task[field] !== undefined) {
        task[field] = value;
        console.log(`[CreativeThemeGenerator] 调整字段: ${field} = ${value}`);
      }
    }
    
    // 重新检查
    const quality = this.qualityChecker.check(task);
    
    return {
      ...result,
      tasks: [task],
      quality,
      adjusted: true
    };
  }
}

module.exports = { CreativeThemeGenerator };