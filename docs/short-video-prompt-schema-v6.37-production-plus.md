# 卓越视频系统 - 短片提示词数据结构

**版本**: v6.37-production+  
**日期**: 2026-06-13  
**系统**: 卓越视频生成系统 (Hyperreality System / 示例世界MasterPipeline)  
**定位**: 工业级可执行管线标准，整合结构化字段、优先级策略、扩展能力  
**状态**: 生产版本（已推送 GitHub: v6.37-Peng-optimized）

---

## 一、顶层结构

每个短片包含一个 `meta` 元信息对象和一组 `shots` 镜头数组。

```json
{
  "meta": { ... },
  "shots": [
    { ... },  // S00 片头（18字段）
    { ... },  // S01 正片镜头（17字段）
    { ... },  // S02 正片镜头（17字段）
    ...
  ]
}
```

---

## 二、Meta 字段（7字段）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| title | string | 是 | 短片标题，如 "示例项目：神兽" |
| worldview | string | 是 | 世界观标识：fantasy / earth / cyberpunk |
| totalDuration | number | 是 | 总时长（秒），如 60-90 |
| openingDuration | number | 是 | 片头时长（秒），推荐 8-12 |
| fps | number | 是 | 帧率，默认 24 |
| resolution | string | 是 | 分辨率，如 "1920x1080" |
| styleNotes | string | 否 | 风格备注，如 "cinematic, hyperrealistic, film grain" |

**Meta 示例：**

```json
{
  "title": "示例项目：神兽",
  "worldview": "fantasy",
  "totalDuration": 60,
  "openingDuration": 10,
  "fps": 24,
  "resolution": "1920x1080",
  "styleNotes": "cinematic, hyperrealistic, film grain"
}
```

---

## 三、片头镜头 S00（18字段）

片头负责建立世界观、情绪基调，通常无角色台词（dialogue 为 NONE），但必须有 audioLayer 和 titleOverlay。

| # | 字段 | 类型 | 必填 | 优先级 | 说明 |
|---|------|------|------|--------|------|
| 1 | shotId | string | 是 | - | 固定 "S00" |
| 2 | duration | number | 是 | - | 时长（秒），8-12 秒 |
| 3 | scene | string | 是 | P1 | 五维空间描述（宏观+中观+微观+时间+深度） |
| 4 | mood | string | 是 | P2 | 3-5个情绪关键词，逗号分隔 |
| 5 | camera | object | 是 | P1 | 结构化相机参数（见第六章） |
| 6 | cameraString | string | 是 | P1 | camera 的字符串版本，用于 Prompt 融合 |
| 7 | lighting | object | 是 | P1 | 结构化光照参数（见第六章） |
| 8 | lightingString | string | 是 | P1 | lighting 的字符串版本 |
| 9 | characterRef | string | 否 | P0 | 定妆照引用，片头通常 "NONE" |
| 10 | character | string | 否 | P0 | 角色极简锚点，片头通常 "NONE" |
| 11 | action | string | 是 | P1 | 核心动词+交互目标，描述镜头动态 |
| 12 | dialogue | string | 否 | P0 | 统一格式台词，片头通常 "NONE" |
| 13 | timeline | object | 是 | P2 | 结构化时间轴（见第六章） |
| 14 | timelineString | string | 是 | P2 | timeline 的字符串版本 |
| 15 | audioLayer | object | 是 | P1 | 片头专属：四段式音频层设计 |
| 16 | audioLayerString | string | 是 | P1 | audioLayer 的字符串版本 |
| 17 | titleOverlay | object | 是 | P0 | 片头专属：结构化标题叠加 |
| 18 | titleOverlayString | string | 是 | P0 | titleOverlay 的字符串版本 |
| 19 | backgroundSound | object | 是 | P1 | 三段式环境音效（见第六章） |
| 20 | backgroundSoundString | string | 是 | P1 | backgroundSound 的字符串版本 |
| 21 | prompt | string | 是 | - | 最终融合后的完整提示词（≤1500 字符） |
| 22 | promptCharCount | number | 是 | - | prompt 字符计数 |
| - | mouthAction | string | 否 | - | 嘴部动作（Seedance 对口型） |
| - | priorities | object | 否 | - | 字段优先级元数据 |

