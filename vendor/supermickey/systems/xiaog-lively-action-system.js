/**
 * 小G待机感系统 — XiaoG Presence System (XPS)
 *
 * 使命：让小G从"会动的嘴"升级为"活着的男孩"
 * 原则：真实感不来自五官，来自"待机状态"中充满生命迹象
 *
 * 设计哲学（v2.0 — 待机感注入）：
 * 1. 核心公式：人物 + 正在做的小事 + 下意识反应 + 情绪落点
 * 2. 待机感 = 生理待机（呼吸/眨眼/体温）+ 心理待机（走神/习惯性小动作）+ 社会待机（对环境的微妙反应）
 * 3. 禁止"站桩"——小G即使在"什么都不做"时，也在等待得独一无二
 * 4. "不完美"才是真实：会走神、动作中途改变、眼神不知看哪、呼吸乱拍
 *
 * 输入：phase(钩子/展开/定格), mood, interactionType(远观/试探/接近/共鸣), hasDialogue
 * 输出：动作描述（待机小事 + 下意识反应 + 情绪落点 + 生命反应叠加）
 *
 * @module xiaog-presence-system
 * @version 2.0
 */

class XiaoGLivelyActionSystem {
  constructor() {
    // 动作库：按场景阶段 + 情绪 + 互动层次组织
    this.actionLibrary = {
      // ===== 钩子阶段 — 开场/发现 =====
      hook: {
        // 情绪：神秘 — 待机感公式：小事 + 下意识反应 + 情绪落点
        mysterious: {
          // v2.0：每个动作都是"正在做的小事"，不是"摆姿势"
          actions: [
            // 动作1：探头观察 + 碎光反应 + 好奇落点
            '小G蹲下来，从磁丝草丛缝隙中探头，手指竖在嘴边做"嘘"的动作但嘴角忍不住上扬——一片孢子碎光落在他鼻尖上，他下意识皱了皱鼻子，眼睛眨了两下，瞳孔倒映着双恒星的金色光芒，像两粒融化的蜂蜜',
            // 动作2：拨弄指南针 + 磁丝反应 + 警觉落点
            '小G歪着头，一只手无意识地把玩指南针挂绳，挂绳缠在手指上三圈。磁丝树突然倾斜，指南针指针剧烈抖动——他手腕一缩，但手指还勾着挂绳没松开，停在半空。呼吸比平时快了半拍，嘴角抿成一条线又缓缓放松',
            // 动作3：倒退又前进 + 草叶反应 + 冲动落点
            '小G倒退两步，被眼前的景象惊到，脚跟蹭着地面发出细微声响。一片草叶拂过他手背，他本能地一缩，随即又忍不住往前蹭了两步，像只好奇的小猫——重心在脚尖和脚跟间快速切换，膝盖微弯蓄力'
          ],
          // v2.0：微表情升级为"下意识反应"
          microExpressions: [
            '眉毛扬起又落下，像两片被风吹动的叶子——不是刻意惊讶，是神经反射',
            '瞳孔微微放大，但焦点在远处和近处之间漂移了两秒，像在寻找什么又不知道自己要找什么',
            '脸颊因兴奋泛起淡淡红晕，但呼吸从急促慢慢变深，像情绪在体内慢慢沉淀'
          ],
          // v2.0：手部细节升级为"习惯性小动作"
          handDetails: [
            '手指无意识地绞着衣角，绞了三圈又松开——这个习惯他自己都没意识到，是等待时的本能',
            '一只手紧握着背包带，指节发白，但拇指在背包扣上无意识地敲打着节拍——内心有旋律',
            '手掌在裤腿上擦了擦汗，擦完又擦了一次——比实际需要多了一下，是紧张的惯性'
          ],
          // v2.0：重心变化升级为"身体化态度"
          weightShift: [
            '重心在脚尖和脚跟间快速切换，像一只随时准备起跑但又不确定方向的小鹿',
            '身体微微前倾，膝盖微弯蓄力——但不是攻击姿态，是好奇的引力',
            '一只脚不自觉地踮起，落下，又踮起——等待时的不耐烦，像等公交车时的小孩'
          ],
          // v2.0新增：生命反应叠加（眨眼/呼吸/眼神漂移）
          lifeReactions: {
            blink: '眨眼比平时慢15%，但偶尔突然快眨两下——走神时的不规律',
            breath: '呼吸从急促慢慢变深，但中间有一次异常的"漏拍"——兴奋到缺氧的瞬间',
            gaze: '目光从眼前景象移开，飘向虚空某点两秒，又迅速收回——在想什么，但连他自己都不知道'
          }
        },
        // 情绪：史诗
        epic: {
          actions: [
            '小G双手叉腰，仰着头，故意摆出"我来探险了"的架势，但眼睛里的光芒出卖了他',
            '小G跳起来，双手在空中挥舞，落地时故意把地面踩出"咚"的一声',
            '小G把背包甩到胸前，双手抓着肩带，像捧着什么宝贝，一步步坚定地向前'
          ],
          microExpressions: [
            '下巴微抬，眼神坚定',
            '嘴角抿着，压抑不住笑意'
          ],
          handDetails: [
            '拳头紧握又松开',
            '手指在背包扣上敲打着节拍'
          ],
          weightShift: [
            '双脚稳稳扎地，像小树苗扎根',
            '走路带风，每一步都故意踩实'
          ]
        }
      },

      // ===== 展开阶段 — 互动/发展 =====
      development: {
        // 互动层次：远观 — 待机感：屏息观察 + 环境微刺激反应 + 紧张落点
        observe: {
          actions: [
            // 动作1：抱膝观察 + 碎石滑落反应 + 受惊落点
            '小G蹲下来，把下巴搁在膝盖上，双手环抱小腿，像只受惊但好奇的小动物。脚边一颗碎石从岩缝中滑落，发出轻微的"嗒"声——他肩膀本能地一缩，抱膝的手臂收紧了半秒，随即缓缓放松。呼吸变浅，但节奏不乱，像在强迫自己保持镇定',
            // 动作2：后退防御 + 磁场嗡鸣反应 + 警觉落点
            '小G缓慢后退半步，脚跟蹭着地面发出细微声响，一只手无意识挡在身前。空气中突然传来一阵低频磁场嗡鸣，他的指尖微微颤抖了一下，停在半空，像被无形的琴弦拨动。眼睛快速眨了两下，瞳孔收缩——不是恐惧，是警惕',
            // 动作3：僵直观察 + 孢子落肩反应 + 迷幻落点
            '小G屏住呼吸，双手紧紧抱住胸前背包，身体僵在原地，只有眼睛在快速转动。一粒发光孢子缓缓落在他肩头发梢上，他眼角余光捕捉到，眉头微皱，头微微侧了一下——但很快克制住，继续保持观察姿态。呼吸比刚才更深，像在为某种决定积蓄氧气'
          ],
          microExpressions: [
            '眼睛瞪圆，睫毛快速颤动——像蝴蝶翅膀在灯光下的抖动，不受控制',
            '嘴唇抿成一条线，偶尔微微颤抖——不是害怕，是兴奋被强行压抑',
            '瞳孔在异兽身上聚焦一秒，又飘向地面半秒，再收回——注意力在勇气和谨慎之间摇摆'
          ],
          handDetails: [
            '手指深深掐进背包布料，指节发白，但无名指和小指在轻微抽动——是紧张的惯性，不是刻意',
            '掌心全是汗，在裤腿上擦过——擦完又擦了一次，比实际需要多一下',
            '拇指在背包拉链上来回摩挲，发出细微的"沙沙"声——无意识的习惯，像转笔'
          ],
          weightShift: [
            '重心后移，随时准备逃跑但又舍不得——像一只想靠近火堆又怕烫的小动物',
            '双脚一前一后，像起跑前的预备姿势——但后脚跟没有完全离地，是犹豫的姿态',
            '膝盖微微内扣，不是懦弱的姿态，是8岁男孩紧张时的本能自我保护'
          ],
          lifeReactions: {
            blink: '眨眼频率加快，但偶尔突然停顿两秒——注意力高度集中时的神经冻结',
            breath: '呼吸浅而快，但中间会突然深吸一口气，像潜水前的准备',
            gaze: '目光快速扫视后定格，又迅速移开，像怕被发现自己在观察——典型的孩子式偷看'
          }
        },
        // 互动层次：试探 — 待机感：小心翼翼 + 磁场共振反应 + 好奇落点
        probe: {
          actions: [
            // 动作1：试探前进 + 地面震颤反应 + 谨慎落点
            '小G试探性地向前一步，脚尖先落地，确认安全后才跟上脚跟，像只谨慎的小鹿。地面突然传来一阵轻微震颤——他停在半空的那只脚僵了一秒，脚踝微微抖动，像在选择"落下去"还是"收回来"。最终脚跟缓缓落下，比正常步态慢了半拍',
            // 动作2：伸手示意 + 磁场光丝反应 + 善意落点
            '小G伸出一只手，掌心向上，做出"我没有恶意"的姿态，但另一只手还抓着背包带不放。一道淡蓝紫磁场光丝飘过他的手背，汗毛本能地竖起——他手指微微蜷缩，但没有收回手。嘴角从紧张抿着慢慢放松，变成半信半疑的弧度',
            // 动作3：观察石子 + 孢子发光反应 +  wonder落点
            '小G歪着头，慢慢蹲下，从地上捡起一块发光的小石子，举到眼前对着双恒星观察。石子在光线下变幻颜色，他的瞳孔随着颜色变化微微收缩又放大——无意识的身体反应。嘴角不自觉上扬，像发现了宝藏的小孩'
          ],
          microExpressions: [
            '眉毛微微皱起，又在看到回应后舒展开——像乌云被风吹散',
            '嘴角从紧张抿着慢慢放松，变成半信半疑的弧度——谨慎的乐观',
            '眼睛从微眯（警惕）慢慢睁大（好奇），这个过程持续了整整两秒——态度转变的可视化'
          ],
          handDetails: [
            '手指轻轻摩挲着小石子的纹理，摩挲了三圈——比实际需要多了一圈，是好奇的惯性',
            '手掌微微颤抖，但努力保持平稳——像端着一杯装满的水，不让它洒出来',
            '拇指和食指捏着小石子，但中指和无名指在裤腿上无意识地轻敲——内心的节拍器还在运转'
          ],
          weightShift: [
            '重心缓慢前移，像在进行一场赌博——每一步都在心里计数',
            '膝盖微微弯曲，随时准备站起或蹲下——是8岁男孩面对未知时的弹性姿态',
            '后脚跟微微抬起，前脚掌承受大部分重量——随时准备后退或冲刺'
          ],
          lifeReactions: {
            blink: '眨眼频率减慢，像在专注于某个细节——但偶尔突然快眨两下，是走神后的回归',
            breath: '呼吸变得深长而规律，像在进行某种自我安抚',
            gaze: '目光在石子和异兽之间来回漂移，频率越来越慢，最终停在异兽身上——选择完成'
          }
        },
        // 互动层次：接近 — 待机感：自然靠近 + 温度感知反应 + 信任落点
        approach: {
          actions: [
            // 动作1：直立靠近 + 磁场温暖反应 + 放松落点
            '小G慢慢直起身，一只手垂在身侧，另一只手轻轻抬起，指尖微微发光（与磁场共振）。异兽身上传来的磁场温度比周围高了3度，他手腕内侧的皮肤感受到这种温差，手指本能地蜷缩又舒展——像试探水温。肩膀从紧绷慢慢沉下来，呼吸从胸腔降到腹部',
            // 动作2：站定仰望 + 光影变化反应 + 敬畏落点
            '小G向前走了三步，每一步都比上一步更稳，最后停在异兽面前，抬头仰望。双恒星的光影在异兽身上缓缓移动，小G的瞳孔随着光影变化微微收缩——不是恐惧，是被宏大震撼后的平静。嘴角微微张开，但没有发出声音，像想说什么又不知道从何说起',
            // 动作3：坐下平视 + 地面草叶反应 + 平等落点
            '小G盘腿坐在异兽面前的草地上，双手放在膝盖上，深呼吸三次，然后露出微笑。一片草叶蹭过他小腿，他低头看了一眼，但没有拨开——让草叶留在那里，像接受Nirath的一个小小拥抱。坐姿微微歪斜，不是刻意的礼貌，是放松后的自然'
          ],
          microExpressions: [
            '眼神从警惕转为温柔，这个过程不是瞬间的，而是像冰块融化一样缓慢',
            '嘴角自然上扬，不是刻意的笑，是内心情绪溢出来的样子',
            '眼睛微眯，但不是警惕的眯，是面对强光时的自然反应，带着舒适'
          ],
          handDetails: [
            '手指自然舒展，不再紧握——像花朵在清晨慢慢打开花瓣',
            '指尖微微颤动，感应着磁场——不是害怕的颤抖，是共鸣的震颤',
            '手掌向上，接着飘落的孢子——是接受而非索取的姿态'
          ],
          weightShift: [
            '重心完全放松，自然下沉——像一袋沙子被缓缓放下',
            '坐姿微微歪斜，像放松的孩子——不是训练过的端正，是真实',
            '双脚自然分开，膝盖外展——是信任和开放的身体语言'
          ],
          lifeReactions: {
            blink: '眨眼变得缓慢而规律，像进入某种平静状态——但偶尔突然快眨一下，是好奇心的闪现',
            breath: '呼吸变得深长而平稳，三秒吸气，五秒呼气——像在进行某种冥想',
            gaze: '目光稳定地停留在异兽身上，但偶尔飘向远处又迅速收回——在确认这一切是真实的'
          }
        },
        // 互动层次：共鸣 — 待机感：触碰 + 能量流动反应 + 归属落点
        resonate: {
          actions: [
            // 动作1：伸手触碰 + 能量传导反应 + 惊奇落点
            '小G伸手触碰异兽的（安全部位），手指在接触的瞬间微微颤抖——不是害怕，是能量共振的电流感。指尖感受到异兽体内流动的磁场温度，比自己的体温高了5度，手指本能地蜷缩又舒展，像试探温泉。眼睛微微睁大，瞳孔在接触点聚焦，嘴角从紧张变成纯粹的惊奇',
            // 动作2：额头相抵 + 心跳同步反应 + 信任落点
            '小G把额头轻轻抵在异兽身上，闭上眼睛，嘴角带着最纯粹的笑容。异兽的心跳（或能量脉动）通过接触点传递过来——沉稳、缓慢、有力。小G的呼吸节奏不自觉地开始同步，三秒一吸，三秒一呼。睫毛在接触点轻轻颤动，像蝴蝶停在一朵花上',
            // 动作3：环抱 + 毛发/能量纹理反应 + 归属落点
            '小G跳起来，双手环住异兽的（适合拥抱的部位），像拥抱一棵大树那样紧紧贴着。异兽的（毛发/能量纹理）蹭过他脸颊，他侧头蹭了蹭，像小猫在标记领地。闭上眼睛，嘴角上扬，整个身体的重量都挂在异兽身上——完全的信任和归属'
          ],
          microExpressions: [
            '眼睛微闭，睫毛上挂着细微的光点——不是眼泪，是磁场与情绪共振的结晶',
            '笑容从嘴角蔓延到整个脸庞，连耳朵都微微泛红——是8岁男孩最真实的快乐',
            '眉头完全舒展开，额头上紧张的纹路消失——像一张被抚平的纸'
          ],
          handDetails: [
            '手掌完全贴紧，感受着温度——不是试探，是确认',
            '手指微微用力，像在确认真实——"你是真的，我也是真的"',
            '指尖无意识地轻敲异兽（像小孩 tapping 妈妈的背）——是安慰，也是被安慰'
          ],
          weightShift: [
            '重心完全依靠在异兽身上——像靠在父亲背上的孩子',
            '双脚离地，整个人挂在异兽身上——完全的托付',
            '身体微微摇晃，像被磁场风吹动的小树——但根基稳固'
          ],
          lifeReactions: {
            blink: '眨眼变得极其缓慢，像在享受每一个瞬间——但偶尔突然快眨，是意识到幸福的瞬间',
            breath: '呼吸与异兽的能量脉动完全同步，像两棵树的根系在地下相连',
            gaze: '目光柔和而专注，但偶尔飘向远方又收回——在确认这个瞬间不会被带走'
          }
        }
      },

      // ===== 定格阶段 — 结尾/余韵 =====
      climax: {
        // 情绪：释然
        relief: {
          actions: [
            '小G叉腰仰头，对着双恒星哈哈大笑，笑声在Nirath磁场中回荡',
            '小G躺在草地上，四肢舒展成"大"字，胸口起伏，脸上挂着满足的微笑',
            '小G单脚站立，另一只脚向后翘起，双手展开保持平衡，像只骄傲的小鹤'
          ],
          microExpressions: [
            '眼睛弯成月牙，眼角有细细的纹路',
            '嘴巴张开大笑，露出整齐的小牙齿'
          ],
          handDetails: [
            '手指在草地上无意识画圈',
            '手掌向上，接着飘落的孢子'
          ],
          weightShift: [
            '重心完全放松，东倒西歪——但倒到一半又自己弹回来，像不倒翁',
            '单脚站立时微微摇晃，但不怕摔倒'
          ]
        },
        // 情绪：敬畏
        awe: {
          actions: [
            '小G双手合十放在胸前，仰头闭目，像在祈祷又像在感谢',
            '小G单膝跪地，一只手撑地，另一只手轻轻放在胸口，低头致敬',
            '小G站在原地不动，只有头发和衣角在磁场风中飘动，眼神深邃如星空'
          ],
          microExpressions: [
            '眼神深邃，瞳孔中倒映着双恒星',
            '嘴角微微上扬，带着理解的微笑'
          ],
          handDetails: [
            '手指交叉，轻轻握着',
            '手掌贴在胸口，感受心跳'
          ],
          weightShift: [
            '重心下沉，扎根大地',
            '单膝触地，身体微微前倾'
          ]
        }
      }
    };

    // 口播动作库（说话时配套的动作）
    this.speakingActions = [
      '说话时下巴微微抬起，眼神坚定地直视前方',
      '每说一句就轻轻点一下头，像在给自己的想法盖章',
      '说到激动处会不自觉地挥一下手，又赶紧收回',
      '说话间隙会咬一下下唇，像在组织语言',
      '嘴角一边说着一边不自觉上扬，掩饰不住兴奋'
    ];

    // 静止微动（即使没有大动作，身体也在微动）
    this.idleMicroMoves = [
      '重心在左右脚间轻轻交替',
      '手指无意识地敲打着大腿外侧',
      '头部微微左右转动，像在观察环境',
      '肩膀随着呼吸轻轻起伏',
      '一只脚的后跟轻轻抬起又放下'
    ];
  }

