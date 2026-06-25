# 卓越视频系统 - 短片提示词数据结构 v6.37

> **版本**: v6.37 (Production)  
> **日期**: 2026-06-12  
> **系统**: 卓越视频生成系统 (Hyperreality System)  
> **用途**: 标准参考文档，用于所有项目

---

## 一、顶层结构 (Meta)

每个短片包含一个 `meta` 元信息对象和一组 `shots` 镜头数组。

```json
{
  "meta": { ... },
  "shots": [
    { ... }, // S00 片头
    { ... }, // S01 正片镜头1
    { ... }, // S02 正片镜头2
    ...
  ]
}
```

---

## 二、Meta 字段（7字段）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `title` | string | 是 | 短片标题，如 "示例项目：神兽" |
| `worldview` | string | 是 | 世界观标识，如 "fantasy"、"earth"、"fantasy" |
| `totalDuration` | number | 是 | 总时长（秒），如 60-90 |
| `openingDuration` | number | 是 | 片头时长（秒），如 10 |
| `fps` | number | 是 | 帧率，默认 24 |
| `resolution` | string | 是 | 分辨率，如 "1920x1080" |
| `styleNotes` | string | 否 | 风格备注，如 "cinematic, hyperrealistic" |

### Meta 示例

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

## 三、片头镜头 S00（15字段）

片头负责建立世界观、情绪基调，**通常无角色台词**（dialogue 为 NONE），但必须有 `audioLayer` 和 `titleOverlay`。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `shotId` | string | 是 | 镜头编号，固定为 "S00" |
| `duration` | number | 是 | 时长（秒），如 10 |
| `scene` | string | 是 | 五维空间描述（详见下方规范） |
| `mood` | string | 是 | 3-5个情绪关键词，逗号分隔 |
| `camera` | string | 是 | 12级机位+运镜+焦距+速度（详见下方规范） |
| `lighting` | string | 是 | 主光方向+色温K值+特效光 |
| `characterRef` | string | 否 | 角色定妆照引用，格式见下方；片头通常 NONE |
| `character` | string | 否 | 角色极简锚点；片头通常 NONE |
| `action` | string | 是 | 核心动词+交互目标，描述镜头动态 |
| `dialogue` | string | 否 | 统一格式：SPEAKER\|TYPE\|EMOTION\|TEXT\|LIP_SYNC:YES；片头通常 NONE |
| `timeline` | string | 是 | 时间轴标记：T00:XX-T00:XX / duration: Xs / type: opening / mood: XXX |
| `audioLayer` | string | 是 | **片头专属**：音频层设计（四段式） |
| `titleOverlay` | string | 是 | **片头专属**：标题叠加信息（MAIN_TITLE/SUBTITLE/PRODUCER/TITLE_ANIM） |
| `backgroundSound` | string | 是 | 三段式环境音效：AMBIENT+SPATIAL+INTENSITY |
| `prompt` | string | 是 | 最终融合后的完整提示词（≤1500字符） |
| `promptCharCount` | number | 是 | 提示词字符数 |

### 片头字段注释

#### `scene` - 五维空间描述

格式：宏观地理 + 中观地貌 + 微观材质 + 天气时间 + 空间深度

示例：
```
示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite
```

#### `mood` - 情绪关键词

3-5个逗号分隔的情绪词，反映镜头情绪基调。

示例：
```
epic, mysterious, awe-inspiring
```

#### `camera` - 12级机位系统

格式：景别 + 运镜 + 焦距 + 速度

景别（12级）：extreme wide / wide / medium wide / medium / medium close / close / extreme close / macro / bird's eye / low angle / over shoulder / POV
运镜（14种）：static / slow pan / fast pan / tilt / dolly in / dolly out / truck / pedestal / crane / handheld / orbit / rack focus / zoom in / zoom out

示例：
```
epic wide shot, slow descent through atmospheric layers, 24mm wide lens, slow speed
```

#### `lighting` - 光照设计

格式：主光方向 + 色温K值 + 特效光

示例：
```
backlight 3200K, golden hour rim, volumetric god rays
```

#### `dialogue` - 统一格式

格式：`SPEAKER|TYPE|EMOTION|TEXT|LIP_SYNC:YES`

