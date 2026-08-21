/**
 * 通用片头系统 v1.1 (v6.6.1)
 *
 * v6.6.1-fix: 标题营销化设计
 * - 主标题:智能压缩 + 营销化增强,拒绝直接塞入长字段
 * - 副标题:长度限制15字,过长时智能生成,像广告语一样精炼
 * - 新增 _enhanceTitleForMarketing: 标题吸引力优化
 * - 新增 _generateSmartSubTitle: 智能副标题推断
 *
 * 系统级设计:提取通用三幕结构,支持任意类型视频片头
 * - 非Nirath专属,支持健康科普、纪录片、广告等所有generic模式
 *
 * 三幕结构:
 * 1. 钩子(0-25%): 吸引注意力的开场画面/动作
 * 2. 展开(25-75%): 主题信息展示(标题/角色/场景)
 * 3. 定格(75-100%): 片头收尾,过渡到正片
 *
 * 可配置元素:
 * - 主标题、副标题、出品人/机构
 * - 角色展示(可选)
 * - 场景氛围(根据world配置)
 * - 时长:3-15秒(可配置)
 */

const path = require('path');

class GenericOpeningSystem {
  constructor(options = {}) {
    this.duration = options.duration || 9; // 默认9秒(匹配验证器要求)
    this.mode = options.mode || 'generic';
  }

  /**
   * 生成通用片头
   * @param {Object} input - 项目输入
   * @param {Object} storyboard - 故事板数据
   * @param {Object} characters - 角色数据
   * @returns {Object} 片头结果
   */
  generateOpening(input, storyboard, characters) {
    // v6.6.4-fix: 尊重 hasOpening 配置，false 时不生成片头
    if (input.hasOpening === false || input.opening?.enabled === false || input.noOpening === true) {
      return null;
    }

    const world = input.world || {};
    const meta = input.projectName || '未命名项目';
    const mainTitle = this._extractMainTitle(input);
    const subTitle = this._extractSubTitle(input);
    const creator = input.creator || input.world?.creator || '';

    // 三幕结构构建
    const hook = this._buildHook(world, characters);
    const reveal = this._buildReveal(mainTitle, subTitle, creator, world);
    const freeze = this._buildFreeze(world);

    // 合并为完整prompt(按1500字符预算优化)
    const prompt = this._assemblePrompt(hook, reveal, freeze, world, characters);

    return {
      id: 'S00',
      shotId: 'S00',
      type: 'opening',
      isOpening: true,
      duration: this.duration,
      prompt: prompt,
      length: prompt.length,
      utilization: Math.min(100, Math.round(prompt.length / 1500 * 100)),
      utilizationStatus: prompt.length >= 1400 ? 'ideal' : (prompt.length >= 1000 ? 'good' : 'insufficient'),
      title: {
        main: mainTitle,
        sub: subTitle,
        creator: creator,
        displayTiming: 'T02:00-T06:00',
        position: 'center-bottom',
        style: 'clean-modern-sans-serif'
      },
      scene: '片头-开场',
      shotType: 'opening',
      mouthAction: '', // 片头无口播
      emotionPhase: 'curiosity',
      ratio: '16:9',
      referenceImages: this._extractReferenceImages(characters),
      characters: Object.keys(characters || {}),
      cameraMovement: this._buildCameraMovement(),
      qualityScore: 75
    };
  }

  /**
   * 第一幕:钩子 - 吸引注意力的开场
   */
  _buildHook(world, characters) {
    const charList = Object.values(characters || {}).map(c => c.name).filter(Boolean);

    let hook = '';

    if (charList.length > 0) {
      // v6.6.8-patch4-fix: 五段式酷炫片头 - Phase 1: 黑屏→微光渐亮，警徽特写
      hook = `黑屏中微光渐亮,警徽金属质感特写,光芒从警徽中心向外扩散,画面从暗到明过渡`;
    } else {
      hook = `黑屏中微光渐亮,专业环境轮廓浮现,光线从画面中心向外扩散`;
    }

    return {
      phase: 'hook',
      duration: Math.floor(this.duration * 0.22), // 22% ≈ 2s
      content: hook,
      timing: `T00:00-T00:02`
    };
  }