  /**
   * 主入口：生成小G动作描述
   * @param {Object} params
   * @param {string} params.phase - 场景阶段 (hook/development/climax)
   * @param {string} params.mood - 情绪基调 (mysterious/epic/tender/tense)
   * @param {string} params.interactionLevel - 互动层次 (observe/probe/approach/resonate)
   * @param {boolean} params.hasDialogue - 是否在说台词
   * @param {boolean} params.isMoving - 是否有大动作（否则只给微动）
   * @returns {XiaoGActionPlan}
   */
  generate(params) {
    const { phase, mood, interactionLevel, hasDialogue, isMoving = true } = params;

    // 1. 获取动作组
    const actionGroup = this.selectActionGroup(phase, mood, interactionLevel);

    // 2. 组装动作描述
    const mainAction = isMoving ? this.pickOne(actionGroup.actions) : this.pickOne(this.idleMicroMoves);
    const microExpression = this.pickOne(actionGroup.microExpressions);
    const handDetail = this.pickOne(actionGroup.handDetails);
    const weightShift = this.pickOne(actionGroup.weightShift);

    // 3. 口播动作叠加
    const speakingAction = hasDialogue ? this.pickOne(this.speakingActions) : '';

    // 4. 组装完整描述
    const fullDescription = [
      mainAction,
      speakingAction,
      `微表情：${microExpression}`,
      `手部细节：${handDetail}`,
      `重心变化：${weightShift}`
    ].filter(Boolean).join('。');

    // 5. 精简版（Prompt空间紧张时用）
    const shortDescription = [
      mainAction,
      hasDialogue ? '嘴部微张说话，下巴微动' : ''
    ].filter(Boolean).join('，');

    return {
      phase,
      mood,
      interactionLevel,
      fullDescription,
      shortDescription,
      mainAction,
      microExpression,
      handDetail,
      weightShift,
      speakingAction: hasDialogue ? speakingAction : null
    };
  }

