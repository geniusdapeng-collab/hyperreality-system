# 版本历史

## [Unreleased]

### 2026-06-25
- **新增**: 开源准备 — 仓库清理、文档完善、敏感信息脱敏
- **新增**: 进程守护模块（ProcessGuard）全局崩溃防护
- **新增**: Checkpoint 安全序列化机制（处理循环引用）
- **新增**: 深拷贝系统（防跨阶段数据污染）
- **修复**: 字段质量流水线循环引用崩溃问题
- **修复**: index.js 各层独立 try/catch，防止单层崩溃拖垮全局
- **修复**: 片头 5 字段（title_content 等）在标准化过程中丢失的问题

## [v2.1.5] - 2026-06-25

### 审计修复系列
- **v2.1.5-audit-fix8**: 冒烟测试（7项：模块加载、深拷贝、片头判定、Checkpoint、配置、FieldGuard）
- **v2.1.5-audit-fix7**: 配置系统修复（prompt-length.js 零引用、硬编码3000→配置化）
- **v2.1.5-audit-fix6**: P0-致命修复（浅拷贝、field-quality循环引用、Checkpoint损坏、分层try/catch）
- **v2.1.5-audit-fix5**: standardizeShot 保留片头5字段
- **v2.1.5-audit-fix4**: 删除 index.js 重复代码
- **v2.1.5-audit-fix3**: 修复 validateShot 导入缺失 + 片头5字段兜底
- **v2.1.5-audit-fix2**: P2 修复（FieldGuard 单镜头隔离、字段命名统一）
- **v2.1.5-audit-fix**: P0+P1 修复（全局崩溃防护、maxPromptLength 3000→12000、Phase 1失败不跳过）

### 修复详情
- 全局崩溃防护：unhandledRejection/uncaughtException 捕获，防止 LLM 超时杀死进程
- maxPromptLength 3000→12000，按字段等比压缩截断（保25字段标签）
- Phase 1 失败不再跳过 Phase 2/3，降级运行并标记 degraded
- 统一片头判定：兼容 SC00/S00/SC00-xx 及 type='opening'
- FieldGuard 单镜头失败隔离：就地修复补默认值，不 throw 拖垮整批

## [v2.1.4] - 2026-06-19

### 新增
- 跨集边界校验（CrossEpisodeValidator）
- 创意指数反馈系统（CreativeIntensityEngine）
- 字段质量流水线（FieldQualityPipeline）：规则+LLM双层检查
- 25字段标准化系统（FieldGuard + FieldStandardizer）

### 修复
- 负面提示词统一（no text 约束覆盖所有场景）
- 角色一致性约束增强（防止分身/重影/外来IP混入）
- 时间轴格式标准化（T00:XX 相对时间戳）

## [v2.0.0] - 2026-05-30

### 重构
- 从单文件脚本重构为四层解耦架构
- 引入 Harness 架构：Multi-Agent 协作 + 流水线编排
- 新增：剧本引擎、制作引擎、渲染引擎、后期引擎独立模块

### 新增
- 25字段标准化镜头语言系统
- 角色定妆照引用机制（image://characters/...）
- 片头标题优化器（OpeningTitleOptimizer）
- 音频设计Agent（AudioDesignAgent）

## [v1.2.0] - 2026-05-20

### 新增
- 导演审片机制（DirectorReview）
- 提示词审核流程（PromptReview）
- 连续性检查（ContinuityReview）

## [v1.1.0] - 2026-05-15

### 首次发布
- 基于 Seedance 2.0 的 AI 视频自动生产系统
- 支持：剧本生成 → 分镜设计 → 提示词融合 → 渲染提交
- 单集视频预生产完整链路

---

> 版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)：MAJOR.MINOR.PATCH
