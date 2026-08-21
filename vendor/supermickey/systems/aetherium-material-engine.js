/**
 * AETHERIUM MATERIAL ENGINE — Nirath Native Material Library
 * ASTRALIS v3.0
 * 
 * 9种Nirath星球原生材质，每种材质包含：
 * - 物理参数（与Nirath环境互动）
 * - 双恒星互动特性
 * - 标题应用场景
 * - Prompt模板与变体
 * 
 * @module aetherium-material-engine
 * @version 3.0
 */

// ─────────────────────────────────────────
// 2.1 九大原生材质定义
// ─────────────────────────────────────────

const AETHERIUM_MATERIALS = {
  // ─────────────────────────────────────────
  // 材质1：FERROFLUX 磁流体
  // ─────────────────────────────────────────
  ferroflux: {
    name: 'FERROFLUX 磁流体',
    nirathEssence: 'Nirath星球最具标志性的物质 — 受磁场控制的液态金属',
    physicalParams: {
      baseComposition: '纳米铁磁颗粒悬浮在量子苔藓提取液中',
      magnetization: '饱和磁化强度 1.2T，可随磁场实时变形',
      viscosity: '磁场中呈固态，无磁场时呈液态 — 相变温度室温',
      surfaceTension: '在磁场梯度中可形成任意几何形状',
      reflectivity: '镜面级 98.5%，反射环境但带淡蓝紫色调偏移'
    },
    stellarInteraction: {
      aureliusResponse: '金色光下呈现暖铜色流体，边缘有紫红干涉纹',
      silvanaResponse: '银白光下呈现冷钢色，边缘有青蓝干涉纹',
      dualSourceEffect: '双光源同时照射下，流体表面出现两种颜色的干涉条纹，如油膜彩虹但更有序'
    },
    titleApplication: {
      morphogenesis: '磁流体在磁场中自行流动，自然形成字母轮廓',
      dynamics: '字母不是静止的，表面有永恒的微观流动，如活物',
      climax: '磁暴时刻，整个标题如被风吹散的液态金属，重组为副标题'
    },
    promptTemplate: `【FERROFLUX磁流体】纳米铁磁颗粒悬浮液，饱和磁化强度1.2T，可随Nirath磁场实时变形。镜面级反射率98.5%，表面永恒微观流动。双恒星照射下呈现双色干涉条纹：Aurelius金色光下暖铜色底色+紫红边缘，Silvana银白光下冷钢色底色+青蓝边缘。流体表面如活物般呼吸，磁场线穿过流体时产生可见的丝状发光轨迹。{{variant}}`,
    variants: {
      titleForm: '磁流体在磁场中自行组织成"{{TITLE}}"字母形状，每个字母表面有独立的流体动力学，字母间有磁丝连接',
      stormMorph: '磁暴状态下流体被拉扯成丝状，如银色瀑布逆流，重组过程中字母在液态与固态间振荡',
      poolReflection: '磁流体池中完美倒影双恒星和标题，水面微扰动使倒影如印象派油画般破碎重组'
    }
  },

  // ─────────────────────────────────────────
  // 材质2：PLASMA_TENDRIL 等离子触须
  // ─────────────────────────────────────────
  plasmaTendril: {
    name: 'PLASMA TENDRIL 等离子触须',
    nirathEssence: '双恒星风与磁场相互作用产生的大尺度等离子体结构',
    physicalParams: {
      composition: '电离氢与氦，温度 8000-15000K',
      magneticConfinement: '被Nirath磁场束缚成触须状结构',
      length: '10-300米，直径0.3-2米',
      luminosity: '自发光，不依赖外部照明',
      movement: '随磁场波动缓慢摇摆，频率30Hz共振'
    },
    stellarInteraction: {
      solarWindOrigin: '源于双恒星风粒子被磁场捕获',
      colorGradient: '根部量子青（低温8000K）→中段磁紫（中温11000K）→尖端圣光白（高温15000K）',
      flareResponse: '恒星耀斑爆发时，触须亮度倍增并产生分支结构'
    },
    titleApplication: {
      letterWeaving: '多条触须交织编织成字母，如3D打印般逐笔构建',
      livingText: '触须持续生长，字母不断自我重建，永不完工',
      climax: '耀斑触发时，标题瞬间爆发强光然后消散为漫天星火'
    },
    promptTemplate: `【PLASMA TENDRIL等离子触须】电离氢氦等离子体，温度8000-15000K，被Nirath磁场束缚成触须结构。自发光不需外部照明，长度10-300米。颜色梯度：根部量子青（8000K）→中段磁紫（11000K）→尖端圣光白（15000K）。随30Hz磁场共振缓慢摇摆，如深海生物般优雅。恒星耀斑时亮度倍增产生分支。{{variant}}`,
    variants: {
      weaveLetters: '{{TITLE}}由{{N}}条等离子触须编织而成，触须从画面四周磁极点伸出，在中心交织成字母，编织过程如3D打印般逐笔可见',
      auroraCanopy: '等离子触须在标题上方形成canopy（天篷），如发光树枝交织，字母在触须间隙中若隐若现',
      flareBurst: '触须尖端同时爆发，光芒汇聚成"{{TITLE}}"形状，爆发后化为漫天星火缓缓沉降'
    }
  },

  // ─────────────────────────────────────────
  // 材质3：QUANTUM_MOSS 量子苔藓
  // ─────────────────────────────────────────
  quantumMoss: {
    name: 'QUANTUM MOSS 量子苔藓',
    nirathEssence: '具有量子相干性的生物荧光地衣 — Nirath生态系统的神经网络',
    physicalParams: {
      cellStructure: '菌丝形成量子纠缠网络，覆盖范围可达整座岛屿',
      bioluminescence: '荧光素酶反应+量子隧穿增强，效率比地球生物荧光高100倍',
      colorSpectrum: '4800K基础青绿 + 量子相干产生的干涉色（随观测角度变化）',
      entanglementEffect: '一处受刺激，整个网络同步响应 — 发光波纹以超光速扩散的视觉效果',
      density: '每平方米约10亿个菌丝节点'
    },
    stellarInteraction: {
      photosynthesis: '不仅吸收光能，还吸收磁场能量进行生物合成',
      nightCycle: '双星落下后进入自主发光模式，亮度不减反增',
      auroraCoupling: '极光出现时，苔藓与极光同步脉动，如星球在呼吸'
    },
    titleApplication: {
      growthPattern: '苔藓从地面向中心生长，路径自然形成字母 — 如加速1000万年的延时摄影',
      neuralText: '菌丝在地面组成神经网络，标题以电信号形式在网中传播，所到之处亮起',
      memoryReveal: '字母形成后，菌丝网络显示出Nirath星球的地图纹理 — 标题即地图'
    },
    promptTemplate: `【QUANTUM MOSS量子苔藓】菌丝量子纠缠网络，覆盖整座岛屿的神经网络。荧光素酶+量子隧穿增强，效率地球100倍。4800K基础青绿+量子相干干涉色（随观测角变化）。一处受刺激全网同步响应，发光波纹超光速扩散视觉效果。每平方米10亿菌丝节点。{{variant}}`,
    variants: {
      growthPath: '苔藓从画面边缘向中心生长，路径精确形成"{{TITLE}}"，生长速度肉眼可见如延时摄影，每条笔画都是一条苔藓高速公路',
      neuralPulse: '地面苔藓网络以电脉冲形式传输"{{TITLE}}"，脉冲所到之处菌丝从暗青绿转为亮量子青，如大脑神经放电的可视化',
      topographicMap: '苔藓生长完成后，字母内部显现出Nirath九岛地图的等高线纹理，标题即星球地图'
    }
  },

  // ─────────────────────────────────────────
  // 材质4：MAGNETICLINE_MEMORY 晶质记忆体
  // ─────────────────────────────────────────
  magneticMemory: {
    name: 'MAGNETIC MEMORY 晶质记忆体',
    nirathEssence: 'Nirath磁质体不仅透明，还存储着星球的历史 — 内部有全息影像',
    physicalParams: {
      crystalSystem: '六方晶系，但晶胞参数随存储内容变化',
      refractiveIndex: '1.544-1.553（常光/异常光双折射）',
      holographicStorage: '晶格缺陷层存储全息影像，特定角度可见内部影像',
      growthHabit: '沿磁场方向优先生长，形成非地球的磁质体形态',
      piezoelectricity: '受压时产生电荷，伴随可见的蓝色火花'
    },
    stellarInteraction: {
      lightConduction: '光线在磁质体内部如光纤般传导，从一端进入从另一端射出',
      spectrumSplit: '双恒星光穿过磁质体被分解为金色和银白两束，分别从不同面射出',
      internalLandscape: '磁质体内部有微缩的Nirath景观全息图，如琥珀中的昆虫但更加复杂'
    },
    titleApplication: {
      crystalGrowth: '磁质体从岩石中生长，内部全息影像逐渐清晰为"{{TITLE}}"',
      refractiveTitle: '标题由多颗磁质体的折射光斑自然组成，移动视角字母变化',
      shatterReveal: '磁质体碎裂，碎片每一片都反射出标题的一个部分，如立体拼图'
    },
    promptTemplate: `【MAGNETIC MEMORY晶质记忆体】六方晶系，晶胞参数随存储内容变化。双折射率1.544-1.553，内部全息影像存储。沿磁场方向生长，非地球形态。光线如光纤传导，双星光分解为金色和银白两束。受压产生压电火花。{{variant}}`,
    variants: {
      holographicGrowth: '紫磁质体从岩床生长，内部全息影像逐渐清晰为"{{TITLE}}"，生长伴随压电火花，磁质体面折射出彩虹光谱',
      refractiveAssembly: '{{N}}颗磁质体排列成阵列，每颗折射双星光在空间中交汇，自然形成"{{TITLE}}"光斑，移动时光斑如全息图变化',
      fractalShatter: '巨型磁质体碎裂成{{N}}片，每片碎片反射标题的一个字母片段，碎片悬浮重组过程中标题逐渐完整'
    }
  },

  // ─────────────────────────────────────────
  // 材质5：AETHER_SPORE 以太孢子
  // ─────────────────────────────────────────
  aetherSpore: {
    name: 'AETHER SPORE 以太孢子',
    nirathEssence: 'Nirath大气中漂浮的发光微生物 — 空气的可见化',
    physicalParams: {
      biologicalNature: '单细胞发光生物，直径20-100微米',
      density: '1200个/cm³（高密度区可达5000个/cm³）',
      luminescenceCycle: '集体同步闪烁，频率0.5-3Hz，如呼吸',
      magneticNavigation: '含铁磁颗粒，沿磁场线移动',
      gravityResponse: '低重力（0.82G）下沉降极慢，可悬浮数小时'
    },
    stellarInteraction: {
      diurnalMigration: '随双恒星位置变化垂直迁移 — 昼升夜降',
      lightScattering: '对金色和银白光产生不同散射角，形成双色光晕',
      densityVisualization: '高密度区如发光雾气，低密度区如星空'
    },
    titleApplication: {
      swarmIntelligence: '孢子如候鸟群般集体运动，自然形成"{{TITLE}}"的粒子云',
      luminescentFog: '高密度孢子雾中，标题如霓虹灯牌般在雾中显现',
      driftLetters: '每个字母由不同颜色的孢子群组成，如彩色烟雾缓慢漂移'
    },
    promptTemplate: `【AETHER SPORE以太孢子】单细胞发光微生物，直径20-100微米，密度1200-5000个/cm³。集体同步闪烁0.5-3Hz如呼吸。含铁磁颗粒沿磁场线移动，0.82G低重力下悬浮数小时。双星光下产生双色散射光晕。{{variant}}`,
    variants: {
      swarmForm: '孢子群如候鸟迁徙般在磁场引导下集体运动，精确形成"{{TITLE}}"三维形状，群体边缘个体如跳动的星尘不断脱离与加入',
      densityGradient: '孢子雾从浓到淡形成"{{TITLE}}"，浓处如发光实质，淡处如幽灵虚影，呼吸般明灭',
      chromaticDrift: '{{N}}种颜色孢子群（琥珀金群+量子青群+磁紫群）各自组成"{{TITLE}}"的一个字母，三色烟雾缓慢漂移交错'
    }
  },

  // ─────────────────────────────────────────
  // 材质6：VOID_SILK 虚空丝
  // ─────────────────────────────────────────
  voidSilk: {
    name: 'VOID SILK 虚空丝',
    nirathEssence: '某种未知生物产出的超细丝线 — 比蛛丝细1000倍，强磁场下可见',
    physicalParams: {
      thickness: '直径10纳米（蛛丝10000纳米），肉眼单独不可见',
      visibilityMechanism: '仅当与磁场线对齐时，因散射磁光而可见',
      tensileStrength: '理论值极高，可承受自身重量百万倍',
      networkStructure: '形成三维网状结构，覆盖整个生态空间',
      vibrationMode: '磁场波动引起共振，发出30Hz超低频光脉冲'
    },
    stellarInteraction: {
      gossamerGlow: '双星光照射时，整片丝网如巨大蛛网般闪烁',
      interferenceColors: '不同粗细的丝产生不同颜色的薄膜干涉',
      windResponse: '无风时静止如隐形，微风时整片空间开始流动'
    },
    titleApplication: {
      invisibleWeb: '虚空丝在磁场中勾勒"{{TITLE}}"轮廓，如隐形墨水在紫外线下显现',
      resonanceWriting: '丝的振动模式改变，发光脉冲自然拼出摩斯电码形式的标题',
      windDance: '微风吹动丝网，整片空间如丝绸般流动，标题在流动中若隐若现'
    },
    promptTemplate: `【VOID SILK虚空丝】直径10纳米超细生物丝线，仅在与磁场线对齐时因散射磁光可见。形成三维空间网，30Hz共振发出超低频光脉冲。双星光下如巨大发光蛛网，不同粗细产生薄膜干涉色。{{variant}}`,
    variants: {
      magneticReveal: '强磁场脉冲激活虚空丝网，丝线在空间中自动排列成"{{TITLE}}"三维轮廓，如隐形墨水显现，脉冲过后逐渐淡出',
      resonancePulse: '丝网以30Hz共振，光脉冲在丝网上传播，轨迹自然拼出"{{TITLE}}"的摩斯电码，解码过程如星球心跳',
      silkWind: '微风吹动虚空丝，整片空间如丝绸海洋流动，"{{TITLE}}"在丝浪中若隐若现，如在水下看水面阳光破碎'
    }
  },

  // ─────────────────────────────────────────
  // 材质7：GRAVITATIONAL_LENS 引力透镜物质
  // ─────────────────────────────────────────
  gravitationalLens: {
    name: 'GRAVITATIONAL LENS 引力透镜物质',
    nirathEssence: 'Nirath强磁场区域产生的类引力透镜效应 — 空间本身成为材质',
    physicalParams: {
      nature: '非实体物质，是磁场弯曲空间的视觉效果',
      bendingAngle: '最大15度光线偏折',
      focalLength: '随磁场强度变化，可实时调焦',
      chromaticAberration: '不同颜色光偏折角度不同，产生彩色边缘',
      temporalDistortion: '光线穿过强磁场区域产生微小时间延迟'
    },
    stellarInteraction: {
      dualImage: '双恒星在透镜区产生重影，如海市蜃楼',
      spectrumDecomposition: '白光分解为Nirath五色光谱',
      magnification: '背景物体被放大扭曲，如透过磁质体球看世界'
    },
    titleApplication: {
      spaceWarp: '标题不是在空间中，标题是通过扭曲的空间"看"到的',
      lensFlareTitle: '引力透镜的焦点处自然形成"{{TITLE}}"的光学幻象',
      chromaticDistortion: '标题每个字母有不同颜色的边缘偏移，如劣质镜头但极其美丽'
    },
    promptTemplate: `【GRAVITATIONAL LENS引力透镜效应】Nirath强磁场弯曲空间产生的视觉效果，最大15度光线偏折。不同色光偏折角度不同产生彩色边缘，光线穿过产生微小时间延迟。双恒星在透镜区产生重影如海市蜃楼。{{variant}}`,
    variants: {
      spaceWarpTitle: '画面中央强磁场区扭曲背景，透过扭曲空间看到背景中的"{{TITLE}}"被拉伸变形，如引力透镜下的星系',
      chromaticFocus: '引力透镜焦点处五色光谱自然汇聚成"{{TITLE}}"，每个字母有不同颜色的边缘光晕：红移→紫移渐变',
      temporalEcho: '标题在透镜区产生时间延迟残影，"{{TITLE}}"的过去版本（3秒前）与现在版本同时可见，形成时间叠加'
    }
  },

  // ─────────────────────────────────────────
  // 材质8：SILVERWOOD 银木
  // ─────────────────────────────────────────
  silverwood: {
    name: 'SILVERWOOD 银木',
    nirathEssence: 'Nirath的树木 — 不是植物，是硅基金属有机体',
    physicalParams: {
      composition: '硅基纤维骨架+纳米银镀层，非碳基植物',
      barkTexture: '如锻打银器般有锤纹，高反射率92%',
      leafStructure: '无叶，枝条末端是光纤簇，传导和发射光线',
      growthPattern: '沿磁场线分叉，分形角度固定为137.5度（黄金角）',
      resonance: '整棵树是共振腔，风过时发出特定音高的光脉冲'
    },
    stellarInteraction: {
      lightHarvesting: '光纤枝条收集双星光，树干内部可见光流传导',
      spectrumEmission: '傍晚释放白天储存的光，颜色从金渐变到银',
      shadowSignature: '投影不是黑色，是银蓝色 — 光被反射而非吸收'
    },
    titleApplication: {
      treeSculpture: '银木枝条生长成"{{TITLE}}"形状，光纤末端发光如霓虹',
      lightHarbor: '标题被银木林环绕，每棵树内部光流如血管般脉动',
      shadowCast: '银木林的collective shadow在地面拼出"{{TITLE}}"'
    },
    promptTemplate: `【SILVERWOOD银木】硅基金属有机体，纳米银镀层纤维骨架，反射率92%。无叶，枝条末端光纤簇传导发光。沿磁场线黄金角137.5度分形分叉。整树为共振腔，风过发光脉冲。投影非黑是银蓝色。{{variant}}`,
    variants: {
      bioSculpture: '银木枝条沿磁场线生长，自然编织成"{{TITLE}}"三维雕塑，光纤末端发射金/银双色光，整棵树如电路板上的发光走线',
      forestVessel: '银木林环绕标题，每棵树干内部可见光流如血管脉动，集体形成"{{TITLE}}"的发光轮廓，树林即标题的容器',
      shadowTypography: '双恒星照射银木林，collective shadow在量子苔藓地面上拼出"{{TITLE}}"，影字比实物更亮（银蓝色发光阴影）'
    }
  },

  // ─────────────────────────────────────────
  // 材质9：CHROMA_FLUID 色层流体
  // ─────────────────────────────────────────
  chromaFluid: {
    name: 'CHROMA FLUID 色层流体',
    nirathEssence: 'Nirath特有的分层液体 — 不同颜色层永不相溶，各自流动',
    physicalParams: {
      layerStructure: '3-7层不混溶液体，密度逐层递增',
      colorLayers: ['深渊紫（底层，最重）', '磁紫', '量子青', '琥珀金', '圣光白（表层，最轻）'],
      interfaceEffect: '层间界面产生薄膜干涉，如肥皂泡但更稳定',
      flowBehavior: '各层独立流动速度不同，形成剪切条纹',
      magneticResponse: '各层对磁场响应不同，可在磁场中分离重组'
    },
    stellarInteraction: {
      depthDependent: '深层吸收金色光，表层反射银色光',
      interfacePrism: '层间界面如棱镜，白光分解为Nirath五色光谱',
      wavePatterns: '流体波动时，各层颜色如梯田般错动'
    },
    titleApplication: {
      layerReveal: '色层流体倾泻，每层揭示标题的一个部分，如地质剖面',
      chromaticWave: '流体波动中，"{{TITLE}}"在不同色层间穿梭，颜色逐层变化',
      magneticSeparation: '磁场将流体按颜色分离，标题在彩虹瀑布中被拆解重组'
    },
    promptTemplate: `【CHROMA FLUID色层流体】3-7层永不相溶液体，密度递增。层间薄膜干涉如稳定肥皂泡，各层独立流动形成剪切条纹。磁场中可分离重组。深层吸金表层反银，层间棱镜分解五色光谱。{{variant}}`,
    variants: {
      stratumReveal: '色层流体从悬崖分层倾泻，深渊紫底层先露出"{{TITLE}}"的深色轮廓，量子青层揭示中段，琥珀金顶层完成高光，如地质剖面展现标题',
      shearWave: '流体波动产生剪切条纹，"{{TITLE}}"在不同色层间穿梭，字母从紫色渐变为金色如穿越时间隧道',
      magneticCascade: '强磁场将色层流体按颜色垂直分离，"{{TITLE}}"在彩虹瀑布中被拆解为单色组件，磁场减弱时各层重新融合，标题重组'
    }
  }
};