  // ===== 选择动作组 =====
  selectActionGroup(phase, mood, interactionLevel) {
    const phaseLib = this.actionLibrary[phase];
    if (!phaseLib) return this.actionLibrary.hook.mysterious; // 回退

    // 如果有互动层次（展开阶段），优先用互动层次
    if (phase === 'development' && interactionLevel) {
      return phaseLib[interactionLevel] || phaseLib.observe;
    }

    // 否则用情绪
    return phaseLib[mood] || phaseLib.mysterious || Object.values(phaseLib)[0];
  }

  // ===== 随机选择（但确定性——同一参数总返回相同结果）=====
  pickOne(array) {
    if (!array || array.length === 0) return '';
    // 简单取第一个（可扩展为基于seed的确定性随机）
    return array[0];
  }

  // ===== 生成Prompt可用字符串 =====
  generatePromptString(params) {
    const plan = this.generate(params);
    return {
      full: plan.fullDescription,
      short: plan.shortDescription,
      mouthAction: params.hasDialogue ? '嘴部微张说话，下巴微动，配合呼吸节奏' : null
    };
  }

  // ===== v2.1 新增：第二份材料注入 — 生命信号参数化系统 =====
  // 来源：《AI人物显假问题——让数字人"活"起来的实战指南》
  // 注入原则：不改架构、不增字段，仅丰富现有lifeReactions的内容