> **注**：promptCharCount 在输出时计算，不作为输入字段。带 `-` 的行为系统内部扩展字段。

---

## 四、正片镜头 S01+（17字段）

正片镜头包含叙事内容、角色表演、对话等。相比片头，缺少 audioLayer 和 titleOverlay（S01 可选保留 audioLayer 延续片头声音）。

| # | 字段 | 类型 | 必填 | 优先级 | 说明 |
|---|------|------|------|--------|------|
| 1 | shotId | string | 是 | - | S01, S02, ... |
| 2 | duration | number | 是 | - | 时长（秒），过渡 8-10s，核心 12-15s |
| 3 | scene | string | 是 | P1 | 五维空间描述 |
| 4 | mood | string | 是 | P2 | 3-5个情绪关键词，逗号分隔 |
| 5 | camera | object | 是 | P1 | 结构化相机参数 |
| 6 | cameraString | string | 是 | P1 | camera 字符串版本 |
| 7 | lighting | object | 是 | P1 | 结构化光照参数 |
| 8 | lightingString | string | 是 | P1 | lighting 字符串版本 |
| 9 | characterRef | string | 是 | P0 | 定妆照引用，格式见规范 |
| 10 | character | string | 是 | P0 | 角色极简锚点（种族+3-5关键词） |
| 11 | action | string | 是 | P1 | 核心动词+交互目标 |
| 12 | dialogue | string | 是 | P0 | 统一格式台词 |
| 13 | timeline | object | 是 | P2 | 结构化时间轴 |
| 14 | timelineString | string | 是 | P2 | timeline 字符串版本 |
| 15 | backgroundSound | object | 是 | P1 | 三段式环境音效 |
| 16 | backgroundSoundString | string | 是 | P1 | backgroundSound 字符串版本 |
| 17 | prompt | string | 是 | - | 最终融合提示词（≤1500 字符） |
| 18 | promptCharCount | number | 是 | - | prompt 字符计数 |
| - | mouthAction | string | 否 | - | 嘴部动作（Seedance 对口型） |
| - | priorities | object | 否 | - | 字段优先级元数据 |

---

## 五、字段优先级与截断策略

当总提示词超过 1500 字符时，按优先级从低到高截断。**P0 字段永不截断，P1 尽量保留核心，P2 可截断但保留最少信息。**

| 字段 | 优先级 | 截断策略 | 策略说明 |
|------|--------|----------|----------|
| characterRef | P0 | never | 定妆照路径绝对不能丢 |
| dialogue | P0 | keep_core_dialogue | 可压缩但不可删除整句 |
| titleOverlay | P0 | never | 片头标题信息不截断 |
| character | P0 | minimal_anchor_only | 仅保留角色名 + 3 个核心关键词 |
| camera | P1 | keep_core_movement | 保留 shotSize + movement |
| lighting | P1 | keep_main_light_temp | 保留主光方向 + 色温数值 |
| action | P1 | keep_core_verb_object | 保留动词 + 目标名词 |
| scene | P1 | keep_core_location | 保留地点 + 2 个材质细节 |
| backgroundSound | P1 | keep_core_sound | 保留 ambient + intensity |
| audioLayer | P1 | keep_core_audio | 保留前两个音效段 |
| mood | P2 | keyword_list | 保留前 3 个情绪词 |
| timeline | P2 | keep_duration_type | 保留 duration + type |
| physicsLayer | P2 | keep_gravity | 仅保留 gravity |
| negativePrompt | P2 | keep_top_3 | 保留前 3 个禁止词 |

**截断顺序**：从最低优先级（P2）中按字段出现顺序截断。实际实现中由管线自动处理。