- SPEAKER: 说话者名称
- TYPE: 独白/对白/旁白/内心独白
- EMOTION: 情绪状态
- TEXT: 台词内容
- LIP_SYNC: YES/NO（是否对口型）

片头通常无台词，值为 `NONE`。

示例：
```
示例角色|独白|好奇|这就是白泽的领地吗？|LIP_SYNC:YES
```

#### `timeline` - 时间轴标记

格式：`T00:XX-T00:XX / duration: Xs / type: XXX / mood: XXX`

示例：
```
T00:00-T00:10 / duration: 10s / type: opening / mood: epic
```

#### `audioLayer` - 片头专属音频层（四段式）

格式：四段音频描述，用逗号分隔

示例：
```
Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s
```

#### `titleOverlay` - 片头专属标题叠加

格式：`MAIN_TITLE: "XXX" | SUBTITLE: "XXX" | PRODUCER: "XXX" | TITLE_ANIM: XXX`

示例：
```
MAIN_TITLE: "示例项目：神兽" | SUBTITLE: "示例世界" | PRODUCER: "by 示例制作人" | TITLE_ANIM: light-vein carving growth 3.0-5.0s
```

#### `backgroundSound` - 三段式环境音效

格式：`AMBIENT: XXX | SPATIAL: XXX | INTENSITY: XXX`

- AMBIENT: 环境基底声（风声、水流、人群等）
- SPATIAL: 空间定位（3D音频、声源方向）
- INTENSITY: 强度曲线（crescendo/peak/decay 时间节点）

示例：
```
AMBIENT: epic atmosphere, deep earth rumble 20-60Hz | SPATIAL: 3D audio pan synchronized with camera movement | INTENSITY: crescendo 0-3s, peak 3-7s, decay 7-10s
```

### 片头 S00 完整示例

```json
{
  "shotId": "S00",
  "duration": 10,
  "scene": "示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite",
  "mood": "epic, mysterious, awe-inspiring",
  "camera": "epic wide shot, slow descent through atmospheric layers, 24mm wide lens, slow speed",
  "lighting": "backlight 3200K, golden hour rim, volumetric god rays",
  "characterRef": "NONE",
  "character": "NONE",
  "action": "establishing shot, camera slowly descending through atmospheric layers",
  "dialogue": "NONE",
  "timeline": "T00:00-T00:10 / duration: 10s / type: opening / mood: epic",
  "audioLayer": "Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s",
  "titleOverlay": "MAIN_TITLE: \"示例项目：神兽\" | SUBTITLE: \"示例世界\" | PRODUCER: \"by 示例制作人\" | TITLE_ANIM: light-vein carving growth 3.0-5.0s",
  "backgroundSound": "AMBIENT: epic atmosphere, deep earth rumble 20-60Hz | SPATIAL: 3D audio pan synchronized with camera movement | INTENSITY: crescendo 0-3s, peak 3-7s, decay 7-10s",
  "prompt": "16:9 cinematic, no text... [融合后的完整提示词]",
  "promptCharCount": 1423
}
```

---

## 四、正片镜头 S01+（14核心字段）

正片镜头包含叙事内容、角色表演、对话等。相比片头，**缺少 `audioLayer` 和 `titleOverlay`**（S01 可选保留 `audioLayer` 延续片头声音）。

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `shotId` | string | 是 | 镜头编号，如 "S01"、"S02" |
| `duration` | number | 是 | 时长（秒），如 15 |
| `scene` | string | 是 | 五维空间描述 |
| `mood` | string | 是 | 3-5个情绪关键词 |
| `camera` | string | 是 | 12级机位+运镜+焦距+速度 |
| `lighting` | string | 是 | 主光方向+色温K值+特效光 |
| `characterRef` | string | 是 | 角色定妆照引用：角色名: image://characters/{id}-{angle}.png |
| `character` | string | 是 | 角色极简锚点：角色名: 种族, 关键词1, 关键词2 |
| `action` | string | 是 | 核心动词+交互目标 |
| `dialogue` | string | 是 | 统一格式：SPEAKER\|TYPE\|EMOTION\|TEXT\|LIP_SYNC:YES |
| `timeline` | string | 是 | 时间轴标记：T00:XX-T00:XX / duration: Xs / type: XXX / mood: XXX |
| `backgroundSound` | string | 是 | 三段式环境音效：AMBIENT+SPATIAL+INTENSITY |
| `prompt` | string | 是 | 最终融合后的完整提示词（≤1500字符） |
| `promptCharCount` | number | 是 | 提示词字符数 |