  /**
   * 第二幕:展开 - 标题信息展示（五段式酷炫片头 Phase 2-4）
   */
  _buildReveal(mainTitle, subTitle, creator, world) {
    const charList = Object.values(world.characters || {}).map(c => c.name).filter(Boolean);
    const charName = charList.length > 0 ? charList[0] : '主讲人';

    // v6.6.8-patch4-fix: 五段式酷炫片头
    // Phase 2 (2-4s): 镜头快速拉远，主讲人警服全身亮相
    // Phase 3 (4-6s): 标题从左侧滑入，主标题金属质感浮现
    // Phase 4 (6-7s): 副标题从底部升起，金色粒子汇聚
    let titleBlock = `${charName}身穿警服全身亮相,镜头快速拉远揭示完整形象,主标题"${mainTitle}"从画面左侧滑入,金属质感大字居中展示,金色粒子环绕标题汇聚`;
    if (subTitle) titleBlock += `,副标题"${subTitle}"从底部升起,与主标题形成层次感`;
    if (creator) titleBlock += `,出品人"${creator}"淡入显示`;

    return {
      phase: 'reveal',
      duration: Math.floor(this.duration * 0.56), // 56% ≈ 5s
      content: titleBlock,
      timing: `T00:02-T00:07`
    };
  }

  /**
   * 第三幕:定格 - 片头收尾（五段式酷炫片头 Phase 5）
   */
  _buildFreeze(world) {
    // v6.6.8-patch4-fix: Phase 5 (7-9s): 画面定格，光晕扩散，淡入正片
    return {
      phase: 'freeze',
      duration: this.duration - Math.floor(this.duration * 0.78), // 剩余22% ≈ 2s
      content: `画面定格,光晕从标题中心向外扩散,柔和过渡,淡入正片,无突兀切换`,
      timing: `T00:07-T00:09`
    };
  }

  /**
   * 组装完整Prompt(1500字符预算)
   */
  _assemblePrompt(hook, reveal, freeze, world, characters) {
    const parts = [];

    // v6.6.3-fix: 统一使用中文标签，消除中英混杂
    // L1: 约束层
    parts.push(`【负面约束】禁止文字、禁止动漫、禁止卡通、禁止变形手、禁止多余手指、禁止水印、16:9画幅、禁止字幕、24fps、超写实、超细节、HDR、胶片颗粒、35mm质感、电影级真实感`);

    // L2: 基础层 - 角色信息（含外观锚定）
    const charEntries = Object.entries(characters || {});
    if (charEntries.length > 0) {
      const [charId, char] = charEntries[0];
      const charName = char.profile?.baseIdentity?.name || char.profile?.name || char.name || charId;
      // v6.6.8-fix: 片头角色锚定 - 读取 appearanceAnchor 注入角色特征
      const appearanceAnchor = char.appearanceAnchor?.uniform || char.appearanceAnchor?.casual || '';
      const visualIdentity = char.visualIdentity?.appearance || {};
      const faceDesc = visualIdentity.face?.promptFragment || '';
      const hairDesc = visualIdentity.hair?.promptFragment || '';
      const bodyDesc = visualIdentity.bodyType?.promptFragment || '';
      
      let roleDesc = charName;
      if (appearanceAnchor) {
        roleDesc += `，${appearanceAnchor}`;
      } else if (faceDesc || hairDesc || bodyDesc) {
        const parts = [faceDesc, hairDesc, bodyDesc].filter(Boolean);
        if (parts.length > 0) roleDesc += `，${parts.join('，')}`;
      }
      parts.push(`【角色】${roleDesc}`);
    } else {
      parts.push(`【角色】无角色`);
    }

    // L3: 场景层
    parts.push(`【场景】${world.name || '片头'}；${world.setting || '专业环境'}；${world.lighting || '自然光'}；${world.atmosphere || '专业氛围'}`);

    // L4: 主体层（五段式酷炫片头）
    parts.push(`【动作】${hook.content}；${reveal.content}；${freeze.content}`);

    // L5: 动态层 - v6.6.8-patch4-fix: 升级运镜为五段式酷炫设计
    parts.push(`【运镜】五段式片头运镜：T0-2s黑屏微光渐亮→T2-4s快速拉远揭示角色→T4-6s标题左侧滑入金属质感浮现→T6-7s副标题底部升起金色粒子汇聚→T7-9s画面定格光晕扩散过渡，推入→旋转→揭示→定格，专业电影级运镜`);
    parts.push(`【全局时间定位】00:00-00:${String(this.duration).padStart(2, '0')} / 时长:${this.duration}s / 类型:片头 / 情绪:好奇`);

    // L6: 风格层
    parts.push(`【情绪】专业开场；清晰；可信；现代；震撼`);
    parts.push(`【灯光】自然光，柔和明亮，均匀照明，警徽和标题区域有金色轮廓光`);

    // L7: 音频层
    parts.push(`【音频】L1:庄重背景音乐渐强，警徽敲击声开场，-18LUFS；L2:环境音渐弱；L3:金色粒子汇聚时高频提亮；避让:标题出现时背景音乐达到峰值`);

    // L8: 内部层
    parts.push(`【渲染参数】超写实电影级画质，35mm胶片颗粒，HDR，照片级真实，16:9画幅，纪录片写实风格，金属质感标题渲染`);
    parts.push(`【导演指令】通用纪录片风格，开场稳重中带震撼，信息清晰，现代感，标题出场有电影级仪式感`);

    // 定妆照引用（如果有角色）
    const charKeys = Object.keys(characters || {});
    if (charKeys.length > 0) {
      const charId = charKeys[0];
      const char = characters[charId];
      const portraitPath = char?.portraits?.front || char?.portraits?.closeup || '';
      if (portraitPath) {
        // v6.6.8-patch7: 统一为 Seedance 官方 @imageN 引用格式，与 Stage 11 一致
        parts.push(`【绑定定妆照】@image1 ${charId}近景,核心特征,超写实`);
      }
      // v6.6.8-patch2-fix: 添加图片1引用
      parts.push(`图片1`);
    }

    return parts.join('；');
  }