---

## 六、结构化子对象详解

### 6.1 camera 对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| shotSize | string | 是 | 12级景别之一（见词汇表） |
| movement | string | 是 | 14种运镜之一（见词汇表） |
| lens | string | 是 | 焦距，如 "24mm", "85mm" |
| speed | number/string | 是 | 速度，0.1-2.0 或 "slow motion" |
| aperture | string | 否 | 光圈，如 "f/2.8" |
| focus | string | 否 | 对焦方式，如 "rack focus from A to B" |

**camera 示例：**

```json
{
  "shotSize": "extreme wide",
  "movement": "dolly in",
  "lens": "24mm",
  "speed": 0.3,
  "aperture": "f/2.8",
  "focus": "rack focus from atmosphere to ground"
}
```

**cameraString 示例：**
```
extreme wide shot, dolly in, 24mm lens, speed 0.3
```

### 6.2 lighting 对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| keyLight | object | 是 | 主光：direction, colorTemp, effect |
| fillLight | object | 否 | 补光：同上 |
| special | string | 否 | 特效光，如 "volumetric god rays" |

**lighting 示例：**

```json
{
  "keyLight": {
    "direction": "backlight",
    "colorTemp": 3200,
    "effect": "golden hour rim"
  },
  "fillLight": {
    "direction": "ambient",
    "colorTemp": 6500,
    "effect": "cool fill"
  },
  "special": "volumetric god rays"
}
```

**lightingString 示例：**
```
backlight 3200K, golden hour rim, ambient 6500K, cool fill, volumetric god rays
```

### 6.3 timeline 对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| start | string | 是 | "T00:00" 格式 |
| end | string | 是 | "T00:10" 格式 |
| duration | number | 是 | 秒 |
| type | string | 是 | opening / establishing / transition / climax / closing |
| mood | string | 是 | 情绪标签（可与 mood 字段同步） |

**timeline 示例：**

```json
{
  "start": "T00:00",
  "end": "T00:10",
  "duration": 10,
  "type": "opening",
  "mood": "epic"
}
```

**timelineString 示例：**
```
T00:00-T00:10 / duration: 10s / type: opening / mood: epic
```

### 6.4 backgroundSound 对象

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| ambient | string | 是 | 环境基底声，含频率范围建议 |
| spatial | string | 否 | 空间定位，如 "3D audio pan L-R" |
| intensity | object | 是 | crescendo, peak, decay 时间区间 |

**backgroundSound 示例：**

```json
{
  "ambient": "deep earth rumble 20-60Hz, epic atmosphere",
  "spatial": "3D audio pan synchronized with camera movement",
  "intensity": {
    "crescendo": "0-3s",
    "peak": "3-7s",
    "decay": "7-10s"
  }
}
```

**backgroundSoundString 示例：**
```
AMBIENT: deep earth rumble 20-60Hz, epic atmosphere | SPATIAL: 3D audio pan synchronized with camera movement | INTENSITY: crescendo 0-3s, peak 3-7s, decay 7-10s
```

### 6.5 audioLayer 对象（片头专属）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| segments | array | 是 | 音效段数组 |

**audioLayer 示例：**

```json
{
  "segments": [
    { "time": "0-3s", "sound": "sub-bass earth rumble fade in" },
    { "time": "3-5s", "sound": "distant wind + sand particles" },
    { "time": "5-8s", "sound": "string section long note" },
    { "time": "8-10s", "sound": "timpani strike" }
  ]
}
```

**audioLayerString 示例：**
```
Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s
```

### 6.6 titleOverlay 对象（片头专属）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| mainTitle | string | 是 | 主标题 |
| subtitle | string | 是 | 副标题/系列名 |
| producer | string | 是 | 制作人 |
| titleAnim | string | 是 | 标题动画描述 |

**titleOverlay 示例：**

```json
{
  "mainTitle": "示例项目：神兽",
  "subtitle": "示例世界",
  "producer": "by 示例制作人",
  "titleAnim": "light-vein carving growth 3.0-5.0s"
}
```

