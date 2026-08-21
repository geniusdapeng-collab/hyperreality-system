# PandaCineForge Skill for SuperMickey
# 安装与配置指南

## 依赖

- Python 3.8+（必需）
- Node.js 18+（已有）

## 安装步骤

### 1. Python 依赖（可选，缺失时降级）

```bash
cd skills/panda-cineforge
pip install "scrapling[all]" openai pyyaml jsonschema jinja2
```

缺失依赖时引擎自动降级：
- 无 openai → LLM 调用与 embedding 返回空，索引/召回/BM25/Topic 链路仍可用
- 无 scrapling → 爬虫降级为 urllib 兜底
- 无 yaml/jsonschema/jinja2 → 用 JSON 替代

### 2. 环境变量（按需配置）

```bash
export OPENAI_API_KEY=你的API_KEY
export OPENAI_MODEL=gpt-4.1
export OPENAI_TIMEOUT=60

# 搜索 API（任选其一或多选，运行时自动探测）
export TAVILY_API_KEY=...
export BING_API_KEY=...
export BRAVE_API_KEY=...
export SERPAPI_API_KEY=...
export GOOGLE_CSE_API_KEY=...
export GOOGLE_CSE_ID=...

# 服务端口
export PCF_PORT=8765
```

### 3. 启动服务

```bash
# 手动启动 Python 服务
python3 skills/panda-cineforge/server.py

# 或使用适配器自动启动（index.js 中配置 autoStart: true）
```

### 4. SuperMickey 配置

在 `index.js` 构造函数中配置：

```javascript
new HyperRealitySystem({
  pandaCineForge: {
    enabled: true,        // 显式启用
    autoStart: true,      // 自动启动 Python 服务
    endpoint: 'http://127.0.0.1:8765',
    timeout: 5000,
  }
});
```

## 架构

```
SuperMickey (Node.js)
  ├── engines/panda-cineforge-adapter.js    # 适配器
  └── skills/panda-cineforge/
        ├── panda_cineforge.py              # 引擎本体
        ├── server.py                       # HTTP 服务
        ├── system_message.txt              # 系统提示
        ├── user_message_template.txt       # 用户模板
        ├── input_schema.json               # 输入契约
        └── render_template.md              # 渲染模板
```

## 降级策略

| 场景 | 行为 |
|------|------|
| 适配器禁用 | 100% 保持原有 SuperMickey 逻辑 |
| Python 服务未启动 | 跳过技能注入，不影响主流程 |
| 召回超时（>5s） | 返回降级结果，继续主流程 |
| 召回为空 | 继续主流程，无技能注入 |
| 引擎崩溃 | 记录错误，下次调用时重新初始化 |
| 冷启动失败 | 热运行仍可用，技能实时生成 |

## 测试

```bash
# 测试引擎本体
cd skills/panda-cineforge
python3 -c "import panda_cineforge; print('引擎加载成功')"

# 测试服务
python3 server.py &
curl http://127.0.0.1:8765/health

# 测试适配器
cd ../..
node -e "const {PandaCineForgeAdapter} = require('./engines/panda-cineforge-adapter'); const a = new PandaCineForgeAdapter({enabled: true}); a.health().then(h => console.log(h))"
```