// ─────────────────────────────────────────
// 2.2 材质引擎 API
// ─────────────────────────────────────────

/**
 * 获取材质约束描述（Nirath原生版）
 * @param {string} materialType - 材质类型键名
 * @param {string} variant - 变体ID
 * @param {string} titleText - 标题文本（用于替换模板变量）
 * @returns {string} 材质描述文本
 */
function getMaterialConstraint(materialType, variant, titleText = '') {
  const material = AETHERIUM_MATERIALS[materialType];
  if (!material) return '';
  
  let description = `【${material.name}】`;
  description += `${material.nirathEssence}。`;
  
  // 物理参数（精简版，Prompt中只放关键数值）
  const params = material.physicalParams;
  const keyParams = Object.entries(params).slice(0, 2).map(([k, v]) => `${k}:${v}`).join('，');
  description += `${keyParams}。`;
  
  // 双恒星互动（Nirath独有）
  const stellar = material.stellarInteraction;
  const aureliusDesc = stellar.aureliusResponse || stellar.solarWindOrigin || stellar.depthDependent || '呈现独特光学特性';
  description += `Aurelius金光照耀下${aureliusDesc}。`;
  
  // 变体应用
  if (variant && material.variants[variant]) {
    let variantText = material.variants[variant];
    variantText = variantText.replace(/\{\{TITLE\}\}/g, titleText);
    variantText = variantText.replace(/\{\{N\}\}/g, '3'); // 默认数量
    description += variantText;
  }
  
  return description;
}