  _extractMainTitle(input) {
    // v6.6.1-fix: 智能标题提炼 + 营销化设计
    // 无论上游传入多长的字段,都要提炼成简洁有力的营销标题

    let rawTitle = '';

    // 优先级:input.opening.title > input.title.main > input.title > input.projectName
    if (input.opening?.title && typeof input.opening.title === 'string') {
      rawTitle = input.opening.title.trim();
    } else if (typeof input.title === 'object' && input.title?.main) {
      rawTitle = input.title.main;
    } else if (typeof input.title === 'string' && input.title.trim()) {
      rawTitle = input.title.trim();
    } else if (input.projectName) {
      rawTitle = input.projectName;
    }

    if (!rawTitle) return '未命名项目';

    // 第一步:压缩到核心主题
    let condensed = this._condenseTitle(rawTitle);

    // 第二步:营销化增强(科普视频风格)
    condensed = this._enhanceTitleForMarketing(condensed, input);

    return condensed;
  }

  /**
   * 智能标题压缩:从长描述中提取核心主题
   * 例如:"科普视频穿警服的主讲人讲解横纹肌溶解的症状及实验室检查"
   *       → "横纹肌溶解:症状与实验室检查"
   */
  _condenseTitle(longTitle) {
    if (!longTitle || typeof longTitle !== 'string') return '未命名项目';

    // 阶段1:移除常见前缀噪音(更彻底的清理)
    let title = longTitle
      .replace(/^[^,,]*科普视频[,,、\s]*/i, '')
      .replace(/^[^,,]*健康科普[,,、\s]*/i, '')
      .replace(/^[^,,]*医学科普[,,、\s]*/i, '')
      .replace(/^[^,,]*穿警服的[\u4e00-\u9fa5]+[女士先生][,,、\s]*/i, '')
      .replace(/^[^,,]*穿[\u4e00-\u9fa5]+[的,,、\s]*/i, '')
      .replace(/^关于[,,、\s]*/i, '')
      .replace(/^讲解[,,、\s]*/i, '');

    // 阶段2:如果标题仍很长(>12字),提取核心主题
    if (title.length > 12) {
      // 模式A:匹配 "XXX的症状[及与]YYY" 结构
      const symptomMatch = title.match(/(.+?)(的症状[及与].+)/);
      if (symptomMatch) {
        const subject = symptomMatch[1];
        // 进一步清理 subject 中的前缀
        const cleanSubject = subject
          .replace(/.*[讲解关于]/, '')
          .replace(/^[^的]*的/, '')
          .trim();
        const suffix = symptomMatch[2]
          .replace('的症状及', ':症状与')
          .replace('的症状与', ':症状与');
        return (cleanSubject || subject) + suffix;
      }

      // 模式B:匹配 "XXX的危害[及与]YYY" 结构
      const harmMatch = title.match(/(.+?)(的危害[及与].+)/);
      if (harmMatch) {
        const subject = harmMatch[1].replace(/.*[讲解关于]/, '').trim();
        const suffix = harmMatch[2]
          .replace('的危害及', ':')
          .replace('的危害与', ':');
        return subject + suffix;
      }

      // 模式C:匹配 "XXX的预防[及与]YYY" 结构
      const preventMatch = title.match(/(.+?)(的预防[及与].+)/);
      if (preventMatch) {
        const subject = preventMatch[1].replace(/.*[讲解关于]/, '').trim();
        const suffix = preventMatch[2]
          .replace('的预防及', ':')
          .replace('的预防与', ':');
        return subject + suffix;
      }

      // 模式D:匹配 "XXX的YYY" 结构(通用)
      const generalMatch = title.match(/(?:.*?)([\w]+(?:[\w]+)?)(的[\w]+)/);
      if (generalMatch) {
        const subject = generalMatch[1];
        const suffix = generalMatch[2];
        return subject + ':' + suffix.replace('的', '');
      }
    }

    // 如果已经比较短,直接返回
    return title || '未命名项目';
  }

