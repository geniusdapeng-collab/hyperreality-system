/**
 * 【角色年代服装指南】Character Era Guide v2.0
 * 
 * 年代服装速查表（1920s-2020s）：
 * - 每个年代的核心服装特征
 * - 配饰/发型/妆容特点
 * - 配色方案
 * - Prompt片段模板
 * 
 * 职责：
 * - 为历史/年代剧角色提供服装参考
 * - 生成年代-specific的prompt片段
 * - 避免年代混搭错误
 */

class CharacterEraGuide {
  constructor() {
    // 年代数据库
    this.ERA_DATABASE = {
      '1920s': {
        name: '1920年代（爵士时代）',
        period: '1920-1929',
        fashion: {
          women: {
            clothing: ['低腰直筒连衣裙（Flapper Dress）', '珠片装饰', '流苏裙摆', '膝上裙长'],
            accessories: ['长珍珠项链（多层）', '羽毛头带', '长手套', '手拿包', '烟嘴'],
            hairstyle: ['波波头（Bob Cut）', ' Marcel波浪', '短发配发带'],
            makeup: ['烟熏眼妆', '深红唇（深酒红/浆果色）', '弯月眉']
          },
          men: {
            clothing: ['宽松西装（Oversized）', '灯笼裤（Plus-fours）', '马甲背心', '牛津鞋'],
            accessories: ['宽檐软呢帽', '领带夹', '怀表', '手杖'],
            hairstyle: [' slicked-back 油头', '侧分'],
            makeup: [] // 男性通常不描述妆容
          }
        },
        colors: ['黑色', '金色', '深红', '翡翠绿', '香槟色'],
        materials: ['丝绸', '珠片', '流苏', '天鹅绒'],
        keywords: ['Flapper', 'Art Deco', '爵士时代', '装饰艺术'],
        promptTemplate: '{gender}穿着1920年代风格{clothing}，{accessories}，{hairstyle}，{makeup}，Art Deco装饰艺术风格背景'
      },
      
      '1930s': {
        name: '1930年代（好莱坞黄金时代）',
        period: '1930-1939',
        fashion: {
          women: {
            clothing: ['贴身高腰长裙', '鱼尾裙摆', '垫肩设计', '斜裁法（Bias Cut）'],
            accessories: ['宽檐帽', '长手套', '珍珠项链', '皮草披肩', '手拿包'],
            hairstyle: ['手指波浪卷', '侧分长发', '高发髻'],
            makeup: ['细弯眉', '红唇', '自然眼妆']
          },
          men: {
            clothing: ['双排扣西装', '宽肩设计', '高腰西裤', '吊带裤'],
            accessories: ['软呢帽（Fedora）', '领带', '口袋巾', '腕表'],
            hairstyle: ['整齐短发', '侧分油头'],
            makeup: []
          }
        },
        colors: ['海军蓝', '酒红', '翡翠绿', '象牙白', '香槟金'],
        materials: ['丝绸', '雪纺', '皮草', '羊毛'],
        keywords: ['好莱坞', '黄金时代', '优雅', '复古奢华'],
        promptTemplate: '{gender}身着1930年代好莱坞黄金时代{clothing}，{accessories}，{hairstyle}，{makeup}，优雅奢华的氛围'
      },
      
      '1940s': {
        name: '1940年代（战时/战时风尚）',
        period: '1940-1949',
        fashion: {
          women: {
            clothing: ['方肩西装外套（Power Shoulder）', '铅笔裙', '衬衫式连衣裙', '高腰A字裙'],
            accessories: ['头巾（Victory Roll配头巾）', '长袜', '皮质手套', '军用风格背包'],
            hairstyle: ['Victory Rolls', '胜利卷', '盘发', '网纱发饰'],
            makeup: ['红唇（ patriotic red）', '浓眉', '自然底妆']
          },
          men: {
            clothing: ['军装风格夹克', '直筒裤', '工装衬衫', '双排扣大衣'],
            accessories: ['军帽', '皮带', '军靴', '帆布包'],
            hairstyle: ['短发', '平头', 'Undercut'],
            makeup: []
          }
        },
        colors: ['军绿', '卡其', '海军蓝', '砖红', '土黄'],
        materials: ['棉布', '羊毛', '粗呢', '人造丝'],
        keywords: ['战时', '实用主义', '军装风', 'Victory Rolls'],
        promptTemplate: '{gender}身着1940年代{clothing}，{accessories}，{hairstyle}，{makeup}，战时实用主义风格'
      },
      
      '1950s': {
        name: '1950年代（战后繁荣）',
        period: '1950-1959',
        fashion: {
          women: {
            clothing: ['大摆伞裙（Full Circle Skirt）', '束腰设计', '衬裙撑起', '印花连衣裙', '紧身毛衣'],
            accessories: ['猫眼镜（Cat-eye Glasses）', '珍珠项链', '手套', '手提包', '丝巾'],
            hairstyle: ['蓬松卷发', '高刘海（Bouffant）', '马尾辫', '发卷造型'],
            makeup: ['猫眼眼线', '红唇', '自然腮红', '弯月眉']
          },
          men: {
            clothing: ['修身西装', '窄腿裤', '休闲夹克', '夏威夷衬衫', 'T恤+牛仔裤'],
            accessories: ['鸭舌帽', '皮带', '墨镜', '皮鞋'],
            hairstyle: [' Elvis式蓬松油头', '平头', '侧分'],
            makeup: []
          }
        },
        colors: ['粉红', '薄荷绿', '婴儿蓝', '柠檬黄', '珊瑚红'],
        materials: ['棉布', '薄纱', '蕾丝', '丹宁'],
        keywords: ['复古甜美', 'Rockabilly', '战后繁荣', '优雅主妇'],
        promptTemplate: '{gender}穿着1950年代风格{clothing}，{accessories}，{hairstyle}，{makeup}，复古甜美氛围'
      },
      
      '1960s': {
        name: '1960年代（ mod 革命）',
        period: '1960-1969',
        fashion: {
          women: {
            clothing: ['迷你裙（Mini Skirt）', 'A字裙', '高领毛衣', '阔腿裤', '波西米亚长裙'],
            accessories: ['大圈耳环', '长项链', '头巾', '大号墨镜', '塑料手镯'],
            hairstyle: ['蜂窝头（Beehive）', '齐刘海短发', '直长发中分', ' Afro'],
            makeup: ['浓黑眼线', '假睫毛', '裸唇/浅色唇', '大面积腮红']
          },
          men: {
            clothing: ['修身西装', '窄领带', '高领毛衣', '军绿色夹克', '喇叭裤'],
            accessories: ['墨镜', '窄领带', '皮带', '皮靴'],
            hairstyle: ['披头士式蘑菇头', '长发', '油头'],
            makeup: []
          }
        },
        colors: ['亮橙', '电光蓝', '荧光绿', '黑白几何', '迷幻紫'],
        materials: ['PVC塑料', '霓虹面料', '人造革', '丹宁'],
        keywords: ['Mod', '迷你裙', '迷幻', '太空时代', '波普'],
        promptTemplate: '{gender}身着1960年代Mod风格{clothing}，{accessories}，{hairstyle}，{makeup}，迷幻波普氛围'
      },
      
      '1970s': {
        name: '1970年代（嬉皮/迪斯科）',
        period: '1970-1979',
        fashion: {
          women: {
            clothing: ['喇叭裤（Flared Pants）', '连体裤', ' wrap dress', '流苏背心', '扎染T恤', '热裤'],
            accessories: ['大圆框墨镜', '厚底鞋', '多层项链', '大手镯', '头带'],
            hairstyle: [' Farrah Fawcett feathered hair', ' Afro', ' dreadlocks', '直发中分'],
            makeup: ['古铜色肌肤', '蓝色眼影', '裸唇', '浓眉']
          },
          men: {
            clothing: ['喇叭牛仔裤', '花衬衫', '皮夹克', '连体工装', '运动套装'],
            accessories: ['金链', '宽腰带', '飞行员墨镜', '帆布鞋'],
            hairstyle: ['长发', ' Afro', '侧分长发', ' mustache'],
            makeup: []
          }
        },
        colors: ['土黄', '橄榄绿', '铁锈红', '棕橙', '深蓝', '金色'],
        materials: ['灯芯绒', '丹宁', '皮革', '针织', '扎染布'],
        keywords: ['嬉皮', '迪斯科', '复古', '自然风', '放纵'],
        promptTemplate: '{gender}身着1970年代{clothing}，{accessories}，{hairstyle}，{makeup}，复古嬉皮氛围'
      },
      
      '1980s': {
        name: '1980年代（权力着装/新 wave）',
        period: '1980-1989',
        fashion: {
          women: {
            clothing: ['权力套装（Power Suit，大垫肩）', '亮片连衣裙', ' Leggings', ' oversized 卫衣', '牛仔外套'],
            accessories: ['大耳环', '多层项链', '发带', '夸张的胸针', '宽腰带'],
            hairstyle: ['大波浪卷发', '蓬松高刘海', ' perm 卷发', '短发刺猬头'],
            makeup: ['鲜艳蓝/紫色眼影', '大红唇', '夸张腮红', '粗眉']
          },
          men: {
            clothing: ['大垫肩西装', '运动套装（Tracksuit）', '皮夹克', '牛仔裤', ' Polo 衫'],
            accessories: ['金链', '大表盘腕表', '飞行员墨镜', '皮带'],
            hairstyle: [' mullet（鲻鱼头）', '大背头', ' flat-top'],
            makeup: []
          }
        },
        colors: ['亮粉', '电光蓝', '荧光黄', '黑色', '金属银'],
        materials: ['氨纶', '亮片', '皮革', '合成纤维', '牛仔'],
        keywords: ['Power Suit', '新 wave', '夸张', '霓虹', ' MTV风格'],
        promptTemplate: '{gender}身着1980年代{clothing}，{accessories}，{hairstyle}，{makeup}，夸张霓虹风格'
      },
      
      '1990s': {
        name: '1990年代（极简/垃圾摇滚）',
        period: '1990-1999',
        fashion: {
          women: {
            clothing: [' slip dress（吊带裙）', '格子衬衫', '高腰牛仔裤', 'crop top', ' oversized 西装', '运动裤'],
            accessories: [' choker 项链', '小圆框墨镜', '迷你背包', '厚底鞋', '发夹'],
            hairstyle: [' The Rachel（分层中长发）', '丸子头', '脏辫', '短发'],
            makeup: ['裸妆', '棕色唇线', '细眉', '自然底妆']
          },
          men: {
            clothing: ['宽松牛仔裤', '格子衬衫', '条纹T恤', ' bomber jacket', '工装裤'],
            accessories: ['棒球帽', '颈链', '帆布腰带', '运动鞋'],
            hairstyle: ['中长发', ' undercut', ' bowl cut', ' dreadlocks'],
            makeup: []
          }
        },
        colors: ['黑色', '深红', '军绿', '牛仔蓝', '棕色', '暗紫'],
        materials: ['丹宁', '法兰绒', '棉', '皮革', '灯芯绒'],
        keywords: ['Grunge', '极简', '街头', '嘻哈', '复古运动'],
        promptTemplate: '{gender}身着1990年代{clothing}，{accessories}，{hairstyle}，{makeup}，极简街头风格'
      },
      
      '2000s': {
        name: '2000年代（Y2K/千禧风）',
        period: '2000-2009',
        fashion: {
          women: {
            clothing: ['低腰牛仔裤', ' crop top', ' tracksuit 运动套装', '百褶迷你裙', '吊带背心', '喇叭裤'],
            accessories: ['蝴蝶发夹', ' choker', '小圆框墨镜', '腰包', '厚底凉鞋'],
            hairstyle: ['挑染', '玉米辫', '高马尾', '碎发刘海', '直发'],
            makeup: ['银色眼影', '唇彩', '细眉', '晒黑妆']
          },
          men: {
            clothing: ['宽松T恤', '工装短裤', '运动外套', '连帽卫衣', '滑板鞋'],
            accessories: ['棒球帽反戴', '大耳机', '手环', '链坠'],
            hairstyle: ['刺猬头', '短发', ' bleached tips（发尾漂白）'],
            makeup: []
          }
        },
        colors: ['银色', '粉色', '蓝色', '白色', '荧光色'],
        materials: ['聚酯纤维', '丹宁', '网纱', '亮面材质'],
        keywords: ['Y2K', '千禧风', '科技感', '运动休闲', '闪亮'],
        promptTemplate: '{gender}身着2000年代Y2K风格{clothing}，{accessories}，{hairstyle}，{makeup}，千禧科技感'
      },
      
      '2010s': {
        name: '2010年代（快时尚/Normcore）',
        period: '2010-2019',
        fashion: {
          women: {
            clothing: [' skinny jeans（紧身牛仔裤）', ' oversized 毛衣', '运动鞋', ' bomber jacket', '连衣裙+牛仔外套'],
            accessories: ['极简项链', '手表', '帆布包', '猫眼墨镜', '发带'],
            hairstyle: [' ombre（渐变发色）', ' lob（长波波头）', '丸子头', '自然卷发'],
            makeup: ['韩式一字眉', '咬唇妆', '裸妆', '高光修容']
          },
          men: {
            clothing: [' slim fit 西装', '休闲裤', '连帽卫衣', '白T恤', '飞行员夹克'],
            accessories: ['简约手表', '帆布腰带', '背包', '墨镜'],
            hairstyle: [' undercut', '侧分', '短发', ' man bun'],
            makeup: []
          }
        },
        colors: ['裸色', '灰色', '白色', '黑色', '淡粉', '淡蓝'],
        materials: ['棉', '混纺', '丹宁', '针织', '皮革'],
        keywords: ['Normcore', '极简', '快时尚', '运动休闲', '韩式'],
        promptTemplate: '{gender}身着2010年代{clothing}，{accessories}，{hairstyle}，{makeup}，简约现代风格'
      },
      
      '2020s': {
        name: '2020年代（复古回潮/可持续）',
        period: '2020-2029',
        fashion: {
          women: {
            clothing: ['复古喇叭裤回潮', ' oversize 西装', '运动 leggings', ' vintage T恤', '环保面料服装'],
            accessories: ['口罩（时尚款）', '无线耳机', '复古发箍', ' minimal  jewelry', '帆布 tote bag'],
            hairstyle: [' curtain bangs（窗帘刘海）', ' shag（碎发层次）', '自然卷', '挑染', '低马尾'],
            makeup: ['玻璃唇', '野生眉', '轻欧美妆', '无粉底妆容']
          },
          men: {
            clothing: ['宽松剪裁西装', '工装风', ' oversize T恤', '复古运动鞋', '机能风'],
            accessories: ['无线耳机', ' minimal 配饰', '棒球帽', '帆布包'],
            hairstyle: ['纹理烫', '短发', '中长发', ' undercut'],
            makeup: []
          }
        },
        colors: ['大地色', '橄榄绿', '奶油色', '淡紫', '珊瑚'],
        materials: ['有机棉', '再生面料', '亚麻', '牛仔', '针织'],
        keywords: ['复古回潮', '可持续', '舒适', '无性别', '怀旧'],
        promptTemplate: '{gender}身着2020年代{clothing}，{accessories}，{hairstyle}，{makeup}，现代复古风格'
      }
    };
  }
  