/**
 * 生成材质段（v3.0：自动叠加Nirath环境上下文）
 * @param {Array} materials - 材质配置数组 [{type, variant}]
 * @param {string} titleText - 标题文本
 * @returns {string} 完整材质描述段落
 */
function generateNirathMaterialSection(materials, titleText = '') {
  const baseDescriptions = materials.map(m =>
    getMaterialConstraint(m.type, m.variant, titleText)
  ).join('\n');
  
  // v3.0新增：自动追加Nirath环境介质材质
  const atmosphericMedium = `【Nirath大气介质】0.82G低重力，空气折射率1.00045，磁悬浮水滴，1200个/cm³以太孢子漂浮，30Hz磁场共鸣可感知为低频震动。双恒星风携带带电粒子，与磁场作用产生无处不在的淡蓝紫环境光晕。`;
  
  return baseDescriptions + '\n' + atmosphericMedium;
}

/**
 * 获取材质详情（完整信息）
 * @param {string} materialType - 材质类型
 * @returns {Object|null} 完整材质定义
 */
function getMaterialDetails(materialType) {
  return AETHERIUM_MATERIALS[materialType] || null;
}

/**
 * 获取所有材质名称列表
 * @returns {Array} [{key, name}, ...]
 */
function getMaterialList() {
  return Object.entries(AETHERIUM_MATERIALS).map(([key, mat]) => ({
    key,
    name: mat.name,
    essence: mat.nirathEssence
  }));
}

/**
 * 获取材质推荐组合
 * @param {string} mood - 情感基调
 * @returns {Array} 推荐材质组合
 */
function getMaterialRecommendations(mood) {
  const combos = {
    'tech-nature': ['ferroflux', 'quantumMoss'],
    'pure-energy': ['plasmaTendril', 'aetherSpore'],
    'spacetime': ['gravitationalLens', 'voidSilk'],
    'living': ['quantumMoss', 'silverwood'],
    'genesis': ['chromaFluid', 'magneticMemory'],
    'mystery': ['voidSilk', 'aetherSpore'],
    'epic': ['ferroflux', 'plasmaTendril', 'magneticMemory'],
    'mysterious': ['voidSilk', 'quantumMoss', 'gravitationalLens'],
    'organic': ['quantumMoss', 'silverwood', 'aetherSpore'],
    'dramatic': ['ferroflux', 'plasmaTendril', 'chromaFluid']
  };
  return combos[mood] || combos['epic'];
}

module.exports = {
  AETHERIUM_MATERIALS,
  getMaterialConstraint,
  generateNirathMaterialSection,
  getMaterialDetails,
  getMaterialList,
  getMaterialRecommendations
};