**titleOverlayString 示例：**
```
MAIN_TITLE: "示例项目：神兽" | SUBTITLE: "示例世界" | PRODUCER: "by 示例制作人" | TITLE_ANIM: light-vein carving growth 3.0-5.0s
```

---

## 七、扩展字段（PhysicsLayer / ColorScience / NegativePrompt 等）

这些字段为可选扩展，融合时插入 L8（内部层）或 L9（质控层）。

### 7.1 physicsLayer 对象

```json
{
  "gravity": 0.82,
  "magneticField": 3.2,
  "dualStarTemp": [5800, 6500],
  "atmosphere": "volumetric scattering with dust particles"
}
```

### 7.2 colorScience 字符串或对象

```json
{
  "colorScience": "golden_hour"
}
// 或
{
  "colorScience": {
    "palette": "teal_orange",
    "contrast": 1.2
  }
}
```

### 7.3 negativePrompt 字符串

```json
{
  "negativePrompt": "no text, no watermark, no cartoon, no distorted face, no duplicate character"
}
```

### 7.4 renderStyle / directorStyle 字符串

```json
{
  "renderStyle": "hyperrealistic, film grain, 35mm texture",
  "directorStyle": "Denis Villeneuve, slow pacing, wide composition"
}
```

---

## 八、Prompt 融合顺序（L1-L9）

最终 prompt 字段按以下顺序拼接，确保优先级和结构清晰。

| 层级 | 名称 | 来源字段 | 示例内容 |
|------|------|----------|----------|
| L1 | 约束层 | 固定前缀 | 16:9 cinematic, no text, no subtitle, no caption, no watermark, 24fps |
| L2 | 基础层 | 固定前缀 | hyperrealistic, ultra-detailed, HDR, film grain, 35mm texture |
| L3 | 空间层 | scene | 五维空间描述字符串 |
| L4 | 主体层 | character + action + dialogue | 角色锚点 → 动作 → 台词（统一格式） |
| L5 | 动态层 | cameraString + timelineString | 相机参数 + 时间轴标记 |
| L6 | 风格层 | mood + lightingString | 情绪词列表 + 光照描述 |
| L7 | 音频层 | backgroundSoundString + audioLayerString + titleOverlayString | 音效、片头音频、标题（仅片头） |
| L8 | 内部层 | physicsLayer + colorScience + renderStyle | 物理、色彩、渲染风格 |
| L9 | 质控层 | negativePrompt | 负面约束 |

**融合代码逻辑（伪代码）：**

```javascript
const parts = [];

// L1: 约束层（P0）
parts.push("16:9 cinematic, no text, no subtitle, no caption, no watermark, 24fps cinematic");

// L2: 基础层（P0）
parts.push("hyperrealistic, ultra-detailed, high dynamic range, detail in highlights and shadows, film grain, 35mm texture, cinematic film");

// L3: 空间层（P1）
parts.push(scene);

// L4: 主体层（P0-P1）
parts.push(character);
parts.push(action);
if (dialogue !== "NONE") parts.push(`dialogue: ${dialogue}`);

// L5: 动态层（P1-P2）
parts.push(cameraString);
parts.push(`timeline: ${timelineString}`);

// L6: 风格层（P1-P2）
parts.push(`mood: ${mood}`);
parts.push(lightingString);

// L7: 音频层（P1）
parts.push(`audio: ${backgroundSoundString}`);
if (audioLayerString) parts.push(`audioLayer: ${audioLayerString}`);

// L8: 内部层（P2）
if (physicsLayer) parts.push(`physics: ${formatPhysics(physicsLayer)}`);
if (colorScience) parts.push(`color: ${colorScience}`);

// L9: 质控层（P0）
parts.push(negativePrompt);

const prompt = parts.join("，");

// 优先级截断（超1500字符时）
if (prompt.length > 1500) {
  prompt = applyTruncation(prompt, priorities);
}
```