  /**
   * 获取年代信息
   */
  getEra(eraId) {
    return this.ERA_DATABASE[eraId] || null;
  }
  
  /**
   * 列出所有年代
   */
  listEras() {
    return Object.keys(this.ERA_DATABASE).map(id => ({
      id,
      name: this.ERA_DATABASE[id].name,
      period: this.ERA_DATABASE[id].period
    }));
  }
  
  /**
   * 生成角色服装prompt片段
   */
  generateClothingPrompt(eraId, gender = 'female', options = {}) {
    const era = this.getEra(eraId);
    if (!era) return { error: `未知年代: ${eraId}` };
    
    const genderKey = gender === 'female' ? 'women' : (gender === 'male' ? 'men' : gender);
    const genderData = era.fashion[genderKey];
    if (!genderData) return { error: `未知性别: ${gender} (可用: female/male)` };
    
    const {
      selectedClothing = genderData.clothing.slice(0, 2),
      selectedAccessories = genderData.accessories.slice(0, 2),
      includeMakeup = true,
      includeHair = true
    } = options;
    
    const parts = {
      clothing: selectedClothing.join('、'),
      accessories: selectedAccessories.join('、'),
      hairstyle: includeHair ? genderData.hairstyle[0] : '',
      makeup: includeMakeup && genderData.makeup.length > 0 ? genderData.makeup[0] : ''
    };
    
    // 使用模板生成
    let prompt = era.promptTemplate;
    prompt = prompt.replace('{gender}', gender === 'female' ? '女性' : '男性');
    prompt = prompt.replace('{clothing}', parts.clothing);
    prompt = prompt.replace('{accessories}', parts.accessories ? `佩戴${parts.accessories}` : '');
    prompt = prompt.replace('{hairstyle}', parts.hairstyle ? `${parts.hairstyle}发型` : '');
    prompt = prompt.replace('{makeup}', parts.makeup ? `${parts.makeup}妆容` : '');
    
    // 清理空占位符
    prompt = prompt.replace(/，?\s*，/g, '，').replace(/，+/g, '，').replace(/^，|，$/g, '');
    
    return {
      eraId,
      eraName: era.name,
      gender,
      prompt,
      details: parts,
      colors: era.colors,
      materials: era.materials,
      keywords: era.keywords
    };
  }
  