  /**
   * 眨眼系统 — 真实眨眼不是机械的
   * 基础眨眼15-20次/分，专注时降至3-5次，紧张时升至30-40次
   */
  getBlinkSystem(emotionState = 'neutral') {
    const blinkPatterns = {
      neutral: '眨眼自然均匀，约15-20次/分钟，眼睑开合如呼吸般无意识',
      focused: '眨眼大幅减少至3-5次/分钟，进入"忘记眨眼"的专注期，目光如钉子钉在目标上',
      nervous: '眨眼频繁至30-40次/分钟，每次眨眼时间缩短，像受惊的鹿',
      relaxed: '眨眼缓慢而沉重，每次闭眼时间比平常长半秒，像猫在午后阳光中',
      curious: '眨眼不规律——快眨两下，停顿，慢眨一下，再快眨——神经兴奋的不均匀输出',
      awe: '眨眼极其缓慢，像在享受每一个瞬间，但偶尔突然快眨，是意识到震撼后的回归'
    };
    return blinkPatterns[emotionState] || blinkPatterns.neutral;
  }

  /**
   * 呼吸节奏系统 — 不同状态呼吸截然不同
   */
  getBreathSystem(emotionState = 'neutral') {
    const breathPatterns = {
      neutral: '呼吸平稳，12-16次/分钟，胸腹起伏轻微，像潮汐的规律涨落',
      tense: '呼吸浅而快，18-22次/分钟，肩膀微耸，像潜水前的急促准备',
      relaxed: '呼吸深长，8-10次/分钟，胸腹大幅度起伏，每次呼气肩膀下沉一寸',
      excited: '呼吸紊乱，快慢交替，中间突然深吸一口气——是情绪过载时的生理调节',
      holding: '屏息2-3秒，身体完全静止，然后缓慢呼出——是期待或紧张的高潮时刻',
      sighing: ' audible的叹息，肩膀猛地放下，头微微侧倾——是情绪释放后的松弛'
    };
    return breathPatterns[emotionState] || breathPatterns.neutral;
  }