---

## 九、硬约束与规范

### 9.1 字符与长度

- **prompt 字段**：≤1500 字符（中文≤500字），建议 900-1350 字符（利用率 60%-90%）。
- **单句台词**：≤50 字。

### 9.2 语言规范

- **所有非 dialogue 字段**（scene, action, camera, lighting, backgroundSound 等）必须使用英文。
- **dialogue 的 TEXT** 使用中文，其余部分英文。
- **characterRef** 中的路径可保留原字符。

### 9.3 台词规则（P0）

- **统一格式**：`SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES`
  - 示例：`示例角色|独白|好奇|这就是示例神兽的领地吗？|LIP_SYNC:YES`
- **TYPE 仅允许**：独白 / 对白 / 呼喊
- **严禁**：旁白 或 Voiceover
- **必须包含**：`LIP_SYNC:YES`

### 9.4 角色锚点规则（P0）

- **格式**：`角色名: 种族/物种, 视觉关键词1, 视觉关键词2, 视觉关键词3`（至少 3 个，最多 5 个）
- **禁止**：详细描述（如“十五米高的巨型身躯”）、超过 2 个颜色词、完整外貌描写
- **示例（正）**：`示例神兽: lion-like beast, vertical eye, three white-flame tails, golden hooves`
- **示例（误）**：`示例神兽: 一只白色神兽，十五米高，有三根尾巴，额头上有一只竖眼，金色的蹄子，全身散发着光芒` ❌

### 9.5 镜头词汇表（统一术语）

**景别（12 级）：**

```
extreme wide, wide, medium wide, medium, medium close, close, extreme close, macro, bird's eye, low angle, over shoulder, POV
```

**运镜（14 种）：**

```
static, pan, tilt, dolly in, dolly out, truck, pedestal, crane, handheld, orbit, arc, rack focus, zoom in, zoom out
```

**焦距**：24mm(广角), 35mm(标准), 50mm(人眼), 85mm(肖像), 135mm(长焦), macro

### 9.6 音效设计框架（参考 Murch）

- **层次优先级**：对白 > 音效 > 音乐
- **频率分离建议**：20-200Hz（低音氛围）、200-2kHz（主体）、2k-20kHz（高频细节）
- **叙事功能**：establishing / transitional / emotional cue / tension builder / release

### 9.7 片头与正片差异速查表

| 特性 | 片头 S00 | 正片 S01+ |
|------|----------|-----------|
| 台词 | 通常 NONE | 通常有台词 |
| audioLayer | 有（四段式） | 无（但可延续片头） |
| titleOverlay | 有 | 无 |
| characterRef | 通常 NONE | 有 |
| character | 通常 NONE | 有 |
| 时长建议 | 8-12s | 过渡8-10s / 核心12-15s |

---

## 十、完整示例 JSON

### 示例 1：片头 S00