  /**
   * 验证年代混搭是否合规
   */
  validateMix(eraId1, eraId2, tolerance = 'strict') {
    const era1 = this.getEra(eraId1);
    const era2 = this.getEra(eraId2);
    
    if (!era1 || !era2) return { valid: false, error: '未知年代' };
    
    // 计算年代差距
    const year1 = parseInt(era1.period.split('-')[0]);
    const year2 = parseInt(era2.period.split('-')[0]);
    const gap = Math.abs(year1 - year2);
    
    const rules = {
      strict: { maxGap: 10, message: '年代差距超过10年不可混搭' },
      moderate: { maxGap: 20, message: '年代差距超过20年不建议混搭' },
      loose: { maxGap: 30, message: '年代差距超过30年需谨慎混搭' }
    };
    
    const rule = rules[tolerance] || rules.strict;
    const valid = gap <= rule.maxGap;
    
    return {
      valid,
      gap,
      era1: era1.name,
      era2: era2.name,
      message: valid ? '年代混搭合规' : rule.message,
      risk: valid ? 'low' : (gap > rule.maxGap + 10 ? 'high' : 'medium')
    };
  }
  
  /**
   * 搜索年代（按关键词）
   */
  search(query) {
    const results = [];
    for (const [id, era] of Object.entries(this.ERA_DATABASE)) {
      const searchable = [
        era.name,
        ...era.keywords,
        ...era.colors,
        ...era.materials
      ].join(' ');
      
      if (searchable.toLowerCase().includes(query.toLowerCase())) {
        results.push({ id, name: era.name, period: era.period, keywords: era.keywords });
      }
    }
    return results;
  }
  
  /**
   * 获取颜色方案
   */
  getColorPalette(eraId) {
    const era = this.getEra(eraId);
    return era ? { primary: era.colors.slice(0, 3), accent: era.colors.slice(3), all: era.colors } : null;
  }
  
  /**
   * 获取材质建议
   */
  getMaterialSuggestions(eraId) {
    const era = this.getEra(eraId);
    return era ? { primary: era.materials.slice(0, 2), all: era.materials } : null;
  }
}

module.exports = { CharacterEraGuide };