### 正片字段说明

与片头相同字段（scene/mood/camera/lighting/action/timeline/backgroundSound/prompt/promptCharCount）参见上方片头注释。

#### `characterRef` - 角色定妆照引用

格式：多角色用 ` | ` 分隔，每角色多张图用 `, ` 分隔

```
示例角色: image://characters/example-role-front.png, image://characters/example-role-profile.png, image://characters/example-role-three-quarter.png, image://characters/example-role-closeup.png, image://characters/example-role-detail.png | 白泽: image://characters/example-creature-front.png, image://characters/example-creature-profile.png, image://characters/example-creature-three-quarter.png, image://characters/example-creature-closeup.png, image://characters/example-creature-detail.png
```

#### `character` - 角色极简锚点

格式：角色名: 种族, 3-5个核心视觉关键词

```
示例角色: Human, explorer, curious, brave | 白泽: Beast, white fur, mythical, wise
```

#### `dialogue` - 台词（正片通常有）

```
示例角色|独白|好奇|这就是白泽的领地吗？|LIP_SYNC:YES
```

### 正片 S01 完整示例

```json
{
  "shotId": "S01",
  "duration": 15,
  "scene": "示例世界, 知识圣殿, spatial depth: atmospheric perspective",
  "mood": "mysterious, anticipation, wonder",
  "camera": "medium shot, static hold, 35mm standard lens, normal speed",
  "lighting": "front light 4500K, neutral balanced, soft fill",
  "characterRef": "示例角色: image://characters/example-role-front.png, image://characters/example-role-profile.png, image://characters/example-role-three-quarter.png, image://characters/example-role-closeup.png, image://characters/example-role-detail.png | 白泽: image://characters/example-creature-front.png, image://characters/example-creature-profile.png, image://characters/example-creature-three-quarter.png, image://characters/example-creature-closeup.png, image://characters/example-creature-detail.png",
  "character": "示例角色: Human, explorer, curious, brave | 白泽: Beast, white fur, mythical, wise",
  "action": "protagonist steps forward, observing surroundings with focused gaze",
  "dialogue": "示例角色|独白|好奇|这就是白泽的领地吗？|LIP_SYNC:YES",
  "timeline": "T00:10-T00:25 / duration: 15s / type: establishing / mood: mysterious, anticipation, wonder",
  "backgroundSound": "AMBIENT: natural environment, wind and distant sounds | SPATIAL: ambient stereo field | INTENSITY: steady state, subtle variations",
  "prompt": "16:9 cinematic, no text... [融合后的完整提示词]",
  "promptCharCount": 1262
}
```

---

## 五、Prompt 融合顺序（L1-L9 九层架构）

最终 `prompt` 字段按以下顺序融合，确保结构化和优先级：

```
L1 约束层: 16:9 cinematic, no text, no subtitle, no caption, no watermark, 24fps cinematic
L2 基础层: hyperrealistic, ultra-detailed, HDR, film grain, 35mm texture
L3 空间层: scene（五维空间描述）
L4 主体层: character（极简锚点）→ action（核心动词）→ dialogue（统一格式台词）
L5 动态层: camera（12级机位+运镜）→ timeline（时间轴标记）
L6 风格层: mood（3-5情绪关键词）→ lighting（主光+色温+特效）
L7 音频层: backgroundSound（三段式）→ audioLayer（片头四段式，正片无）→ titleOverlay（片头标题，正片无）
L8 内部层: physicsLayer（物理参数）→ colorScience（色彩科学）→ renderStyle（渲染风格）→ directorStyle（导演风格）
L9 质控层: 负面约束（no watermark/cartoon/distorted等）→ 角色一致性约束
```

---