  /**
   * 营销化标题增强:让标题像广告一样有吸引力
   * 科普视频标题设计原则:简洁有力,突出核心知识点
   */
  _enhanceTitleForMarketing(condensedTitle, input) {
    if (!condensedTitle || condensedTitle === '未命名项目') return '未命名项目';

    // 已经够简洁(<=10字),直接返回
    if (condensedTitle.length <= 10) return condensedTitle;

    // 如果标题已经包含冒号(有主副结构),保持原样
    if (condensedTitle.includes(':') || condensedTitle.includes(':')) return condensedTitle;

    // 提取核心主题词(通常是前几个词)
    const coreWords = condensedTitle.substring(0, 10).trim();

    // 根据视频类型添加营销后缀
    const videoType = input.videoType || '';
    if (videoType === 'EDU' || videoType === 'education' || videoType === '科普') {
      // 科普视频:简洁直接
      return coreWords;
    }

    return condensedTitle;
  }

  /**
   * 智能副标题生成:从input中推断最合适的副标题
   * 副标题像广告语一样精炼,补充主标题未覆盖的信息
   */
  _generateSmartSubTitle(input, mainTitle) {
    const parts = [];

    // 1. 系列信息(最优先)
    if (input.isSeries && input.currentEpisode) {
      if (input.totalEpisodes) {
        parts.push(`第${input.currentEpisode}集/共${input.totalEpisodes}集`);
      } else {
        parts.push(`第${input.currentEpisode}集`);
      }
    }

    // 2. 系列标题
    if (input.opening?.seriesTitle &&
        input.opening.seriesTitle !== mainTitle &&
        input.opening.seriesTitle.length <= 10) {
      parts.push(input.opening.seriesTitle);
    }

    // 3. 主讲人/创作者
    const creator = input.creator || input.world?.creator || '';
    if (creator && creator.length <= 6 && !mainTitle.includes(creator)) {
      parts.push(creator);
    }

    // 4. 视频类型标签
    const videoType = input.videoType || '';
    if ((videoType === 'EDU' || videoType === 'education') && parts.length === 0) {
      parts.push('健康科普');
    }

    // 合并并截断(副标题总长度控制在20字以内)
    const subtitle = parts.filter(Boolean).join(' | ');
    return subtitle.length > 20 ? subtitle.substring(0, 20) : subtitle;
  }

  _extractSubTitle(input) {
    // v6.6.1-fix: 副标题智能生成,拒绝长字符串直接塞入
    // 副标题长度控制在15字以内,像广告语一样精炼

    let rawSub = '';

    // 获取原始副标题(如果有)
    if (input.opening?.subtitle && typeof input.opening.subtitle === 'string') {
      rawSub = input.opening.subtitle.trim();
    }

    // 获取主标题用于比对
    const mainTitle = this._extractMainTitle(input);

    // 过滤无效副标题:太长、与主标题重复、包含主标题
    if (rawSub && (rawSub.length > 15 || rawSub === mainTitle || rawSub.includes(mainTitle))) {
      rawSub = '';
    }

    // 如果原始副标题有效且简短,直接使用
    if (rawSub && rawSub.length <= 15) {
      return rawSub;
    }

    // 智能推断生成副标题
    return this._generateSmartSubTitle(input, mainTitle);
  }

  _extractReferenceImages(characters) {
    const refs = [];
    for (const [id, char] of Object.entries(characters || {})) {
      if (char.portraits?.front) {
        refs.push({ id: `${id}-front`, path: char.portraits.front });
      }
    }
    return refs;
  }

  _buildCameraMovement() {
    // v6.6.8-patch4-fix: 五段式酷炫片头运镜
    return {
      scene: '片头',
      primaryMovement: '黑屏微光→快速拉远→标题滑入→粒子汇聚→定格过渡',
      speed: 'slow-to-fast-to-slow',
      shotSize: 'extreme-closeup-to-full-body-to-wide',
      timeline: `T00:00-T00:${this.duration}`,
      phases: [
        { time: 'T0-2s', movement: '黑屏中警徽特写微光渐亮', speed: 'slow', shotSize: 'extreme-closeup' },
        { time: 'T2-4s', movement: '镜头快速拉远揭示角色全身', speed: 'fast', shotSize: 'full-body' },
        { time: 'T4-6s', movement: '标题从左侧滑入金属质感浮现', speed: 'medium', shotSize: 'medium' },
        { time: 'T6-7s', movement: '副标题底部升起金色粒子汇聚', speed: 'slow', shotSize: 'medium' },
        { time: 'T7-9s', movement: '画面定格光晕扩散淡入正片', speed: 'slow', shotSize: 'wide' }
      ]
    };
  }
}

module.exports = GenericOpeningSystem;