```json
{
  "shotId": "S00",
  "duration": 10,
  "scene": "示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite",
  "mood": "epic, mysterious, awe-inspiring",
  "camera": {
    "shotSize": "extreme wide",
    "movement": "dolly in",
    "lens": "24mm",
    "speed": 0.3,
    "aperture": "f/2.8",
    "focus": "rack focus from atmosphere to ground"
  },
  "cameraString": "extreme wide shot, dolly in, 24mm lens, speed 0.3",
  "lighting": {
    "keyLight": { "direction": "backlight", "colorTemp": 3200, "effect": "golden hour rim" },
    "fillLight": { "direction": "ambient", "colorTemp": 6500, "effect": "cool fill" },
    "special": "volumetric god rays"
  },
  "lightingString": "backlight 3200K, golden hour rim, ambient 6500K, cool fill, volumetric god rays",
  "characterRef": "NONE",
  "character": "NONE",
  "action": "camera descends through mist layers, establishing the world",
  "dialogue": "NONE",
  "timeline": {
    "start": "T00:00",
    "end": "T00:10",
    "duration": 10,
    "type": "opening",
    "mood": "epic"
  },
  "timelineString": "T00:00-T00:10 / duration: 10s / type: opening / mood: epic",
  "audioLayer": {
    "segments": [
      { "time": "0-3s", "sound": "sub-bass earth rumble fade in" },
      { "time": "3-5s", "sound": "distant wind + sand particles" },
      { "time": "5-8s", "sound": "string section long note" },
      { "time": "8-10s", "sound": "timpani strike" }
    ]
  },
  "audioLayerString": "Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s",
  "titleOverlay": {
    "mainTitle": "示例项目：神兽",
    "subtitle": "示例世界",
    "producer": "by 示例制作人",
    "titleAnim": "light-vein carving growth 3.0-5.0s"
  },
  "titleOverlayString": "MAIN_TITLE: \"示例项目：神兽\" | SUBTITLE: \"示例世界\" | PRODUCER: \"by 示例制作人\" | TITLE_ANIM: light-vein carving growth 3.0-5.0s",
  "backgroundSound": {
    "ambient": "deep earth rumble 20-60Hz, epic atmosphere",
    "spatial": "3D audio pan synchronized with camera movement",
    "intensity": { "crescendo": "0-3s", "peak": "3-7s", "decay": "7-10s" }
  },
  "backgroundSoundString": "AMBIENT: deep earth rumble 20-60Hz, epic atmosphere | SPATIAL: 3D audio pan synchronized with camera movement | INTENSITY: crescendo 0-3s, peak 3-7s, decay 7-10s",
  "prompt": "16:9 cinematic, no text, no watermark, 24fps cinematic，hyperrealistic, ultra-detailed, high dynamic range, detail in highlights and shadows, film grain, 35mm texture, cinematic film，示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite，establishing shot, camera slowly descending through atmospheric layers，dialogue: NONE，epic wide shot, slow descent through atmospheric layers, 24mm wide lens, slow speed，timeline: T00:00-T00:10 / duration: 10s / type: opening / mood: epic，mood: epic, mysterious, awe-inspiring，backlight 3200K, golden hour rim, volumetric god rays，no watermark, no logo, no text overlay, no subtitle, no caption，blurry, low resolution, pixelated, compression artifacts，cartoon, anime, illustration, 3D render look, CGI appearance, plastic look，distorted perspective, impossible geometry, floating objects，flat lighting, overexposed, crushed blacks, double shadows，unnatural physics, fake water, static water, cardboard texture, plastic foliage，distorted face, deformed face, extra fingers, plastic skin, waxy skin, unnatural pose",
  "promptCharCount": 1116,
  "mouthAction": "嘴部自然闭合，面对镜头，准备开口",
  "priorities": {
    "characterRef": "P0-never",
    "dialogue": "P0-keep_core",
    "character": "P0-minimal_anchor",
    "camera": "P1-keep_core_movement",
    "action": "P1-keep_core_verb",
    "scene": "P1-keep_core_location",
    "lighting": "P1-keep_main_light",
    "backgroundSound": "P1-keep_core_sound",
    "mood": "P2-keyword_list",
    "timeline": "P2-keep_duration_type"
  }
}
```

### 示例 2：正片镜头 S01