## 六、完整短片 JSON 示例

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
    {
      "shotId": "S00",
      "duration": 10,
      "scene": "示例世界, mysterious atmosphere, golden hour lighting, atmospheric layers, spatial depth: infinite",
      "mood": "epic, mysterious, awe-inspiring",
      "camera": "epic wide shot, slow descent through atmospheric layers, 24mm wide lens, slow speed",
      "lighting": "backlight 3200K, golden hour rim, volumetric god rays",
      "characterRef": "NONE",
      "character": "NONE",
      "action": "establishing shot, camera slowly descending through atmospheric layers",
      "dialogue": "NONE",
      "timeline": "T00:00-T00:10 / duration: 10s / type: opening / mood: epic",
      "audioLayer": "Sub-bass earth rumble fade in 3s, distant wind and environmental sounds, string section long note at 5s, timpani strike at 8s",
      "titleOverlay": "MAIN_TITLE: \"示例项目：神兽\" | SUBTITLE: \"示例世界\" | PRODUCER: \"by 示例制作人\" | TITLE_ANIM: light-vein carving growth 3.0-5.0s",
      "backgroundSound": "AMBIENT: epic atmosphere, deep earth rumble 20-60Hz | SPATIAL: 3D audio pan synchronized with camera movement | INTENSITY: crescendo 0-3s, peak 3-7s, decay 7-10s",
      "prompt": "...",
      "promptCharCount": 1423
    },
    {
      "shotId": "S01",
      "duration": 15,
      "scene": "示例世界, 知识圣殿, spatial depth: atmospheric perspective",
      "mood": "mysterious, anticipation, wonder",
      "camera": "medium shot, static hold, 35mm standard lens, normal speed",
      "lighting": "front light 4500K, neutral balanced, soft fill",
      "characterRef": "示例角色: image://characters/example-role-front.png, image://characters/example-role-profile.png | 白泽: image://characters/example-creature-front.png, image://characters/example-creature-profile.png",
      "character": "示例角色: Human, explorer, curious, brave | 白泽: Beast, white fur, mythical, wise",
      "action": "protagonist steps forward, observing surroundings with focused gaze",
      "dialogue": "示例角色|独白|好奇|这就是白泽的领地吗？|LIP_SYNC:YES",
      "timeline": "T00:10-T00:25 / duration: 15s / type: establishing / mood: mysterious, anticipation, wonder",
      "backgroundSound": "AMBIENT: natural environment, wind and distant sounds | SPATIAL: ambient stereo field | INTENSITY: steady state, subtle variations",
      "prompt": "...",
      "promptCharCount": 1262
    }
  ]
}
```

---

## 七、关键规范总结

### 1. 字符限制
- 单镜头提示词（`prompt`）：≤1500 字符（中文约500字）
- 建议利用率：80-90%（1200-1350字符）
- 超过自动截断，保留音频层和角色一致性约束

### 2. 片头 vs 正片差异
| 特性 | 片头 S00 | 正片 S01+ |
|------|----------|-----------|
| 台词 | 通常 NONE | 通常有台词 |
| audioLayer | **有**（四段式） | 无（声音延续片头） |
| titleOverlay | **有**（标题叠加） | 无 |
| characterRef | 通常 NONE | 有（角色定妆照） |
| character | 通常 NONE | 有（角色极简锚点） |

### 3. 通用性原则
- 世界观（worldview）可配置：fantasy / earth / cyberpunk 等
- 不硬编码任何项目专属内容（如神话项目、示例世界）为默认值
- 所有字段保持中性/通用，支持电影/视频/教育/广告等场景

### 4. 保留字段（卓越系统特有）
以下字段供内部系统使用，不用于渲染：
- `mouthAction`: 嘴部动作描述（供Seedance对口型）
- `importance`: 镜头重要性评分（1-10）
- `visualComplexity`: 视觉复杂度评分（1-10）
- `qualityScore`: 质量评分对象
- `enhanced`: 是否经过PromptForge增强
- `physicsLayer`: 物理参数（扩展接口）
- `colorScience`: 色彩科学（扩展接口）
- `negativePrompt`: 负面提示词（扩展接口）
- `renderStyle`: 渲染风格（扩展接口）
- `directorStyle`: 导演风格（扩展接口）

---

**文档结束**  
**生成时间**: 2026-06-12 23:45  
**生成系统**: 卓越视频生成系统 v6.37