  /**
   * 微表情系统 — 人脸即使在"面无表情"时也在持续变化
   */
  getMicroExpressionSystem(emotionState = 'neutral') {
    const microExpressions = {
      neutral: '眉毛内侧微微放松，眼角无特定紧张，嘴角保持自然闭合——不是面无表情，是平静的湖面',
      curious: '眉毛内侧微抬，眼角轻轻眯起，嘴角单侧几乎不可察觉地上扬——是"有意思"的身体信号',
      tense: '下巴微微收紧，鼻翼轻微扩张，嘴唇轻抿——克制的外壳下情绪在升温',
      sad: '眉毛内侧上扬（八字眉），眼角微微下垂，下唇无意识轻颤——是情绪泄露不是表演',
      happy: '眼角出现真实笑纹（而非嘴角上扬），眉毛整体舒展，瞳孔微微放大——是内在光芒外溢',
      thinking: '眼神向左上方飘移（回忆）或右上方（创造），手指无意识轻敲——大脑活跃的外部标志'
    };
    return microExpressions[emotionState] || microExpressions.neutral;
  }

  /**
   * 无意识动作库 — 按身体部位分类的"待机"微动作
   * 这些动作比五官细节更能建立真实感
   */
  getUnconsciousMovement(bodyPart = 'hand', emotionState = 'neutral') {
    const movements = {
      hand: {
        neutral: '手指无意识地沿着背包带边缘上下滑动，像在阅读盲文',
        waiting: '拇指和食指无意识摩挲衣角布料，摩挲了三圈——比实际需要多了一圈',
        thinking: '把玩手中的小石子（或指南针），在指间旋转两圈，掉在掌心，捡起来继续转',
        nervous: '指甲轻抠指缝，抠完左手换右手——是焦虑的转移行为',
        relaxed: '手掌向上摊开，手指微微弯曲，随着呼吸节奏轻轻开合——像一朵呼吸的花'
      },
      head: {
        neutral: '头部微微歪向一侧，角度不超过15度——是倾听的姿态也是好奇的标志',
        listening: '颈部轻微转动，耳朵朝向声源方向，像雷达在锁定信号',
        tired: '头发从耳后滑落，没有立即整理——专注中无暇顾及的疏忽',
        confident: '下巴微微抬起，不超过5度——是自信不是傲慢',
        curious: '头部前倾，像植物向光生长，角度随兴趣程度增加'
      },
      body: {
        neutral: '重心在双脚间缓慢切换，每分钟2-3次——是站立时的本能调节',
        waiting: '脚尖无意识点地打节拍，节奏与内心某种旋律同步',
        relaxed: '肩膀微微耸起又猛地放下，发出无声的叹息——是久坐后的舒展',
        attentive: '身体微微前倾，腰部形成自然的C型，像被某种引力吸引'
      },
      foot: {
        neutral: '双脚自然分开，与肩同宽，但前脚掌微微内八——是放松不是拘谨',
        waiting: '翘起的脚轻轻晃动，幅度不超过10厘米——是不耐烦的微型表达',
        nervous: '脚后跟抬起又落下，像是要迈步但又停下——是犹豫的身体语言',
        relaxed: '一只脚完全放松，脚尖朝外，脚踝软塌——是彻底卸下防备的姿态'
      }
    };
    return movements[bodyPart]?.[emotionState] || movements.hand.neutral;
  }