```json
{
  "shotId": "S01",
  "duration": 15,
  "scene": "示例世界, 知识圣殿, hexagonal stone pillars, bioluminescent fungi, spatial depth: atmospheric perspective",
  "mood": "mysterious, anticipation, wonder",
  "camera": {
    "shotSize": "medium",
    "movement": "static",
    "lens": "35mm",
    "speed": 1.0,
    "aperture": "f/2.8",
    "focus": "normal"
  },
  "cameraString": "medium shot, static, 35mm lens, speed 1",
  "lighting": {
    "keyLight": { "direction": "front", "colorTemp": 4500, "effect": "neutral balanced" },
    "fillLight": { "direction": "ambient", "colorTemp": 4500, "effect": "soft fill" },
    "special": ""
  },
  "lightingString": "front 4500K, neutral balanced, ambient 4500K, soft fill",
  "characterRef": "示例角色: image://characters/示例角色-front.png, image://characters/示例角色-profile.png | 示例神兽: image://characters/示例神兽-front.png, image://characters/示例神兽-profile.png",
  "character": "示例角色: Human, explorer, curious, brave | 示例神兽: Beast, white fur, mythical, wise",
  "action": "protagonist steps forward, observing surroundings with focused gaze",
  "dialogue": "示例角色|独白|好奇|这就是示例神兽的领地吗？|LIP_SYNC:YES",
  "timeline": {
    "start": "T00:10",
    "end": "T00:25",
    "duration": 15,
    "type": "establishing",
    "mood": "mysterious"
  },
  "timelineString": "T00:10-T00:25 / duration: 15s / type: establishing / mood: mysterious",
  "backgroundSound": {
    "ambient": "natural environment, wind and distant sounds 200-2kHz",
    "spatial": "ambient stereo field",
    "intensity": { "crescendo": "0-5s", "peak": "5-10s", "decay": "10-15s" }
  },
  "backgroundSoundString": "AMBIENT: natural environment, wind and distant sounds 200-2kHz | SPATIAL: ambient stereo field | INTENSITY: crescendo 0-5s, peak 5-10s, decay 10-15s",
  "prompt": "16:9 cinematic, no text, no watermark, 24fps cinematic，hyperrealistic, ultra-detailed, high dynamic range, detail in highlights and shadows, film grain, 35mm texture, cinematic film，示例世界, 知识圣殿, hexagonal stone pillars, bioluminescent fungi, spatial depth: atmospheric perspective，示例角色: Human, explorer, curious, brave | 示例神兽: Beast, white fur, mythical, wise，protagonist steps forward, observing surroundings with focused gaze，dialogue: 示例角色|独白|好奇|这就是示例神兽的领地吗？|LIP_SYNC:YES，medium shot, static, 35mm lens, speed 1，timeline: T00:10-T00:25 / duration: 15s / type: establishing / mood: mysterious，mood: mysterious, anticipation, wonder，front 4500K, neutral balanced, ambient 4500K, soft fill，fantasy world，no watermark, no logo, no text overlay, no subtitle, no caption，blurry, low resolution, pixelated, compression artifacts，cartoon, anime, illustration, 3D render look, CGI appearance, plastic look，distorted perspective, impossible geometry, floating objects，flat lighting, overexposed, crushed blacks, double shadows，unnatural physics, fake water, static water, cardboard texture, plastic foliage，distorted face, deformed face, extra fingers, plastic skin, waxy skin, unnatural pose，natural eye colors only, no metallic shine，角色一致性：保持示例角色、示例神兽形象一致，杜绝分身重影",
  "promptCharCount": 1252,
  "mouthAction": "嘴部微张，观察时自然呼吸",
  "importance": 5,
  "visualComplexity": 5,
  "qualityScore": { "totalScore": 75 },
  "enhanced": true,
  "physicsLayer": "",
  "colorScience": "",
  "negativePrompt": "",
  "renderStyle": "",
  "directorStyle": "",
  "priorities": {
    "characterRef": "P0-never",
    "dialogue": "P0-keep_core",
    "character": "P0-minimal_anchor",
    "camera": "P1-keep_core_movement",
    "action": "P1-keep_core_verb",
    "scene": "P1-keep_core_location",
    "lighting": "P1-keep_main_light",
    "backgroundSound": "P1-keep_core_sound",
    "mood": "P2-keyword_list",
    "timeline": "P2-keep_duration_type"
  }
}
```

### 顶层 Meta + Shots 完整结构

```json
{
  "meta": {
    "title": "示例项目：神兽",
    "worldview": "fantasy",
    "totalDuration": 60,
    "openingDuration": 10,
    "fps": 24,
    "resolution": "1920x1080",
    "styleNotes": "cinematic, hyperrealistic, film grain"
  },
  "shots": [
    // S00 片头（18字段）
    {
      "shotId": "S00",
      "duration": 10,
      "scene": "示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite",
      "mood": "epic, mysterious, awe-inspiring",
      "camera": { "shotSize": "extreme wide", "movement": "dolly in", "lens": "24mm", "speed": 0.3 },
      "cameraString": "extreme wide shot, dolly in, 24mm lens, speed 0.3",
      "lighting": { "keyLight": { "direction": "backlight", "colorTemp": 3200, "effect": "golden hour rim" } },
      "lightingString": "backlight 3200K, golden hour rim",
      "characterRef": "NONE",
      "character": "NONE",
      "action": "camera descends through mist layers",
      "dialogue": "NONE",
      "timeline": { "start": "T00:00", "end": "T00:10", "duration": 10, "type": "opening", "mood": "epic" },
      "timelineString": "T00:00-T00:10 / duration: 10s / type: opening / mood: epic",
      "audioLayer": { "segments": [{"time":"0-3s","sound":"sub-bass earth rumble"}] },
      "audioLayerString": "sub-bass earth rumble",
      "titleOverlay": { "mainTitle": "示例项目：神兽", "subtitle": "示例世界", "producer": "by 示例制作人" },
      "titleOverlayString": "MAIN_TITLE: \"示例项目：神兽\" | SUBTITLE: \"示例世界\" | PRODUCER: \"by 示例制作人\"",
      "backgroundSound": { "ambient": "deep earth rumble", "spatial": "3D audio pan", "intensity": {"crescendo":"0-3s"} },
      "backgroundSoundString": "AMBIENT: deep earth rumble | SPATIAL: 3D audio pan | INTENSITY: crescendo 0-3s",
      "prompt": "...",
      "promptCharCount": 1116
    },
    // S01 正片（17字段）
    {
      "shotId": "S01",
      "duration": 15,
      "scene": "示例世界, 知识圣殿, spatial depth: atmospheric perspective",
      "mood": "mysterious, anticipation, wonder",
      "camera": { "shotSize": "medium", "movement": "static", "lens": "35mm", "speed": 1.0 },
      "cameraString": "medium shot, static, 35mm lens, speed 1",
      "lighting": { "keyLight": { "direction": "front", "colorTemp": 4500, "effect": "neutral balanced" } },
      "lightingString": "front 4500K, neutral balanced",
      "characterRef": "示例角色: image://... | 示例神兽: image://...",
      "character": "示例角色: Human, explorer, curious | 示例神兽: Beast, white fur, mythical",
      "action": "protagonist steps forward",
      "dialogue": "示例角色|独白|好奇|这就是示例神兽的领地吗？|LIP_SYNC:YES",
      "timeline": { "start": "T00:10", "end": "T00:25", "duration": 15, "type": "establishing", "mood": "mysterious" },
      "timelineString": "T00:10-T00:25 / duration: 15s / type: establishing / mood: mysterious",
      "backgroundSound": { "ambient": "wind and distant sounds", "spatial": "ambient stereo", "intensity": {"steady":"0-100%"} },
      "backgroundSoundString": "AMBIENT: wind and distant sounds | SPATIAL: ambient stereo | INTENSITY: steady 0-100%",
      "prompt": "...",
      "promptCharCount": 1252
    }
  ]
}
```

---

## 附录 A：版本变更记录

| 版本 | 日期 | 变更 |
|------|------|------|
| v6.37 | 2026-06-12 | 基础生产版本（P0/P1/P2改造） |
| v6.37-Peng-optimized | 2026-06-13 | 专家反馈全量改造：优先级系统、结构化对象、极简锚点强化、L1-L9融合、硬约束规范 |

---

**文档结束**

- 生成系统: 卓越视频生成系统 v6.37-production+
- 维护者: 示例制作人
- 反馈: 请联系管线团队