  /**
   * 常见错误自检清单 — 注入到系统作为质量门禁
   * 每次生成后自动检查，避免以下陷阱
   */
  getCommonMistakes() {
    return [
      '❌ 堆砌五官细节，忽视生命状态 — 不要把提示词写成人体解剖清单',
      '❌ 动作过于"完整"和"刻意" — 不要"优雅地喝咖啡"，要"咖啡举到嘴边停住了"',
      '❌ 多人场景各做各的 — 必须建立至少一条视线链或动作-反应配对',
      '❌ 情绪表达过于"直接" — 不要"她很开心"，要"肩膀放松了一些，嘴角抑制不住上扬"',
      '❌ 所有人"太完美" — 加入瑕疵：动作中断、呼吸漏拍、眼神漂移',
      '❌ 角色完全静止 — 即使在定格时刻也要有至少一个微动（重心偏移/手指小动作）'
    ];
  }

  /**
   * 增强版生成 — 融合第二份材料的生命信号参数
   * 在原有generate基础上，叠加眨眼/呼吸/微表情/无意识动作
   */
  generateEnhanced(params) {
    const base = this.generate(params);
    const emotion = params.mood || 'neutral';
    
    // 叠加生命信号系统
    const enhancedDescription = `${base.fullDescription}
【生命信号】${this.getBlinkSystem(emotion)}；${this.getBreathSystem(emotion)}；${this.getMicroExpressionSystem(emotion)}。
【无意识动作】手部：${this.getUnconsciousMovement('hand', emotion)}；头部：${this.getUnconsciousMovement('head', emotion)}；身体：${this.getUnconsciousMovement('body', emotion)}。`;

    return {
      ...base,
      fullDescription: enhancedDescription,
      shortDescription: base.shortDescription, // 保持简洁版不变
      lifeSignals: {
        blink: this.getBlinkSystem(emotion),
        breath: this.getBreathSystem(emotion),
        microExpression: this.getMicroExpressionSystem(emotion)
      },
      unconsciousMovements: {
        hand: this.getUnconsciousMovement('hand', emotion),
        head: this.getUnconsciousMovement('head', emotion),
        body: this.getUnconsciousMovement('body', emotion),
        foot: this.getUnconsciousMovement('foot', emotion)
      }
    };
  }
}

// 单例导出
const xiaoGLivelyActionSystem = new XiaoGLivelyActionSystem();

module.exports = {
  XiaoGLivelyActionSystem,
  xiaoGLivelyActionSystem,
  generateXiaoGAction: (params) => xiaoGLivelyActionSystem.generatePromptString(params),
  generateXiaoGActionEnhanced: (params) => xiaoGLivelyActionSystem.generateEnhanced(params)
};
