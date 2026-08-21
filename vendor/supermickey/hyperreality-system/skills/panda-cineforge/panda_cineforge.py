#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
大熊猫影视创作技能引擎 PandaCineForge —— 单文件引擎本体
========================================================
面向 AI 影视创作领域的通用化技能底座引擎，融合技能生成（锻造）与技能调度编排（召回）
为单一引擎，服务于任意 AI 视频制作系统及其 Agent，不绑定任何具体制作系统。

能力矩阵：
  - 双模式主链路（Cold Forge 冷启动批量预置 / Hot Runtime 热运行实时生成）
  - 外部专业知识获取（七子模块 + Scrapling + 搜索适配器 + 种子源白名单）
  - 五层技能锻造（知识源 / 知识融合 / 多阶段锻造 / 组合创新 / 成熟度进化）
  - 三段式专业性保障（知识置信度门禁 / 轻量单次评审 / 实战反馈自然选择）
  - 分层级联回（R0 结构化路由 / R1 语义向量 / R2 上下文 / R3 关键词 / R4 安全兜底 / R5 实时生成兜底）
  - 固定化输出契约（AI-AI 结构化协议）
  - 统一资产对象 SkillAsset（生产侧输出与消费侧召回收敛为同一对象）
  - 多制作系统 Agent 编排分发（通用底座属性，支撑任意制作系统）
  - 影视垂直化（三大子领域 cinema / short_video / ai_manga_drama）

依赖（可选，缺省自动降级）：
  pip install "scrapling[all]" && scrapling install   # 外部知识爬虫
  pip install openai                                    # LLM 调用 + embedding
  pip install pyyaml jsonschema jinja2                  # 结构化处理
  缺失时引擎仍可运行（相关能力自动降级）。
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import threading
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass, field, asdict
from datetime import datetime, timezone
from functools import lru_cache
from heapq import nlargest
from math import log
from typing import Any, Dict, List, Optional, Set, Tuple, Union

logger = logging.getLogger("panda_cineforge")
if not logger.handlers:
    logging.basicConfig(level=os.getenv("PCF_LOG_LEVEL", "WARNING"), format="%(asctime)s [%(levelname)s] %(name)s: %(message)s")

# ---------- 可选第三方依赖：缺失时降级，不阻断引擎 ----------
try:
    import yaml  # type: ignore
    _HAS_YAML = True
except Exception:
    _HAS_YAML = False

try:
    from openai import OpenAI  # type: ignore
    _HAS_OPENAI = True
except Exception:
    _HAS_OPENAI = False

try:
    from jsonschema import Draft202012Validator  # type: ignore
    from jsonschema.validators import extend  # type: ignore
    _HAS_JSONSCHEMA = True
except Exception:
    _HAS_JSONSCHEMA = False

try:
    from jinja2 import Environment, StrictUndefined  # type: ignore
    _HAS_JINJA = True
except Exception:
    _HAS_JINJA = False

# Scrapling 依赖按需在 CrawlDispatcher 内部导入，避免主进程强依赖。


# ============================================================
# 工具函数
# ============================================================

def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def gen_id(prefix: str = "pcf") -> str:
    return f"{prefix}_{uuid.uuid4().hex[:16]}"


def safe_get(d: Any, *keys, default: Any = None) -> Any:
    cur = d
    for k in keys:
        if not isinstance(cur, dict):
            return default
        cur = cur.get(k)
        if cur is None:
            return default
    return cur if cur is not None else default


def _to_half_width(text: str) -> str:
    result = []
    for char in text:
        code = ord(char)
        if code == 0x3000:
            code = 0x20
        elif 0xFF01 <= code <= 0xFF5E:
            code -= 0xFEE0
        result.append(chr(code))
    return "".join(result)


_ZH_NUM_MAP = {
    "一": "1", "二": "2", "两": "2", "三": "3", "四": "4", "五": "5",
    "六": "6", "七": "7", "八": "8", "九": "9", "十": "10",
}


def _normalize_number_forms(text: str) -> str:
    text = _to_half_width(text)
    for zh, num in _ZH_NUM_MAP.items():
        text = re.sub(rf"{zh}\s*个?月", f"{num}个月", text)
        text = re.sub(rf"{zh}\s*岁", f"{num}岁", text)
    return text


@lru_cache(maxsize=20000)
def normalize_text(text: str) -> str:
    """文本归一化：转小写 / 全角转半角 / 数字归一化 / 同义词替换 / 去特殊字符。"""
    if not text:
        return ""
    text = _normalize_number_forms(text.strip().lower())
    text = re.sub(r"\s+", "", text)
    for variant, canonical in _SORTED_CINEMA_VARIANTS:
        text = text.replace(variant, canonical)
    text = re.sub(r"[^\u4e00-\u9fff0-9a-zA-Z]+", "", text)
    return text


@lru_cache(maxsize=20000)
def char_ngrams(text: str, ns: tuple = (2, 3)) -> Tuple[str, ...]:
    """字符 n-gram，用于 BM25 索引与模糊匹配。"""
    normalized = normalize_text(text)
    grams: List[str] = []
    for n in ns:
        if len(normalized) < n:
            continue
        for i in range(len(normalized) - n + 1):
            grams.append(normalized[i:i + n])
    return tuple(grams)


def _build_variant_map(synonym_groups: Dict[str, List[str]]) -> List[Tuple[str, str]]:
    """构建同义词替换表。variant 统一 lower + 去空白，与 normalize_text 的
    (lower → 去空白 → 替换) 流程对齐，确保 "Color Grading"/"VFX" 等英文同义词能正确归一化。"""
    mp: Dict[str, str] = {}
    for canonical, variants in synonym_groups.items():
        for v in variants:
            key = re.sub(r"\s+", "", v.lower())
            if key:
                mp[key] = canonical
        ckey = re.sub(r"\s+", "", canonical.lower())
        if ckey:
            mp[ckey] = canonical
    # 按长度降序，保证长词优先匹配，避免短词误替换
    return sorted(mp.items(), key=lambda x: len(x[0]), reverse=True)


def _char_jaccard(a: str, b: str) -> float:
    sa = set(char_ngrams(a))
    sb = set(char_ngrams(b))
    if not sa or not sb:
        return 0.0
    return len(sa & sb) / len(sa | sb)


def _safe_int(v: Any, default: int = 0) -> int:
    """安全转 int，非数字（含脏数据）返回 default。"""
    try:
        return int(v)
    except (TypeError, ValueError):
        return default


def _safe_list(v: Any) -> List[Any]:
    """安全转 list，非 list/tuple 返回空列表。"""
    if isinstance(v, (list, tuple)):
        return list(v)
    return []


def _normalize_dim_coverage(v: Any) -> Dict[str, List[str]]:
    """归一化 dimension_coverage 为 dict[str, list]，容忍脏数据。"""
    if not isinstance(v, dict):
        return {"required": [], "covered": [], "missing": []}
    out: Dict[str, List[str]] = {}
    for k, val in v.items():
        if isinstance(val, (list, tuple)):
            out[k] = [str(x) for x in val]
        elif val is None:
            out[k] = []
        else:
            out[k] = [str(val)]
    return out


def _top_ids(score_map: Dict[str, float], top_n: int) -> List[str]:
    return [sid for sid, _ in nlargest(top_n, score_map.items(), key=lambda x: x[1])]


def _hash_key(*parts: str) -> str:
    return hashlib.md5("||".join(parts).encode("utf-8")).hexdigest()


def _dump_yaml(obj: Any) -> str:
    if _HAS_YAML:
        return yaml.safe_dump(obj, allow_unicode=True, sort_keys=False)
    return json.dumps(obj, ensure_ascii=False, indent=2)


def _load_yaml(text: str) -> Any:
    if _HAS_YAML:
        return yaml.safe_load(text)
    return json.loads(text)


# ============================================================
# 影视知识基座（同义词组 / 实体词典 / 场景词典 / 紧急度 / Topic 规则）
# ============================================================

# ---------- 影视同义词组 ----------
CINEMA_SYNONYMS: Dict[str, List[str]] = {
    "运镜": ["运镜", "镜头运动", "推拉摇移", "推镜头", "拉镜头", "摇镜头", "移镜头", "跟拍", "航拍"],
    "调色": ["调色", "色彩校正", "Color Grading", "套LUT", "调色板", "色彩管理"],
    "转场": ["转场", "过渡", "硬切", "叠化", "闪白", "匹配剪辑"],
    "分镜": ["分镜", "分镜脚本", "故事板", "Storyboard", "镜头清单", "Shotlist", "故板"],
    "混音": ["混音", "音频混合", "5.1混音", "立体声", "Foley", "拟音"],
    "剪辑": ["剪辑", "蒙太奇", "剪接节奏", "动接动", "声画对位"],
    "视效": ["视效", "VFX", "特效", "合成", "绿幕", "追踪", "粒子"],
    "提示词": ["提示词", "Prompt", "AI生成", "文生图", "文生视频"],
    "钩子": ["钩子", "开场钩子", "3秒钩子", "完播", "留存"],
    "漫剧": ["漫剧", "AI漫剧", "分集", "口播", "连载"],
}

_SORTED_CINEMA_VARIANTS = _build_variant_map(CINEMA_SYNONYMS)

# ---------- 影视实体词典 ----------
CINEMA_ENTITIES: Dict[str, List[str]] = {
    "who": ["导演", "摄影指导", "剪辑师", "调色师", "声音设计师", "视效总监", "制片人", "达人", "编剧"],
    "actions": ["运镜", "调色", "剪辑", "转场", "混音", "生成", "投流", "拆镜", "布光", "收声"],
    "objects": ["镜头", "LUT", "音轨", "分镜", "提示词", "素材", "成片", "钩子", "节拍表", "色彩脚本"],
}

# ---------- 影视场景词典 ----------
CINEMA_SCENARIOS: List[str] = [
    "前期筹备", "剧本开发", "角色设计", "场景设计",
    "分镜脚本", "视觉开发", "故事板",
    "拍摄", "布光", "收声", "场记",
    "后期剪辑", "粗剪", "精剪",
    "调色", "色彩管理", "套底",
    "混音", "对白", "旁白", "音效", "音乐",
    "视效", "合成", "动画", "数字绘景",
    "发行", "交付", "DCP", "流媒体",
    "投流", "矩阵", "带货", "达人", "ROI",
    "漫剧分集", "口播", "连载", "AI生图", "AI生视频",
]

# ---------- 影视紧急度关键词 ----------
CINEMA_URGENCY: List[str] = [
    "交片", "死线", "Deadline", "崩溃", "丢失", "驳回",
    "审核不过", "渲染失败", "封禁", "限流",
]

_HIGH_URGENCY_KW = set(CINEMA_URGENCY)
_MEDIUM_URGENCY_KW = {"总是", "一直", "反复", "严重", "不退", "持续", "紧急", "尽快"}

# ---------- 影视 Topic 规则（50+，替换原育儿 Topic） ----------
CINEMA_TOPICS: Dict[str, Dict] = {
    "cinematic_structure": {"keywords": ["三幕结构", "英雄之旅", "节拍表", "角色弧光", "叙事结构"], "aliases": ["三幕式", "剧本结构"], "physical_domains": ["cinema", "scene_design"], "negative_keywords": ["投流", "带货"], "weight": 1.2, "cinematic_role": "scene_design"},
    "character_arc": {"keywords": ["角色弧光", "人物成长", "动机", "角色发展"], "aliases": ["人物弧光"], "physical_domains": ["cinema", "scene_design"], "negative_keywords": ["投流"], "weight": 1.1, "cinematic_role": "scene_design"},
    "beat_sheet": {"keywords": ["节拍表", "结构拆解", "叙事节奏", "Beat Sheet"], "aliases": ["节拍"], "physical_domains": ["cinema", "scene_design"], "negative_keywords": ["投流"], "weight": 1.15, "cinematic_role": "scene_design"},
    "scene_breakdown": {"keywords": ["场景拆解", "场次", "场景设计", "剧本拆解"], "aliases": ["拆戏"], "physical_domains": ["cinema", "scene_design"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "scene_design"},
    "shot_language": {"keywords": ["景别", "构图", "180度线", "越轴", "匹配剪辑", "镜头语言"], "aliases": ["轴线", "机位"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": ["投流"], "weight": 1.2, "cinematic_role": "visual_language"},
    "camera_movement": {"keywords": ["推拉摇移", "跟拍", "航拍", "稳定器", "运镜"], "aliases": ["镜头运动"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "visual_language"},
    "color_grading": {"keywords": ["调色", "LUT", "色彩空间", "Rec.709", "Rec.2020", "ACES", "色板"], "aliases": ["色彩校正", "套LUT"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": ["投流"], "weight": 1.25, "cinematic_role": "visual_language"},
    "color_management": {"keywords": ["色彩管理", "套底", "Log", "线性", "色域转换"], "aliases": ["色彩流水线"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "visual_language"},
    "lighting_design": {"keywords": ["布光", "三点布光", "自然光", "影调", "光比"], "aliases": ["打光"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "visual_language"},
    "storyboard": {"keywords": ["分镜", "故事板", "分镜脚本", "画面设计"], "aliases": ["Storyboard"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "visual_language"},
    "sound_design": {"keywords": ["声音设计", "混音", "对白", "旁白", "Foley", "拟音", "音效"], "aliases": ["音频设计"], "physical_domains": ["cinema", "audio_design"], "negative_keywords": ["投流"], "weight": 1.2, "cinematic_role": "audio_design"},
    "music_score": {"keywords": ["配乐", "BGM", "音乐选型", "背景音乐"], "aliases": ["音乐"], "physical_domains": ["cinema", "audio_design"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "audio_design"},
    "mix_plan": {"keywords": ["混音方案", "5.1", "立体声", "响度", "LUFS"], "aliases": ["混音计划"], "physical_domains": ["cinema", "audio_design"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "audio_design"},
    "editing_rhythm": {"keywords": ["剪辑节奏", "蒙太奇", "转场", "动接动", "声画对位"], "aliases": ["剪接节奏"], "physical_domains": ["cinema", "editing"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "editing"},
    "edit_decision_list": {"keywords": ["EDL", "剪辑决策表", "粗剪", "精剪", "剪辑点"], "aliases": ["剪辑单"], "physical_domains": ["cinema", "editing"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "editing"},
    "vfx_compositing": {"keywords": ["视效", "合成", "绿幕", "追踪", "抠像"], "aliases": ["VFX", "特效"], "physical_domains": ["cinema", "vfx"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "vfx"},
    "matte_painting": {"keywords": ["数字绘景", "接景", "环境合成"], "aliases": ["Matte Painting"], "physical_domains": ["cinema", "vfx"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "vfx"},
    "particle_fx": {"keywords": ["粒子", "流体", "破坏特效", "动力学"], "aliases": ["特效模拟"], "physical_domains": ["cinema", "vfx"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "vfx"},
    "continuity_check": {"keywords": ["连贯性", "穿帮", "匹配", "180度线", "轴线"], "aliases": ["连戏检查"], "physical_domains": ["cinema", "continuity_review"], "negative_keywords": [], "weight": 1.25, "cinematic_role": "continuity_review"},
    "continuity_report": {"keywords": ["连贯性报告", "穿帮检查", "场记", "接戏"], "aliases": ["连戏报告"], "physical_domains": ["cinema", "continuity_review"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "continuity_review"},
    "prompt_engineering": {"keywords": ["提示词", "Midjourney", "Runway", "Sora", "Prompt"], "aliases": ["提示词工程"], "physical_domains": ["cinema", "prompt_fusion"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "prompt_fusion"},
    "ai_video_generation": {"keywords": ["文生视频", "图生视频", "可灵", "即梦", "AI视频"], "aliases": ["AI生成视频"], "physical_domains": ["cinema", "prompt_fusion"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "prompt_fusion"},
    "ai_image_generation": {"keywords": ["文生图", "AI生图", "角色一致性", "Stable Diffusion"], "aliases": ["AI绘图"], "physical_domains": ["cinema", "prompt_fusion"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "prompt_fusion"},
    "comfyui_workflow": {"keywords": ["ComfyUI", "工作流", "节点编排"], "aliases": ["ComfyUI工作流"], "physical_domains": ["cinema", "prompt_fusion"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "prompt_fusion"},
    "opening_design": {"keywords": ["开场", "片头", "冷开场", "热开场", "片头序列"], "aliases": ["Opening"], "physical_domains": ["cinema", "opening_design"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "opening_design"},
    "title_sequence": {"keywords": ["片头序列", "字幕设计", "品牌片头", "标题动画"], "aliases": ["Title Sequence"], "physical_domains": ["cinema", "opening_design"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "opening_design"},
    "short_video_hook": {"keywords": ["钩子", "3秒", "完播", "留存", "开场钩子"], "aliases": ["短视频钩子"], "physical_domains": ["short_video"], "negative_keywords": ["DCP"], "weight": 1.3, "cinematic_role": "opening_design"},
    "short_video_script": {"keywords": ["短视频脚本", "选题", "爆款", "口播稿"], "aliases": ["短视频文案"], "physical_domains": ["short_video"], "negative_keywords": ["DCP"], "weight": 1.2, "cinematic_role": "scene_design"},
    "short_video_marketing": {"keywords": ["投流", "矩阵", "带货", "达人", "ROI", "千川"], "aliases": ["短视频营销"], "physical_domains": ["short_video"], "negative_keywords": ["DCP", "调色"], "weight": 1.2, "cinematic_role": "scene_design"},
    "short_video_editing": {"keywords": ["竖屏剪辑", "快节奏", "卡点", "竖屏9:16"], "aliases": ["短视频剪辑"], "physical_domains": ["short_video"], "negative_keywords": ["DCP"], "weight": 1.15, "cinematic_role": "editing"},
    "ai_manga_drama": {"keywords": ["漫剧", "AI漫剧", "分集", "连载", "AI漫剧"], "aliases": ["漫画剧"], "physical_domains": ["ai_manga_drama"], "negative_keywords": ["DCP", "投流"], "weight": 1.25, "cinematic_role": "scene_design"},
    "manga_episode": {"keywords": ["分集结构", "连载钩子", "前情", "分集大纲"], "aliases": ["漫剧分集"], "physical_domains": ["ai_manga_drama"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "scene_design"},
    "voiceover_rhythm": {"keywords": ["口播", "旁白节奏", "语速", "口播稿"], "aliases": ["配音节奏"], "physical_domains": ["ai_manga_drama"], "negative_keywords": [], "weight": 1.15, "cinematic_role": "audio_design"},
    "character_consistency": {"keywords": ["角色一致性", "角色漂移", "参考图", "LoRA"], "aliases": ["角色稳定"], "physical_domains": ["ai_manga_drama"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "prompt_fusion"},
    "dcp_delivery": {"keywords": ["DCP", "数字电影包", "影院交付"], "aliases": ["数字电影包"], "physical_domains": ["cinema"], "negative_keywords": ["投流", "短视频"], "weight": 1.2, "cinematic_role": "editing"},
    "netflix_delivery": {"keywords": ["Netflix规范", "流媒体交付", "IMF"], "aliases": ["流媒体交付"], "physical_domains": ["cinema"], "negative_keywords": ["投流"], "weight": 1.15, "cinematic_role": "editing"},
    "production_management": {"keywords": ["制片管理", "预算", "排期", "场记", "通告单"], "aliases": ["制片"], "physical_domains": ["cinema"], "negative_keywords": ["投流"], "weight": 1.1, "cinematic_role": "scene_design"},
    "visual_development": {"keywords": ["视觉开发", "概念设计", "美术", "概念图"], "aliases": ["视效开发"], "physical_domains": ["cinema"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "visual_language"},
    "lip_sync": {"keywords": ["口型", "口型同步", "对白口型", "口型对位"], "aliases": ["对口型"], "physical_domains": ["ai_manga_drama", "cinema"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "audio_design"},
    "aspect_ratio": {"keywords": ["画幅", "宽高比", "9:16", "16:9", "2.39:1"], "aliases": ["比例"], "physical_domains": ["cinema", "short_video"], "negative_keywords": [], "weight": 1.05, "cinematic_role": "visual_language"},
    "frame_rate": {"keywords": ["帧率", "24fps", "30fps", "60fps", "补帧"], "aliases": ["fps"], "physical_domains": ["cinema"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "visual_language"},
    "color_script": {"keywords": ["色彩脚本", "色彩设计", "色彩叙事", "调色方案"], "aliases": ["色彩剧本"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "visual_language"},
    "shotlist": {"keywords": ["镜头清单", "分镜清单", "镜头表", "Shotlist"], "aliases": ["镜头单"], "physical_domains": ["cinema", "visual_language"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "visual_language"},
    "platform_compliance": {"keywords": ["平台审核", "违禁词", "审核规则", "合规"], "aliases": ["审核合规"], "physical_domains": ["short_video", "ai_manga_drama"], "negative_keywords": ["DCP"], "weight": 1.2, "cinematic_role": "continuity_review"},
    "data_review": {"keywords": ["数据复盘", "完播率", "互动率", "转化", "复盘"], "aliases": ["投流复盘"], "physical_domains": ["short_video"], "negative_keywords": ["DCP"], "weight": 1.1, "cinematic_role": "scene_design"},
    "render_farm": {"keywords": ["渲染农场", "批量渲染", "渲染队列", "渲染失败"], "aliases": ["渲染"], "physical_domains": ["cinema", "vfx"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "vfx"},
    "backup_strategy": {"keywords": ["素材备份", "版本管理", "冗余", "素材丢失"], "aliases": ["备份"], "physical_domains": ["cinema"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "continuity_review"},
    "copyright_clearance": {"keywords": ["版权", "授权", "音乐版权", "素材版权", "字体版权"], "aliases": ["版权清理"], "physical_domains": ["cinema", "short_video"], "negative_keywords": [], "weight": 1.2, "cinematic_role": "continuity_review"},
    "subtitle_design": {"keywords": ["字幕", "字幕设计", "字幕规范", "字幕样式"], "aliases": ["字幕"], "physical_domains": ["cinema", "short_video"], "negative_keywords": [], "weight": 1.05, "cinematic_role": "opening_design"},
    "trailer_editing": {"keywords": ["预告片", "预告片剪辑", "混剪", "预告片结构"], "aliases": ["预告"], "physical_domains": ["cinema"], "negative_keywords": [], "weight": 1.1, "cinematic_role": "editing"},
}


# ============================================================
# 外部知识源配置
# ============================================================

# 搜索 API 适配器注册表（7 种源，运行时按环境变量探测）
SEARCH_PROVIDER_REGISTRY: Dict[str, Dict] = {
    "bing": {"env_keys": ["BING_API_KEY", "AZURE_BING_KEY"], "needs_key": True},
    "google_cse": {"env_keys": ["GOOGLE_CSE_API_KEY", "GOOGLE_CSE_ID"], "needs_key": True},
    "serpapi": {"env_keys": ["SERPAPI_API_KEY"], "needs_key": True},
    "brave": {"env_keys": ["BRAVE_API_KEY"], "needs_key": True},
    "tavily": {"env_keys": ["TAVILY_API_KEY"], "needs_key": True},
    "duckduckgo": {"env_keys": [], "needs_key": False},
    "searxng": {"env_keys": ["SEARXNG_BASE_URL"], "needs_key": False},
}

# 影视专业可信种子源白名单（六大类 40+ 源）
CINEMA_SEED_SOURCES: List[Dict] = [
    {"domain": "smpte.org", "category": "规范标准", "trust": 1.0, "session": "fast"},
    {"domain": "acescentral.com", "category": "规范标准", "trust": 1.0, "session": "fast"},
    {"domain": "itu.int", "category": "规范标准", "trust": 1.0, "session": "fast"},
    {"domain": "partner.netflix.com", "category": "规范标准", "trust": 1.0, "session": "fast"},
    {"domain": "dcimovies.com", "category": "规范标准", "trust": 1.0, "session": "fast"},
    {"domain": "ebu.ch", "category": "规范标准", "trust": 0.95, "session": "fast"},
    {"domain": "blackmagicdesign.com", "category": "工具官方文档", "trust": 1.0, "session": "fast"},
    {"domain": "adobe.com", "category": "工具官方文档", "trust": 1.0, "session": "fast"},
    {"domain": "docs.blender.org", "category": "工具官方文档", "trust": 1.0, "session": "fast"},
    {"domain": "foundry.com", "category": "工具官方文档", "trust": 1.0, "session": "fast"},
    {"domain": "avid.com", "category": "工具官方文档", "trust": 1.0, "session": "fast"},
    {"domain": "midjourney.com", "category": "工具官方文档", "trust": 1.0, "session": "dynamic"},
    {"domain": "runwayml.com", "category": "工具官方文档", "trust": 1.0, "session": "dynamic"},
    {"domain": "openai.com", "category": "工具官方文档", "trust": 1.0, "session": "dynamic"},
    {"domain": "klingai.com", "category": "工具官方文档", "trust": 1.0, "session": "dynamic"},
    {"domain": "jimeng.jianying.com", "category": "工具官方文档", "trust": 1.0, "session": "dynamic"},
    {"domain": "comfyanonymous.github.io", "category": "工具官方文档", "trust": 0.95, "session": "fast"},
    {"domain": "wikipedia.org", "category": "学术权威", "trust": 0.85, "session": "fast"},
    {"domain": "siggraph.org", "category": "学术权威", "trust": 0.95, "session": "stealth"},
    {"domain": "arxiv.org", "category": "学术权威", "trust": 0.95, "session": "fast"},
    {"domain": "artofthetitle.com", "category": "案例专业", "trust": 0.95, "session": "fast"},
    {"domain": "vimeo.com", "category": "案例专业", "trust": 0.85, "session": "dynamic"},
    {"domain": "shotdeck.com", "category": "案例专业", "trust": 0.9, "session": "stealth"},
    {"domain": "film-grab.com", "category": "案例专业", "trust": 0.85, "session": "fast"},
    {"domain": "reddit.com", "category": "社区经验", "trust": 0.7, "session": "fast"},
    {"domain": "zhihu.com", "category": "社区经验", "trust": 0.6, "session": "fast"},
    {"domain": "107cine.com", "category": "社区经验", "trust": 0.75, "session": "stealth"},
    {"domain": "creator.douyin.com", "category": "平台规则", "trust": 0.9, "session": "dynamic"},
    {"domain": "kuaishou.com", "category": "平台规则", "trust": 0.9, "session": "dynamic"},
    {"domain": "creator.tiktok.com", "category": "平台规则", "trust": 0.9, "session": "dynamic"},
    {"domain": "bilibili.com", "category": "平台规则", "trust": 0.85, "session": "dynamic"},
    {"domain": "xiaohongshu.com", "category": "平台规则", "trust": 0.8, "session": "dynamic"},
    {"domain": "youtube.com", "category": "平台规则", "trust": 0.9, "session": "dynamic"},
]

_SEED_DOMAIN_MAP: Dict[str, Dict] = {s["domain"].split(".")[0]: s for s in CINEMA_SEED_SOURCES}

# Scrapling 三会话配置
SCRAPLING_SESSION_CONFIG: Dict[str, Dict] = {
    "fast": {"fetcher": "Fetcher", "impersonate": "chrome", "http3": True, "lazy": False},
    "stealth": {"fetcher": "StealthyFetcher", "headless": True, "solve_cloudflare": True, "stealthy_headers": True, "lazy": True},
    "dynamic": {"fetcher": "DynamicFetcher", "headless": True, "network_idle": True, "lazy": True},
}

# 工具名映射表（按 cinematic_role 自动选工具，用于查询构造）
CINEMA_TOOL_MAP: Dict[str, List[str]] = {
    "visual_language": ["达芬奇", "LUT", "ACES", "Rec.709", "Rec.2020"],
    "audio_design": ["Pro Tools", "混音", "5.1", "Foley"],
    "prompt_fusion": ["Midjourney", "Runway", "Sora", "可灵", "即梦", "ComfyUI"],
    "editing": ["Premiere", "达芬奇", "Avid", "EDL"],
    "vfx": ["AE", "Nuke", "Blender", "Houdini"],
    "opening_design": ["AE", "Blender", "片头设计"],
    "scene_design": ["节拍表", "三幕结构", "英雄之旅"],
    "continuity_review": ["180度线", "匹配剪辑", "连贯性"],
    "color_grading": ["达芬奇", "LUT", "ACES"],
}


# ============================================================
# 置信度门禁配置
# ============================================================

# deliverable_type 维度映射表（必需维度 / 加分维度）
DELIVERABLE_DIMENSION_MAP: Dict[str, Dict[str, List[str]]] = {
    "color_script": {"required": ["principles", "standards", "tool_params"], "bonus": ["case_refs", "heuristics", "pitfalls"]},
    "shotlist": {"required": ["principles", "tool_params"], "bonus": ["case_refs", "heuristics"]},
    "storyboard": {"required": ["principles", "tool_params"], "bonus": ["case_refs"]},
    "sound_map": {"required": ["principles", "standards", "tool_params"], "bonus": ["case_refs", "pitfalls"]},
    "mix_plan": {"required": ["principles", "standards", "tool_params"], "bonus": ["pitfalls"]},
    "prompt_pack": {"required": ["tool_params", "heuristics"], "bonus": ["principles", "case_refs"]},
    "opening_sequence": {"required": ["principles", "case_refs"], "bonus": ["tool_params", "heuristics"]},
    "edit_decision_list": {"required": ["principles", "tool_params"], "bonus": ["heuristics", "pitfalls"]},
    "beat_sheet": {"required": ["principles", "case_refs"], "bonus": ["heuristics"]},
    "continuity_report": {"required": ["principles", "standards"], "bonus": ["heuristics", "pitfalls"]},
}

# 置信度阈值
CONFIDENCE_THRESHOLDS: Dict[str, Dict] = {
    "high": {"min_trust": 0.9, "min_points": 10, "min_coverage": 0.8, "maturity": "v2"},
    "medium": {"min_trust_range": (0.7, 0.9), "min_points_range": (6, 9), "min_coverage_range": (0.6, 0.8), "action": "review", "maturity_pass": "v2", "maturity_fail": "v1"},
    "low": {"max_trust": 0.7, "max_points": 6, "max_coverage": 0.6, "maturity": "v1"},
}

# 三大子领域扩展包
DOMAIN_PACKS: Dict[str, Dict] = {
    "cinema": {
        "pipeline": ["开发", "筹备", "拍摄", "后期", "交付"],
        "deliverables": ["剧本", "视觉开发板", "分镜", "粗剪", "精剪", "调色", "混音", "DCP"],
        "standards": ["SMPTE", "Rec.2020", "24fps", "5.1混音"],
        "risk_focus": ["版权", "预算超支", "后期返工"],
        "tools": ["达芬奇", "Premiere", "Avid", "Pro Tools", "Nuke", "Blender"],
        "quality_bar": "工业级交付标准",
    },
    "short_video": {
        "pipeline": ["选题", "脚本", "拍摄/AI生成", "剪辑", "投流", "复盘"],
        "deliverables": ["钩子文案", "分镜", "成片", "投流素材矩阵", "数据复盘"],
        "standards": ["竖屏9:16", "3秒钩子", "完播率", "平台审核规则"],
        "risk_focus": ["审核驳回", "限流", "违禁词", "版权音乐"],
        "tools": ["剪映", "CapCut", "Midjourney", "可灵", "即梦", "ComfyUI"],
        "quality_bar": "平台合规+传播效率",
    },
    "ai_manga_drama": {
        "pipeline": ["大纲", "分集", "口播", "AI生图", "AI生视频", "装配", "连载"],
        "deliverables": ["分集剧本", "口播稿", "角色一致性参考", "分镜", "成片"],
        "standards": ["角色一致性", "口播节奏", "连载钩子", "平台规范"],
        "risk_focus": ["角色漂移", "口播不同步", "敏感内容", "连载断更"],
        "tools": ["Midjourney", "Stable Diffusion", "ComfyUI", "可灵", "即梦", "剪映"],
        "quality_bar": "连载一致性+AI生成质量",
    },
}

# 影视一票否决项
CINEMA_VETO_RULES: List[str] = [
    "镜头连贯性断裂:180度线越轴/匹配剪辑失败/轴线错乱未声明",
    "色彩空间错配:Rec.709/Rec.2020/sRGB混用未声明转换",
    "对白口型不同步:口播/对白与画面口型偏移未处理",
    "版权素材未授权:音乐/素材/字体/形象版权未声明",
    "平台审核硬伤:短视频违禁词/漫剧敏感内容/诱导性内容",
    "不可逆渲染未确认:高负载渲染/批量导出无确认门",
    "素材无备份策略:关键素材无冗余/无版本",
]

# 影视评分维度（原 8 维 + 新增 3 维）
CINEMA_SCORING_WEIGHTS: Dict[str, float] = {
    "completeness": 1.0, "personalization": 1.0, "context_fidelity": 1.0,
    "domain_professionalism": 1.2, "actionability": 1.0, "tool_rationality": 1.0,
    "risk_control": 1.2, "clarity": 1.0,
    "cinematic_professionalism": 1.3, "continuity_safety": 1.3, "platform_compliance": 1.2,
}

QA_PASS_THRESHOLD = 85


# ============================================================
# 多系统注册表
# ============================================================

AGENT_REGISTRY: Dict[str, Dict] = {
    "MyStudio": {
        "agents": ["SceneDesign", "VisualLanguage", "AudioDesign", "ContinuityReview", "PromptFusion", "OpeningDesign"],
        "role_map": {
            "SceneDesign": "scene_design", "VisualLanguage": "visual_language",
            "AudioDesign": "audio_design", "ContinuityReview": "continuity_review",
            "PromptFusion": "prompt_fusion", "OpeningDesign": "opening_design",
        },
        "deliverable_map": {
            "SceneDesign": ["beat_sheet", "scene_breakdown"],
            "VisualLanguage": ["shotlist", "storyboard", "color_script"],
            "AudioDesign": ["sound_map", "mix_plan"],
            "ContinuityReview": ["continuity_report"],
            "PromptFusion": ["prompt_pack"],
            "OpeningDesign": ["opening_sequence"],
        },
    },
}

# cinematic_role / module_target / deliverable_type 枚举
CINEMATIC_ROLES = ["scene_design", "visual_language", "audio_design", "continuity_review", "prompt_fusion", "opening_design", "editing", "color_grading", "vfx"]
DELIVERABLE_TYPES = ["shotlist", "storyboard", "color_script", "sound_map", "prompt_pack", "edit_decision_list", "opening_sequence", "beat_sheet", "continuity_report", "mix_plan"]
PROJECT_STAGES = ["preproduction", "production", "postproduction", "distribution"]
SUB_DOMAINS = ["cinema", "short_video", "ai_manga_drama"]


# ============================================================
# 全域技能矩阵（冷启动批量生成蓝图）
# ============================================================

COLD_FORGE_MATRIX: List[Dict] = [
    {"agent": "SceneDesign", "cinematic_role": "scene_design", "sub_domain": "cinema", "tasks": ["三幕结构设计", "英雄之旅编排", "角色弧光设计", "节拍表制作", "场景拆解"]},
    {"agent": "SceneDesign", "cinematic_role": "scene_design", "sub_domain": "short_video", "tasks": ["选题脚本", "钩子结构", "爆款文案", "投流策略"]},
    {"agent": "SceneDesign", "cinematic_role": "scene_design", "sub_domain": "ai_manga_drama", "tasks": ["分集大纲", "连载钩子", "前情回顾"]},
    {"agent": "VisualLanguage", "cinematic_role": "visual_language", "sub_domain": "cinema", "tasks": ["分镜设计", "色彩脚本", "运镜设计", "布光方案", "景别构图"]},
    {"agent": "VisualLanguage", "cinematic_role": "visual_language", "sub_domain": "short_video", "tasks": ["竖屏分镜", "视觉钩子", "卡点设计"]},
    {"agent": "VisualLanguage", "cinematic_role": "visual_language", "sub_domain": "ai_manga_drama", "tasks": ["AI生图分镜", "角色一致性参考"]},
    {"agent": "AudioDesign", "cinematic_role": "audio_design", "sub_domain": "cinema", "tasks": ["5.1混音", "Foley拟音", "对白处理", "混音方案", "配乐选型"]},
    {"agent": "AudioDesign", "cinematic_role": "audio_design", "sub_domain": "short_video", "tasks": ["BGM选型", "音效钩子", "卡点音效"]},
    {"agent": "AudioDesign", "cinematic_role": "audio_design", "sub_domain": "ai_manga_drama", "tasks": ["口播节奏", "旁白设计", "口型对位"]},
    {"agent": "ContinuityReview", "cinematic_role": "continuity_review", "sub_domain": "cinema", "tasks": ["180度线检查", "匹配剪辑检查", "穿帮检查", "连贯性报告"]},
    {"agent": "ContinuityReview", "cinematic_role": "continuity_review", "sub_domain": "short_video", "tasks": ["跨镜头连贯", "品牌一致性", "平台合规检查"]},
    {"agent": "ContinuityReview", "cinematic_role": "continuity_review", "sub_domain": "ai_manga_drama", "tasks": ["角色漂移检测", "场景连贯", "敏感内容审查"]},
    {"agent": "PromptFusion", "cinematic_role": "prompt_fusion", "sub_domain": "cinema", "tasks": ["Midjourney提示词", "Runway提示词", "Sora提示词", "ComfyUI工作流"]},
    {"agent": "PromptFusion", "cinematic_role": "prompt_fusion", "sub_domain": "short_video", "tasks": ["竖屏AI生成提示词", "可灵提示词", "即梦提示词"]},
    {"agent": "PromptFusion", "cinematic_role": "prompt_fusion", "sub_domain": "ai_manga_drama", "tasks": ["AI生图一致性提示词", "AI生视频提示词", "LoRA角色固化"]},
    {"agent": "OpeningDesign", "cinematic_role": "opening_design", "sub_domain": "cinema", "tasks": ["冷开场设计", "热开场设计", "片头序列", "字幕设计"]},
    {"agent": "OpeningDesign", "cinematic_role": "opening_design", "sub_domain": "short_video", "tasks": ["3秒开场", "品牌片头", "黄金前3秒"]},
    {"agent": "OpeningDesign", "cinematic_role": "opening_design", "sub_domain": "ai_manga_drama", "tasks": ["漫剧开场", "分集前情", "连载开场"]},
]


# ============================================================
# LLM 客户端封装（统一生产侧与评审侧调用）
# ============================================================

class LLMClient:
    """统一的 LLM 调用封装。无 OPENAI 依赖时降级为占位实现，便于离线索引/召回。"""

    def __init__(self, model: Optional[str] = None, base_url: Optional[str] = None, api_key: Optional[str] = None,
                 timeout: Optional[float] = None):
        self.model = model or os.getenv("OPENAI_MODEL", "gpt-4.1")
        self.base_url = base_url or os.getenv("OPENAI_BASE_URL")
        self.api_key = api_key or os.getenv("OPENAI_API_KEY")
        # 统一超时（秒），避免网络卡死；默认 60s，可通过 OPENAI_TIMEOUT 环境变量调整
        self.timeout = timeout or float(os.getenv("OPENAI_TIMEOUT", "60"))
        self._client = None
        if _HAS_OPENAI and self.api_key:
            kwargs: Dict[str, Any] = {"api_key": self.api_key, "timeout": self.timeout}
            if self.base_url:
                kwargs["base_url"] = self.base_url
            try:
                self._client = OpenAI(**kwargs)
            except Exception:
                self._client = None

    @property
    def available(self) -> bool:
        return self._client is not None

    def chat(self, system_message: str, user_message: str, temperature: float = 0.2, json_mode: bool = False) -> str:
        if not self.available:
            return ""
        messages = [{"role": "system", "content": system_message}, {"role": "user", "content": user_message}]
        kwargs: Dict[str, Any] = {"model": self.model, "messages": messages, "temperature": temperature, "timeout": self.timeout}
        if json_mode:
            kwargs["response_format"] = {"type": "json_object"}
        try:
            resp = self._client.chat.completions.create(**kwargs)
        except Exception:
            kwargs.pop("response_format", None)
            try:
                resp = self._client.chat.completions.create(**kwargs)
            except Exception:
                return ""
        try:
            return resp.choices[0].message.content or ""
        except Exception:
            return ""

    def embed(self, text: str) -> List[float]:
        if not self.available:
            return []
        try:
            resp = self._client.embeddings.create(model=os.getenv("OPENAI_EMBED_MODEL", "text-embedding-3-small"), input=text, timeout=self.timeout)
            return list(resp.data[0].embedding)
        except Exception:
            return []


# ============================================================
# Layer 0: 统一资产对象 SkillAsset（融合枢纽）
# 生产侧输出 schema 与消费侧 SkillRecord 收敛为同一对象
# ============================================================

@dataclass
class RetrievalEntities:
    """槽位实体（影视化）。"""
    who: List[str] = field(default_factory=list)
    actions: List[str] = field(default_factory=list)
    objects: List[str] = field(default_factory=list)

    @classmethod
    def from_dict(cls, data: Any) -> "RetrievalEntities":
        data = data or {}
        return cls(
            who=list(data.get("who", []) or []),
            actions=list(data.get("actions", []) or []),
            objects=list(data.get("objects", []) or []),
        )

    def to_dict(self) -> Dict[str, List[str]]:
        return {"who": list(self.who), "actions": list(self.actions), "objects": list(self.objects)}


@dataclass
class RetrievalProfile:
    """技能检索画像（影视化）。"""
    logical_topics: List[str] = field(default_factory=list)
    aliases: List[str] = field(default_factory=list)
    sample_queries: List[str] = field(default_factory=list)
    problem_patterns: List[str] = field(default_factory=list)
    entities: RetrievalEntities = field(default_factory=RetrievalEntities)
    scenarios: List[str] = field(default_factory=list)
    project_stages: List[str] = field(default_factory=list)
    urgency: str = "normal"
    negative_queries: List[str] = field(default_factory=list)
    summary: str = ""

    @classmethod
    def from_dict(cls, data: Any) -> "RetrievalProfile":
        data = data or {}
        return cls(
            logical_topics=list(data.get("logical_topics", []) or []),
            aliases=list(data.get("aliases", []) or []),
            sample_queries=list(data.get("sample_queries", []) or []),
            problem_patterns=list(data.get("problem_patterns", []) or []),
            entities=RetrievalEntities.from_dict(data.get("entities", {}) or {}),
            scenarios=list(data.get("scenarios", []) or []),
            project_stages=list(data.get("project_stages", data.get("age_stages", [])) or []),
            urgency=str(data.get("urgency", "normal") or "normal"),
            negative_queries=list(data.get("negative_queries", []) or []),
            summary=str(data.get("summary", "") or ""),
        )

    def to_dict(self) -> Dict[str, Any]:
        return {
            "logical_topics": list(self.logical_topics),
            "aliases": list(self.aliases),
            "sample_queries": list(self.sample_queries),
            "problem_patterns": list(self.problem_patterns),
            "entities": self.entities.to_dict(),
            "scenarios": list(self.scenarios),
            "project_stages": list(self.project_stages),
            "urgency": self.urgency,
            "negative_queries": list(self.negative_queries),
            "summary": self.summary,
        }


@dataclass
class KnowledgeProvenance:
    """知识溯源（支撑置信度门禁）。"""
    sources: List[Dict] = field(default_factory=list)
    knowledge_points: Dict[str, int] = field(default_factory=dict)
    confidence_score: float = 0.0
    confidence_tier: str = "low"
    dimension_coverage: Dict[str, List[str]] = field(default_factory=lambda: {"required": [], "covered": [], "missing": []})

    def to_dict(self) -> Dict[str, Any]:
        return {
            "sources": list(self.sources),
            "knowledge_points": dict(self.knowledge_points),
            "confidence_score": round(self.confidence_score, 4),
            "confidence_tier": self.confidence_tier,
            "dimension_coverage": {k: list(v) for k, v in self.dimension_coverage.items()},
        }


@dataclass
class SkillAsset:
    """
    统一资产对象 —— 生产侧输出与消费侧召回收敛为同一对象。
    含影视化字段、成熟度、知识溯源与创新元信息。
    """
    # —— 基础元信息 ——
    name: str = ""
    skill_id: str = ""
    version: str = "1.0.0"
    last_updated: str = ""
    author: str = "PandaCineForge"
    license: str = "internal"
    status: str = "draft"

    # —— 影视分类（固定 ai_cinema）——
    domain: str = "ai_cinema"
    sub_domain: str = "cinema"
    vertical: str = ""
    type: str = ""
    priority: str = "P1"
    tags: List[str] = field(default_factory=list)

    # —— 影视结构化字段（R0 路由核心）——
    cinematic_role: str = ""
    module_target: List[str] = field(default_factory=list)
    deliverable_type: str = ""
    project_stage: str = ""

    # —— 召回相关 ——
    embedding: List[float] = field(default_factory=list)
    maturity: str = "v0"                # v0/v1/v2/v3
    forge_mode: str = "cold"            # cold/hot
    retrieval_profile: RetrievalProfile = field(default_factory=RetrievalProfile)
    weighted_recall_text: str = ""
    neighbors: List[str] = field(default_factory=list)
    trigger_keywords: List[str] = field(default_factory=list)

    # —— 知识与创新元信息 ——
    knowledge_provenance: KnowledgeProvenance = field(default_factory=KnowledgeProvenance)
    expert_review_log: Dict = field(default_factory=dict)
    innovation_meta: Dict = field(default_factory=dict)

    # —— 执行与契约（影视化）——
    execution_layer: str = "5"
    execution_mode: str = "sequential"
    module_compatibility: Dict = field(default_factory=dict)
    fallback_strategy: Dict = field(default_factory=dict)
    runtime_contract: Dict = field(default_factory=dict)
    execution_contract: Dict = field(default_factory=dict)
    capabilities: Dict = field(default_factory=dict)
    quality_thresholds: Dict = field(default_factory=dict)
    qa_contract: Dict = field(default_factory=dict)
    generation_spec: Dict = field(default_factory=dict)
    persona_adaptation: Dict = field(default_factory=dict)
    domain_pack: Dict = field(default_factory=dict)
    dependencies: Dict = field(default_factory=dict)

    # —— 正文内容（Markdown 输出 / 结构化 body）——
    content: str = ""
    body: Dict = field(default_factory=dict)

    # —— 运行时统计（实战反馈用）——
    call_count: int = 0
    quality_history: List[int] = field(default_factory=list)
    last_quality_score: int = 0

    # 兼容旧字段名 age_stages -> project_stages
    @property
    def age_stages(self) -> List[str]:
        return self.retrieval_profile.project_stages

    @property
    def logical_topics(self) -> List[str]:
        return self.retrieval_profile.logical_topics

    @property
    def aliases(self) -> List[str]:
        return self.retrieval_profile.aliases

    @property
    def sample_queries(self) -> List[str]:
        return self.retrieval_profile.sample_queries

    @property
    def problem_patterns(self) -> List[str]:
        return self.retrieval_profile.problem_patterns

    def to_dict(self) -> Dict[str, Any]:
        d = asdict(self)
        d["retrieval_profile"] = self.retrieval_profile.to_dict()
        d["knowledge_provenance"] = self.knowledge_provenance.to_dict()
        # 默认序列化不含 embedding（大向量，避免膨胀 JSON / 泄露模型向量）
        # 如需召回用 embedding，请使用 to_recall_record()
        d.pop("embedding", None)
        return d

    def to_recall_record(self) -> Dict[str, Any]:
        """供索引器使用的精简召回记录。"""
        return {
            "skill_id": self.skill_id,
            "name": self.name,
            "domain": self.domain,
            "sub_domain": self.sub_domain,
            "cinematic_role": self.cinematic_role,
            "module_target": list(self.module_target),
            "deliverable_type": self.deliverable_type,
            "project_stage": self.project_stage,
            "maturity": self.maturity,
            "priority": self.priority,
            "status": self.status,
            "tags": list(self.tags),
            "aliases": list(self.aliases),
            "sample_queries": list(self.sample_queries),
            "problem_patterns": list(self.problem_patterns),
            "trigger_keywords": list(self.trigger_keywords),
            "logical_topics": list(self.logical_topics),
            "entities": self.retrieval_profile.entities.to_dict(),
            "scenarios": list(self.retrieval_profile.scenarios),
            "project_stages": list(self.retrieval_profile.project_stages),
            "urgency": self.retrieval_profile.urgency,
            "negative_queries": list(self.retrieval_profile.negative_queries),
            "weighted_recall_text": self.weighted_recall_text,
            "neighbors": list(self.neighbors),
            "embedding": list(self.embedding),
        }

    @classmethod
    def from_dict(cls, data: Dict[str, Any]) -> "SkillAsset":
        data = dict(data or {})
        rp = RetrievalProfile.from_dict(data.get("retrieval_profile", {}))
        kp = KnowledgeProvenance()
        if isinstance(data.get("knowledge_provenance"), dict):
            kpd = data["knowledge_provenance"]
            kp.sources = list(kpd.get("sources", []) or [])
            kp.knowledge_points = dict(kpd.get("knowledge_points", {}) or {})
            kp.confidence_score = float(kpd.get("confidence_score", 0.0) or 0.0)
            kp.confidence_tier = str(kpd.get("confidence_tier", "low") or "low")
            kp.dimension_coverage = _normalize_dim_coverage(kpd.get("dimension_coverage"))
        asset = cls(
            name=data.get("name", ""),
            skill_id=data.get("skill_id", ""),
            version=data.get("version", "1.0.0"),
            last_updated=data.get("last_updated", ""),
            author=data.get("author", "PandaCineForge"),
            license=data.get("license", "internal"),
            status=data.get("status", "draft"),
            domain=data.get("domain", "ai_cinema"),
            sub_domain=data.get("sub_domain", "cinema"),
            vertical=data.get("vertical", ""),
            type=data.get("type", ""),
            priority=data.get("priority", "P1"),
            tags=list(data.get("tags", []) or []),
            cinematic_role=data.get("cinematic_role", ""),
            module_target=list(data.get("module_target", []) or []),
            deliverable_type=data.get("deliverable_type", ""),
            project_stage=data.get("project_stage", ""),
            embedding=list(data.get("embedding", []) or []),
            maturity=data.get("maturity", "v0"),
            forge_mode=data.get("forge_mode", "cold"),
            retrieval_profile=rp,
            weighted_recall_text=data.get("weighted_recall_text", ""),
            neighbors=list(data.get("neighbors", []) or []),
            trigger_keywords=list(data.get("trigger_keywords", []) or []),
            knowledge_provenance=kp,
            expert_review_log=data.get("expert_review_log", {}) or {},
            innovation_meta=data.get("innovation_meta", {}) or {},
            execution_layer=data.get("execution_layer", "5"),
            execution_mode=data.get("execution_mode", "sequential"),
            module_compatibility=data.get("module_compatibility", {}) or {},
            fallback_strategy=data.get("fallback_strategy", {}) or {},
            runtime_contract=data.get("runtime_contract", {}) or {},
            execution_contract=data.get("execution_contract", {}) or {},
            capabilities=data.get("capabilities", {}) or {},
            quality_thresholds=data.get("quality_thresholds", {}) or {},
            qa_contract=data.get("qa_contract", {}) or {},
            generation_spec=data.get("generation_spec", {}) or {},
            persona_adaptation=data.get("persona_adaptation", {}) or {},
            domain_pack=data.get("domain_pack", {}) or {},
            dependencies=data.get("dependencies", {}) or {},
            content=data.get("content", ""),
            body=data.get("body", {}) or {},
            call_count=_safe_int(data.get("call_count", 0)),
            quality_history=_safe_list(data.get("quality_history", [])),
            last_quality_score=_safe_int(data.get("last_quality_score", 0)),
        )
        return asset


# ============================================================
# 召回层数据模型（影视化）
# ============================================================

@dataclass
class TopicScore:
    topic: str
    confidence: float
    evidence: List[str] = field(default_factory=list)


@dataclass
class QueryUnderstanding:
    """查询理解结果（影视化）。"""
    raw_text: str = ""
    normalized_text: str = ""
    expanded_queries: List[str] = field(default_factory=list)
    char_ngrams: Tuple[str, ...] = ()
    slots: RetrievalEntities = field(default_factory=RetrievalEntities)
    scenarios: List[str] = field(default_factory=list)
    project_stages: List[str] = field(default_factory=list)
    urgency: str = "normal"
    topics: List[TopicScore] = field(default_factory=list)
    # 契约携带的结构化路由字段（AI 调用专属）
    route_fields: Dict[str, Any] = field(default_factory=dict)
    context: Dict[str, Any] = field(default_factory=dict)


@dataclass
class RecallCandidate:
    skill_id: str
    rrf_score: float = 0.0
    rank_by_layer: Dict[str, int] = field(default_factory=dict)
    layer_scores: Dict[str, float] = field(default_factory=dict)
    evidences: Dict[str, List[str]] = field(default_factory=dict)


@dataclass
class RecallResult:
    understanding: QueryUnderstanding
    candidates: List[RecallCandidate] = field(default_factory=list)
    layer_rankings: Dict[str, List[str]] = field(default_factory=dict)
    hit_layer: str = ""


@dataclass
class RankedSkill:
    skill_id: str
    name: str
    domain: str
    score: float
    details: Dict[str, object] = field(default_factory=dict)


# ============================================================
# Layer 1: 生产侧 —— 外部专业知识获取（七子模块）
# ============================================================

class QueryComposer:
    """子模块1：查询构造器。三路并发构造专业搜索查询。"""

    def compose(self, cinematic_role: str, deliverable_type: str, sub_domain: str,
                project_stage: str = "", query_text: str = "", mode: str = "cold") -> List[str]:
        tools = CINEMA_TOOL_MAP.get(cinematic_role, [])
        tool_str = " ".join(tools[:3]) if tools else ""
        role_zh = cinematic_role.replace("_", " ")
        queries = [
            f"{role_zh} {deliverable_type} 原理 教程 指南",
            f"{tool_str} {deliverable_type} 参数 最佳实践" if tool_str else f"{role_zh} {deliverable_type} 最佳实践",
            f"{role_zh} {deliverable_type} 标准 规范 Rec.709 Rec.2020 ACES",
        ]
        if query_text:
            queries.append(query_text)
        # 热运行仅发路A（原理查询），冷启动三路全发
        if mode == "hot":
            queries = queries[:1]
        return [q.strip() for q in queries if q.strip()]


class SearchGateway:
    """子模块2：搜索网关。动态适配方接入的搜索 API，运行时探测，故障转移，DuckDuckGo 兜底。"""

    def __init__(self):
        self.active = self._detect_providers()

    def _detect_providers(self) -> List[str]:
        available = []
        for name, cfg in SEARCH_PROVIDER_REGISTRY.items():
            if not cfg["needs_key"]:
                available.append(name)
                continue
            if any(os.getenv(k) for k in cfg["env_keys"]):
                available.append(name)
        if not available:
            available.append("duckduckgo")
        return available

    def search(self, query: str, topk: int = 10) -> List[Dict]:
        results: List[Dict] = []
        for provider in self.active:
            try:
                results.extend(self._search_one(provider, query, topk))
            except Exception:
                continue
        return self._merge_dedupe(results)[:topk * 2]

    def _search_one(self, provider: str, query: str, topk: int) -> List[Dict]:
        # 各适配器实现统一 search(query, topk) 接口；此处按 provider 分发
        if provider == "tavily":
            return self._search_tavily(query, topk)
        if provider == "bing":
            return self._search_bing(query, topk)
        if provider == "brave":
            return self._search_brave(query, topk)
        if provider == "serpapi":
            return self._search_serpapi(query, topk)
        if provider == "google_cse":
            return self._search_google_cse(query, topk)
        if provider == "searxng":
            return self._search_searxng(query, topk)
        return self._search_duckduckgo(query, topk)

    def _search_tavily(self, query: str, topk: int) -> List[Dict]:
        key = os.getenv("TAVILY_API_KEY")
        if not key:
            return []
        import urllib.request, urllib.parse
        url = "https://api.tavily.com/search"
        payload = json.dumps({"api_key": key, "query": query, "max_results": topk}).encode("utf-8")
        req = urllib.request.Request(url, data=payload, headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("results", []):
                out.append({"url": r.get("url"), "title": r.get("title"), "snippet": r.get("content", "")[:300], "source_domain": self._domain(r.get("url", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("tavily search failed: %s", e)
            return []

    def _search_bing(self, query: str, topk: int) -> List[Dict]:
        key = os.getenv("BING_API_KEY") or os.getenv("AZURE_BING_KEY")
        if not key:
            return []
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "count": topk, "mkt": "zh-CN"})
        url = f"https://api.bing.microsoft.com/v7.0/search?{params}"
        req = urllib.request.Request(url, headers={"Ocp-Apim-Subscription-Key": key})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("webPages", {}).get("value", []):
                out.append({"url": r.get("url"), "title": r.get("name"), "snippet": r.get("snippet", "")[:300], "source_domain": self._domain(r.get("url", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("bing search failed: %s", e)
            return []

    def _search_brave(self, query: str, topk: int) -> List[Dict]:
        key = os.getenv("BRAVE_API_KEY")
        if not key:
            return []
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "count": topk})
        url = f"https://api.search.brave.com/res/v1/web/search?{params}"
        req = urllib.request.Request(url, headers={"X-Subscription-Token": key, "Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("web", {}).get("results", []):
                out.append({"url": r.get("url"), "title": r.get("title"), "snippet": r.get("description", "")[:300], "source_domain": self._domain(r.get("url", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("brave search failed: %s", e)
            return []

    def _search_serpapi(self, query: str, topk: int) -> List[Dict]:
        key = os.getenv("SERPAPI_API_KEY")
        if not key:
            return []
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "api_key": key, "engine": "google", "num": topk})
        url = f"https://serpapi.com/search.json?{params}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("organic_results", []):
                out.append({"url": r.get("link"), "title": r.get("title"), "snippet": r.get("snippet", "")[:300], "source_domain": self._domain(r.get("link", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("serpapi search failed: %s", e)
            return []

    def _search_google_cse(self, query: str, topk: int) -> List[Dict]:
        key = os.getenv("GOOGLE_CSE_API_KEY")
        cse_id = os.getenv("GOOGLE_CSE_ID")
        if not key or not cse_id:
            return []
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "key": key, "cx": cse_id, "num": topk})
        url = f"https://www.googleapis.com/customsearch/v1?{params}"
        req = urllib.request.Request(url)
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("items", []):
                out.append({"url": r.get("link"), "title": r.get("title"), "snippet": r.get("snippet", "")[:300], "source_domain": self._domain(r.get("link", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("google_cse search failed: %s", e)
            return []

    def _search_searxng(self, query: str, topk: int) -> List[Dict]:
        base = os.getenv("SEARXNG_BASE_URL")
        if not base:
            return []
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "format": "json", "categories": "general"})
        url = f"{base.rstrip('/')}/search?{params}"
        req = urllib.request.Request(url, headers={"Accept": "application/json"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            out = []
            for r in data.get("results", []):
                out.append({"url": r.get("url"), "title": r.get("title"), "snippet": r.get("content", "")[:300], "source_domain": self._domain(r.get("url", "")), "rank": len(out) + 1})
            return out
        except Exception as e:
            logger.warning("searxng search failed: %s", e)
            return []

    def _search_duckduckgo(self, query: str, topk: int) -> List[Dict]:
        """DuckDuckGo HTML 兜底（免 Key）。"""
        import urllib.request, urllib.parse
        params = urllib.parse.urlencode({"q": query, "kl": "cn-zh"})
        url = f"https://html.duckduckgo.com/html/?{params}"
        req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
        try:
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
        except Exception:
            return []
        out = []
        for m in re.finditer(r'<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>(.*?)</a>', html, re.S):
            raw_url, title = m.group(1), re.sub(r"<[^>]+>", "", m.group(2))
            real_url = urllib.parse.unquote(raw_url.replace("//duckduckgo.com/l/?uddg=", "").split("&")[0]) if "uddg=" in raw_url else raw_url
            snippet = ""
            sm = re.search(re.escape(m.group(0)) + r'.*?<a[^>]+class="result__snippet"[^>]*>(.*?)</a>', html, re.S)
            if sm:
                snippet = re.sub(r"<[^>]+>", "", sm.group(1))[:300]
            out.append({"url": real_url, "title": title.strip(), "snippet": snippet, "source_domain": self._domain(real_url), "rank": len(out) + 1})
            if len(out) >= topk:
                break
        return out

    @staticmethod
    def _domain(url: str) -> str:
        try:
            from urllib.parse import urlparse
            net = urlparse(url).netloc.lower()
            return net[4:] if net.startswith("www.") else net
        except Exception:
            return ""

    @staticmethod
    def _merge_dedupe(results: List[Dict]) -> List[Dict]:
        seen, out = set(), []
        for r in results:
            u = r.get("url", "")
            if u and u not in seen:
                seen.add(u)
                out.append(r)
        return out


class SourceRouter:
    """子模块3：源头路由器。白名单 + 通用网页评估。"""

    def __init__(self):
        self.domain_trust: Dict[str, float] = {}
        self.domain_session: Dict[str, str] = {}
        for s in CINEMA_SEED_SOURCES:
            self.domain_trust[s["domain"]] = s["trust"]
            self.domain_session[s["domain"]] = s["session"]

    def route(self, results: List[Dict]) -> List[Dict]:
        routed = []
        for r in results:
            domain = r.get("source_domain", "")
            trust = self._trust(domain)
            if trust <= 0:
                continue
            r["trust_score"] = trust
            r["crawl_session"] = self._session(domain, trust)
            routed.append(r)
        routed.sort(key=lambda x: x.get("trust_score", 0), reverse=True)
        return routed

    def _trust(self, domain: str) -> float:
        if not domain:
            return 0.3
        for seed_domain, trust in self.domain_trust.items():
            if domain == seed_domain or domain.endswith("." + seed_domain):
                return trust
        if any(d in domain for d in ("github.com", "medium.com", "stackoverflow.com", "csdn.net", "juejin.cn")):
            return 0.7
        return 0.3

    def _session(self, domain: str, trust: float) -> str:
        for seed_domain, sess in self.domain_session.items():
            if domain == seed_domain or domain.endswith("." + seed_domain):
                return sess
        return "fast" if trust >= 0.7 else "dynamic"


class CrawlDispatcher:
    """子模块4：爬虫调度器（Scrapling 集成核心）。三会话分级抓取，可扩展代理池。"""

    def __init__(self, proxy_rotator=None):
        self.proxy_rotator = proxy_rotator  # 默认 None，未来可热插拔
        self._sessions: Dict[str, Any] = {}

    def _get_session(self, session_id: str):
        if session_id in self._sessions:
            return self._sessions[session_id]
        try:
            from scrapling.fetchers import Fetcher, StealthyFetcher, DynamicFetcher  # type: ignore
        except Exception:
            self._sessions[session_id] = None
            return None
        sess = None
        try:
            if session_id == "fast":
                sess = Fetcher(impersonate="chrome", http3=True)
            elif session_id == "stealth":
                sess = StealthyFetcher(headless=True, solve_cloudflare=True, stealthy_headers=True)
            elif session_id == "dynamic":
                sess = DynamicFetcher(headless=True, network_idle=True)
        except Exception:
            sess = None
        self._sessions[session_id] = sess
        return sess

    def fetch(self, url: str, session_id: str = "fast") -> Dict:
        sess = self._get_session(session_id)
        kwargs: Dict[str, Any] = {}
        if self.proxy_rotator:
            kwargs["proxy"] = self.proxy_rotator.next()
        if sess is None:
            return self._fallback_fetch(url)
        try:
            page = sess.fetch(url, **kwargs)
            content = page.css_first("article, .content, main, .entry-content, .post-content")
            text = content.text if content else page.get_all_text()
            return {"url": url, "raw_content": text or "", "ok": True}
        except Exception as e:
            return {"url": url, "raw_content": "", "ok": False, "error": str(e)}

    def _fallback_fetch(self, url: str) -> Dict:
        """无 Scrapling 时的 urllib 兜底（仅抓开放站点）。"""
        import urllib.request
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"})
            with urllib.request.urlopen(req, timeout=15) as resp:
                html = resp.read().decode("utf-8", errors="ignore")
            text = re.sub(r"<script[^>]*>.*?</script>", "", html, flags=re.S)
            text = re.sub(r"<style[^>]*>.*?</style>", "", text, flags=re.S)
            text = re.sub(r"<[^>]+>", " ", text)
            text = re.sub(r"\s+", " ", text).strip()
            return {"url": url, "raw_content": text, "ok": True}
        except Exception as e:
            return {"url": url, "raw_content": "", "ok": False, "error": str(e)}


class ContentExtractor:
    """子模块5：内容萃取器。两阶段：正文去噪 + LLM 要点萃取。"""

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()

    EXTRACT_PROMPT = (
        "你是影视专业知识萃取官。对以下网页正文做要点萃取，输出严格 JSON：\n"
        '{"principles":[],"standards":[],"tool_params":[],"case_refs":[],"heuristics":[],"pitfalls":[]}\n'
        "每个数组填入该网页中与影视创作相关的专业要点（简短条目）。无则空数组。只输出 JSON。"
    )

    def extract(self, page: Dict, trust_score: float = 0.5) -> Optional[Dict]:
        raw = page.get("raw_content", "")
        if not raw or len(raw) < 50:
            return None
        domain = SearchGateway._domain(page.get("url", ""))
        # 阶段2：LLM 要点萃取（输入是去噪后的正文）
        points: Dict[str, List[str]] = {
            "principles": [], "standards": [], "tool_params": [],
            "case_refs": [], "heuristics": [], "pitfalls": [],
        }
        if self.llm.available:
            text = raw[:4000]
            out = self.llm.chat(self.EXTRACT_PROMPT, text, temperature=0.1, json_mode=True)
            try:
                cleaned = out.strip()
                if cleaned.startswith("```"):
                    cleaned = "\n".join(cleaned.splitlines()[1:-1])
                parsed = json.loads(cleaned)
                for k in points:
                    points[k] = list(parsed.get(k, []) or [])[:8]
            except Exception:
                pass
        return {
            "principles": points["principles"], "standards": points["standards"],
            "tool_params": points["tool_params"], "case_refs": points["case_refs"],
            "heuristics": points["heuristics"], "pitfalls": points["pitfalls"],
            "source_url": page.get("url", ""), "source_domain": domain,
            "trust_score": trust_score, "extracted_at": now_iso(),
        }


class KnowledgeFilter:
    """子模块6：知识过滤器。去重 + 质量评分 + 相关性 + 影视专业度。"""

    def filter(self, points_list: List[Dict], cinematic_role: str, deliverable_type: str, topk: int = 8) -> List[Dict]:
        seen, merged = set(), []
        for p in points_list:
            for dim in ("principles", "standards", "tool_params", "case_refs", "heuristics", "pitfalls"):
                for item in p.get(dim, []):
                    key = _hash_key(dim, str(item))
                    if key in seen:
                        continue
                    seen.add(key)
                    merged.append({"dim": dim, "text": item, "source": p.get("source_domain", ""), "trust": p.get("trust_score", 0.5)})
        scored = []
        cinema_kw = set(sum([v["keywords"] for v in CINEMA_TOPICS.values()], []))
        for m in merged:
            score = m["trust"]
            if any(kw in m["text"] for kw in cinema_kw):
                score += 0.3
            if deliverable_type and deliverable_type.replace("_", " ") in m["text"]:
                score += 0.2
            scored.append((score, m))
        scored.sort(key=lambda x: x[0], reverse=True)
        return [m for _, m in scored[:topk]]


class KnowledgeCache:
    """子模块7：知识缓存。TTL + 增量更新 + 实战反馈回流。"""

    TTL_BY_CLASS = {"规范标准": 90, "工具官方文档": 30, "案例专业": 14, "学术权威": 90, "社区经验": 14, "平台规则": 14}

    def __init__(self):
        self._store: Dict[str, Dict] = {}
        self._feedback: Dict[str, List[str]] = defaultdict(list)  # pitfalls 回流

    def get(self, *key_parts) -> Optional[List[Dict]]:
        key = _hash_key(*key_parts)
        entry = self._store.get(key)
        if not entry:
            return None
        age_days = (time.time() - entry["ts"]) / 86400
        if age_days > entry["ttl"]:
            return None
        return entry["points"]

    def set(self, points: List[Dict], source_class: str = "社区经验", *key_parts):
        key = _hash_key(*key_parts)
        self._store[key] = {
            "points": points, "ts": time.time(),
            "ttl": self.TTL_BY_CLASS.get(source_class, 30) * 86400,
        }

    def feedback(self, role: str, deliverable_type: str, pitfall: str):
        """实战反馈回流到 pitfalls 维度。"""
        self._feedback[f"{role}||{deliverable_type}"].append(pitfall)

    def get_pitfalls(self, role: str, deliverable_type: str) -> List[str]:
        return list(self._feedback.get(f"{role}||{deliverable_type}", []))


class ExternalKnowledgeFetcher:
    """外部专业知识获取模块（七子模块组合）。冷启动深抓，热运行浅抓+超时降级。"""

    def __init__(self, llm: Optional[LLMClient] = None, proxy_rotator=None):
        self.llm = llm or LLMClient()
        self.query_composer = QueryComposer()
        self.search_gateway = SearchGateway()
        self.source_router = SourceRouter()
        self.crawl_dispatcher = CrawlDispatcher(proxy_rotator=proxy_rotator)
        self.content_extractor = ContentExtractor(self.llm)
        self.knowledge_filter = KnowledgeFilter()
        self.cache = KnowledgeCache()

    def fetch(self, cinematic_role: str, deliverable_type: str, sub_domain: str,
              project_stage: str = "", query_text: str = "", mode: str = "cold",
              timeout: float = 15.0) -> Tuple[List[Dict], KnowledgeProvenance]:
        """获取外部知识要点集 + 知识溯源。返回 (要点集, provenance)。"""
        # 缓存检查
        cached = self.cache.get(cinematic_role, deliverable_type, sub_domain)
        if cached is not None:
            provenance = self._build_provenance(cached, deliverable_type, cached_sources=True)
            return cached, provenance

        # 热运行超时降级：超时则仅用模型内部知识（返回空要点，provenance 标记降级）
        start = time.time()
        max_pages = 12 if mode == "cold" else 5

        queries = self.query_composer.compose(cinematic_role, deliverable_type, sub_domain, project_stage, query_text, mode)
        all_results: List[Dict] = []
        for q in queries:
            if time.time() - start > timeout:
                break
            all_results.extend(self.search_gateway.search(q, topk=10))

        routed = self.source_router.route(all_results)[:max_pages]
        points_list: List[Dict] = []
        for r in routed:
            if time.time() - start > timeout:
                break
            page = self.crawl_dispatcher.fetch(r["url"], r.get("crawl_session", "fast"))
            if not page.get("ok"):
                continue
            points = self.content_extractor.extract(page, r.get("trust_score", 0.5))
            if points:
                points_list.append(points)

        filtered = self.knowledge_filter.filter(points_list, cinematic_role, deliverable_type, topk=8 if mode == "cold" else 5)
        self.cache.set(filtered, "社区经验", cinematic_role, deliverable_type, sub_domain)

        # 注入实战反馈 pitfalls
        for pit in self.cache.get_pitfalls(cinematic_role, deliverable_type):
            filtered.append({"dim": "pitfalls", "text": pit, "source": "实战反馈", "trust": 0.8})

        provenance = self._build_provenance(filtered, deliverable_type, sources=routed, points_list=points_list)
        if time.time() - start > timeout:
            provenance.confidence_tier = "low"
            provenance.confidence_score = 0.0
        return filtered, provenance

    def _build_provenance(self, filtered: List[Dict], deliverable_type: str,
                          sources: Optional[List[Dict]] = None, points_list: Optional[List[Dict]] = None,
                          cached_sources: bool = False) -> KnowledgeProvenance:
        kp = KnowledgeProvenance()
        if sources:
            kp.sources = [{"url": s.get("url", ""), "domain": s.get("source_domain", ""), "trust_score": s.get("trust_score", 0.5), "source_class": _seed_class(s.get("source_domain", ""))} for s in sources]
        elif points_list:
            kp.sources = [{"url": p.get("source_url", ""), "domain": p.get("source_domain", ""), "trust_score": p.get("trust_score", 0.5), "source_class": _seed_class(p.get("source_domain", ""))} for p in points_list]
        # 维度计数
        for item in filtered:
            dim = item.get("dim", "heuristics")
            kp.knowledge_points[dim] = kp.knowledge_points.get(dim, 0) + 1
        # 维度覆盖
        dim_map = DELIVERABLE_DIMENSION_MAP.get(deliverable_type, {"required": [], "bonus": []})
        covered = [dim for dim in dim_map["required"] if kp.knowledge_points.get(dim, 0) > 0]
        kp.dimension_coverage = {"required": dim_map["required"], "covered": covered, "missing": [d for d in dim_map["required"] if d not in covered]}
        # 置信度评分
        if kp.sources:
            avg_trust = sum(s["trust_score"] for s in kp.sources) / len(kp.sources)
            total_points = sum(kp.knowledge_points.values())
            coverage = len(covered) / max(1, len(dim_map["required"]))
            kp.confidence_score = round(avg_trust * 0.5 + min(1.0, total_points / 12) * 0.3 + coverage * 0.2, 4)
            if avg_trust >= 0.9 and total_points >= 10 and coverage >= 0.8:
                kp.confidence_tier = "high"
            elif avg_trust >= 0.7 and total_points >= 6 and coverage >= 0.6:
                kp.confidence_tier = "medium"
            else:
                kp.confidence_tier = "low"
        return kp


def _seed_class(domain: str) -> str:
    for s in CINEMA_SEED_SOURCES:
        if domain == s["domain"] or domain.endswith("." + s["domain"]):
            return s["category"]
    return "通用网页"


# ============================================================
# Layer 1: 知识融合层（Layer B）
# ============================================================

class KnowledgeFusionLayer:
    """外部知识要点集 + 模型内部知识 + 用户画像/上下文 → 融合成增强 prompt。"""

    def fuse(self, filtered: List[Dict], provenance: KnowledgeProvenance,
             base_payload: Dict, internal_knowledge: str = "") -> str:
        sections = []
        sections.append("【外部专业知识要点】")
        by_dim: Dict[str, List[str]] = defaultdict(list)
        for item in filtered:
            by_dim[item.get("dim", "heuristics")].append(item.get("text", ""))
        dim_zh = {"principles": "原理", "standards": "规范", "tool_params": "工具参数", "case_refs": "案例参考", "heuristics": "经验法则", "pitfalls": "已知坑"}
        for dim, items in by_dim.items():
            if items:
                sections.append(f"- {dim_zh.get(dim, dim)}：")
                for it in items[:6]:
                    sections.append(f"  · {it}")
        sections.append(f"\n【知识置信度】tier={provenance.confidence_tier} score={provenance.confidence_score} 覆盖={provenance.dimension_coverage.get('covered', [])}/{provenance.dimension_coverage.get('required', [])}")
        if internal_knowledge:
            sections.append(f"\n【模型内部知识】{internal_knowledge}")
        sections.append(f"\n【生成规格】{json.dumps(base_payload, ensure_ascii=False)[:1500]}")
        return "\n".join(sections)


# ============================================================
# Layer 1: 多阶段锻造层（Layer C）+ 三段式专业性保障（§6）
# ============================================================

class ConfidenceGate:
    """第一段：知识置信度门禁。零额外 LLM 调用，结构化规则计算。"""

    def judge(self, provenance: KnowledgeProvenance, deliverable_type: str) -> Tuple[str, str]:
        """
        返回 (verdict, maturity)：
          high -> ('pass', 'v2')
          medium -> ('review', 'v1')
          low -> ('low', 'v1')
        """
        sources = provenance.sources
        if not sources:
            return "low", "v1"
        trusts = [s.get("trust_score", 0) for s in sources]
        min_trust = min(trusts) if trusts else 0
        avg_trust = sum(trusts) / len(trusts) if trusts else 0
        total_points = sum(provenance.knowledge_points.values())
        coverage = len(provenance.dimension_coverage.get("covered", [])) / max(1, len(provenance.dimension_coverage.get("required", [])))

        th = CONFIDENCE_THRESHOLDS
        if min_trust >= th["high"]["min_trust"] and total_points >= th["high"]["min_points"] and coverage >= th["high"]["min_coverage"]:
            return "pass", "v2"
        if avg_trust >= 0.7 and total_points >= 6 and coverage >= 0.6:
            return "review", "v1"
        return "low", "v1"


class LightweightReviewer:
    """第二段：轻量单次评审兜底。仅中置信度触发，单次 LLM 调用。"""

    REVIEW_PROMPT = (
        "你是影视专业质检官。对以下技能做一次性专业度评审，输出严格 JSON：\n"
        '{"verdict":"pass|rework|reject","score":0-100,"issues":[],"missing_dimensions":[]}\n'
        "评审 rubric：1.专业知识准确性 2.规范符合性 3.可执行性 4.知识完整性 5.风险控制。\n"
        "verdict=pass 直接 v2；rework 按 issues 返工后重判；reject 降 v1。只输出 JSON。"
    )

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()

    def review(self, skill: "SkillAsset") -> Tuple[str, int, List[str]]:
        if not self.llm.available:
            return "pass", 85, []  # 无 LLM 时放行
        content = (skill.content or json.dumps(skill.body, ensure_ascii=False))[:3000]
        out = self.llm.chat(self.REVIEW_PROMPT, content, temperature=0.1, json_mode=True)
        try:
            cleaned = out.strip()
            if cleaned.startswith("```"):
                cleaned = "\n".join(cleaned.splitlines()[1:-1])
            data = json.loads(cleaned)
            verdict = data.get("verdict", "pass")
            score = int(data.get("score", 80))
            issues = list(data.get("issues", []) or [])
            skill.expert_review_log = {"verdict": verdict, "score": score, "issues": issues, "reviewed_at": now_iso()}
            return verdict, score, issues
        except Exception:
            return "pass", 80, []


class FeedbackEvolver:
    """第三段：实战反馈自然选择。所有技能入库后持续验证。"""

    def __init__(self, knowledge_cache: Optional[KnowledgeCache] = None):
        self.cache = knowledge_cache

    def record(self, skill: "SkillAsset", outcome: str, quality_score: int,
               failure_reasons: Optional[List[str]] = None, user_corrections: Optional[List[str]] = None):
        skill.call_count += 1
        skill.quality_history.append(quality_score)
        skill.last_quality_score = quality_score
        if len(skill.quality_history) > 20:
            skill.quality_history = skill.quality_history[-20:]
        # 成熟度进化（建议 N=3 升级, M=2 降级）
        self._evolve_maturity(skill, quality_score)
        # 反馈回流飞轮
        reasons = list(failure_reasons or []) + list(user_corrections or [])
        if reasons and self.cache:
            for r in reasons:
                self.cache.feedback(skill.cinematic_role, skill.deliverable_type, r)

    def _evolve_maturity(self, skill: "SkillAsset", quality_score: int):
        hist = skill.quality_history
        if not hist:
            return
        # 基于"末尾连续达标/不达标计数"判定，避免旧记录干扰
        consec_pass = self._count_consecutive_tail(hist, threshold=85, direction="ge")
        consec_fail = self._count_consecutive_tail(hist, threshold=60, direction="lt")
        if skill.maturity == "v1":
            if consec_pass >= 3:
                skill.maturity = "v2"
            elif consec_fail >= 2:
                skill.maturity = "v0"
        elif skill.maturity == "v2":
            if consec_pass >= 3:
                skill.maturity = "v3"
            elif consec_fail >= 2:
                skill.maturity = "v1"
        elif skill.maturity == "v3":
            if consec_fail >= 2:
                skill.maturity = "v2"

    @staticmethod
    def _count_consecutive_tail(hist: List[int], threshold: int, direction: str) -> int:
        """从 history 末尾向前数连续满足条件的次数（仅看最近连续，不含被中断的旧记录）。"""
        count = 0
        for q in reversed(hist):
            ok = (q >= threshold) if direction == "ge" else (q < threshold)
            if ok:
                count += 1
            else:
                break
        return count


class MultiStageForger:
    """多阶段锻造层。五阶段递进，每阶段有质量门。"""

    def __init__(self, llm: Optional[LLMClient] = None, knowledge_fetcher: Optional[ExternalKnowledgeFetcher] = None):
        self.llm = llm or LLMClient()
        self.knowledge_fetcher = knowledge_fetcher or ExternalKnowledgeFetcher(self.llm)
        self.fusion = KnowledgeFusionLayer()
        self.confidence_gate = ConfidenceGate()
        self.reviewer = LightweightReviewer(self.llm)
        self.max_rework_rounds = 2

    def forge(self, payload: Dict, system_message: str, user_template: str,
              mode: str = "cold", rework_rounds: int = 0) -> "SkillAsset":
        cinematic_role = payload.get("cinematic_role", "")
        deliverable_type = payload.get("deliverable_type", "")
        sub_domain = payload.get("sub_domain", "cinema")

        # Stage 0: 外部知识获取（无 LLM 时降级跳过，避免无意义网络抓取拖垮冷启动）
        # 加 try/except + 降级：单条知识获取失败不应击穿整条 forge（批量冷启动容错）
        if self.llm.available:
            try:
                filtered, provenance = self.knowledge_fetcher.fetch(
                    cinematic_role, deliverable_type, sub_domain,
                    payload.get("project_stage", ""), payload.get("query_text", ""), mode
                )
            except Exception as e:
                logger.warning("外部知识获取失败，降级为空知识继续锻造 [%s]: %s", sub_domain, e)
                filtered, provenance = [], KnowledgeProvenance()
        else:
            filtered, provenance = [], KnowledgeProvenance()

        # Layer B: 知识融合
        fused_prompt = self.fusion.fuse(filtered, provenance, payload)

        # Stage 1-2: 骨架生成 + 专业填充（单次 LLM 调用，融合知识注入）
        skill = self._generate_skill(payload, system_message, user_template, fused_prompt)

        skill.knowledge_provenance = provenance
        skill.forge_mode = mode

        # Stage 3: 专业性保障（三段式）
        skill = self._assurance(skill, provenance, deliverable_type, mode)

        # Stage 4: 返工优化（仅 rework 触发）
        if skill.status == "rework" and rework_rounds < self.max_rework_rounds:
            payload["_rework_issues"] = skill.expert_review_log.get("issues", [])
            return self.forge(payload, system_message, user_template, mode, rework_rounds + 1)

        # Stage 5: 落盘准备（embedding 生成）
        skill.embedding = self._gen_embedding(skill)
        skill.status = "active" if skill.maturity in ("v2", "v3") else "draft"
        return skill

    def _generate_skill(self, payload: Dict, system_message: str, user_template: str, fused_prompt: str) -> "SkillAsset":
        # 渲染 UserMessage（Jinja2）
        render_ctx = dict(payload)
        render_ctx["fused_knowledge"] = fused_prompt
        user_message = self._render_template(user_template, render_ctx)

        # 调用 LLM
        if self.llm.available:
            raw = self.llm.chat(system_message, user_message, temperature=0.2,
                                json_mode=(payload.get("output_format") == "json"))
        else:
            raw = ""  # 无 LLM 时生成骨架占位

        # 解析输出为 SkillAsset
        skill = self._parse_output(raw, payload)
        if not skill.content and raw:
            skill.content = raw
        return skill

    def _render_template(self, template_text: str, ctx: Dict) -> str:
        if not _HAS_JINJA:
            # 无 Jinja 时做简单 {{var}} 替换
            out = template_text
            for k, v in ctx.items():
                val = json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v)
                out = out.replace("{{" + k + "}}", val)
            return out
        # 允许缺失变量：用宽松 Undefined，避免 payload 字段不全时渲染崩溃
        from jinja2 import Environment, Undefined  # type: ignore
        env = Environment(autoescape=False, undefined=Undefined, trim_blocks=False, lstrip_blocks=False,
                          finalize=lambda v: json.dumps(v, ensure_ascii=False, indent=2) if isinstance(v, (dict, list)) else ("null" if v is None else v))
        return env.from_string(template_text).render(**ctx)

    def _parse_output(self, raw: str, payload: Dict) -> "SkillAsset":
        data: Dict[str, Any] = {}
        if raw:
            cleaned = raw.strip()
            # 去除首尾 ``` 围栏（稳健：仅去首行开围栏与末行闭围栏，避免 splitlines[1:-1] 误切单围栏内容）
            cleaned = re.sub(r"^\s*```[a-zA-Z]*\s*\n?", "", cleaned)
            cleaned = re.sub(r"\n?\s*```\s*$", "", cleaned)
            fmt = payload.get("output_format", "json")
            if fmt == "json":
                try:
                    data = json.loads(cleaned)
                except Exception:
                    data = {}
            elif fmt == "yaml" and _HAS_YAML:
                try:
                    data = yaml.safe_load(cleaned) or {}
                except Exception:
                    data = {}
            elif fmt == "markdown":
                # 从 Frontmatter 提取
                fm = re.search(r"^---\s*\n(.*?)\n---", cleaned, re.S)
                if fm and _HAS_YAML:
                    try:
                        data = yaml.safe_load(fm.group(1)) or {}
                    except Exception:
                        data = {}
                data.setdefault("content", cleaned)
            # 容错：LLM 返回数组/字符串/数字等非对象 JSON 时，降级为空 dict，避免后续 setdefault 崩溃
            if not isinstance(data, dict):
                logger.warning("LLM 输出非对象 JSON，降级为空 dict: %.80s", str(data))
                data = {}
        # 主键与结构化路由字段：payload 显式传入的值优先于 LLM 输出
        # （skill_id 主键稳定不得擅自改写；cinematic_role/module_target/deliverable_type/sub_domain
        #  是 R0 路由核心字段，必须以调用方 payload 为准，防止 LLM 输出偏移导致路由错乱）
        _PAYLOAD_PRIORITY_KEYS = ("skill_id", "domain", "sub_domain", "cinematic_role",
                                  "module_target", "deliverable_type", "project_stage")
        for k in _PAYLOAD_PRIORITY_KEYS:
            pv = payload.get(k)
            if pv is not None and pv != "" and pv != []:
                data[k] = pv
        # 其余字段：payload 提供默认值，LLM 输出已有时保留 LLM 输出
        data.setdefault("skill_id", payload.get("skill_id") or gen_id("skill"))
        data.setdefault("name", payload.get("skill_name") or payload.get("title") or data.get("name") or "未命名技能")
        data.setdefault("version", payload.get("package_version") or data.get("version") or "1.0.0")
        data.setdefault("last_updated", data.get("last_updated") or now_iso())
        data.setdefault("domain", data.get("domain") or "ai_cinema")
        data.setdefault("sub_domain", data.get("sub_domain") or payload.get("sub_domain") or "cinema")
        data.setdefault("cinematic_role", data.get("cinematic_role") or payload.get("cinematic_role") or "")
        data.setdefault("module_target", data.get("module_target") or payload.get("module_target") or [])
        data.setdefault("deliverable_type", data.get("deliverable_type") or payload.get("deliverable_type") or "")
        data.setdefault("project_stage", data.get("project_stage") or payload.get("project_stage") or "")
        data.setdefault("forge_mode", payload.get("forge_mode", "cold"))
        data.setdefault("maturity", data.get("maturity", "v0"))
        data.setdefault("status", data.get("status", "draft"))
        # 生成召回文本
        if not data.get("weighted_recall_text"):
            data["weighted_recall_text"] = _build_weighted_recall_text(data)
        return SkillAsset.from_dict(data)

    def _assurance(self, skill: "SkillAsset", provenance: KnowledgeProvenance, deliverable_type: str, mode: str) -> "SkillAsset":
        # 第一段：知识置信度门禁
        verdict, maturity = self.confidence_gate.judge(provenance, deliverable_type)
        if verdict == "pass":
            skill.maturity = "v2"
            skill.status = "active"
            return skill
        if verdict == "low":
            skill.maturity = "v1"
            skill.status = "draft"
            return skill
        # 第二段：中置信度 -> 轻量评审（热运行超时则跳过，v1 入库后异步）
        if mode == "hot":
            skill.maturity = "v1"
            skill.status = "draft"
            return skill
        review_verdict, score, issues = self.reviewer.review(skill)
        if review_verdict == "pass":
            skill.maturity = "v2"
            skill.status = "active"
        elif review_verdict == "rework":
            skill.maturity = "v1"
            skill.status = "rework"
        else:  # reject
            skill.maturity = "v1"
            skill.status = "draft"
        return skill

    def _gen_embedding(self, skill: "SkillAsset") -> List[float]:
        # 优先用召回文本，其次名称，最后正文片段；均无则用 skill_id 兜底
        text = skill.weighted_recall_text or skill.name or (skill.content[:500] if skill.content else skill.skill_id)
        return self.llm.embed(text)


def _build_weighted_recall_text(data: Dict) -> str:
    parts = []
    name = data.get("name", "")
    if name:
        parts.extend([name] * 3)
    parts.extend(data.get("aliases", []) or [])
    rp = data.get("retrieval_profile", {}) if isinstance(data.get("retrieval_profile"), dict) else {}
    parts.extend(rp.get("aliases", []) or [])
    parts.extend(rp.get("sample_queries", []) or [])
    parts.extend(rp.get("logical_topics", []) or [])
    ents = rp.get("entities", {}) if isinstance(rp.get("entities"), dict) else {}
    parts.extend(ents.get("who", []) or [])
    parts.extend(ents.get("actions", []) or [])
    parts.extend(ents.get("objects", []) or [])
    for f in ("cinematic_role", "deliverable_type", "sub_domain"):
        v = data.get(f, "")
        if v:
            parts.append(str(v))
    parts.extend(data.get("tags", []) or [])
    return " ".join(dict.fromkeys([str(p) for p in parts if p]))


# ============================================================
# Layer 1: 组合创新层（Layer D，全自动）
# ============================================================

class InnovationComposer:
    """跨域组合 + 跨技能组合 + 变异进化。冷启动可触发，热运行不触发。"""

    def __init__(self, llm: Optional[LLMClient] = None):
        self.llm = llm or LLMClient()

    INNOVATE_PROMPT = (
        "你是影视技能创新组合器。基于以下技能要素，生成一个创新复合技能（跨域组合/跨技能组合/变异进化），"
        "输出 JSON：{\"name\":\"\",\"skill_type\":\"\",\"combination\":\"\",\"gain\":\"\",\"feasible\":true,\"innovative\":true}。只输出 JSON。"
    )

    def compose(self, seed_skills: List["SkillAsset"], matrix_entry: Optional[Dict] = None) -> Optional["SkillAsset"]:
        if len(seed_skills) < 2:
            return None
        elems = [{"role": s.cinematic_role, "deliverable": s.deliverable_type, "name": s.name} for s in seed_skills[:4]]
        if not self.llm.available:
            return None
        out = self.llm.chat(self.INNOVATE_PROMPT, json.dumps(elems, ensure_ascii=False), temperature=0.4, json_mode=True)
        try:
            cleaned = re.sub(r"^\s*```[a-zA-Z]*\s*\n?", "", out.strip())
            cleaned = re.sub(r"\n?\s*```\s*$", "", cleaned)
            data = json.loads(cleaned)
        except Exception:
            return None
        if not isinstance(data, dict) or not data.get("feasible", True) or not data.get("innovative", True):
            return None
        # 合并 seed 技能的召回信息，构建完整召回文本（避免创新技能入库后变"死技能"）
        seed_aliases = list(dict.fromkeys(sum([list(s.aliases) for s in seed_skills[:4]], [])))
        seed_topics = list(dict.fromkeys(sum([list(s.logical_topics) for s in seed_skills[:4]], [])))
        seed_queries = list(dict.fromkeys(sum([list(s.sample_queries) for s in seed_skills[:4]], [])))
        recall_data = {
            "name": data.get("name", "创新复合技能"),
            "aliases": seed_aliases,
            "retrieval_profile": {"aliases": seed_aliases, "sample_queries": seed_queries, "logical_topics": seed_topics},
            "cinematic_role": seed_skills[0].cinematic_role,
            "deliverable_type": seed_skills[0].deliverable_type,
            "sub_domain": seed_skills[0].sub_domain,
        }
        # module_target 保序去重（set 无序会导致跨运行不稳定）
        module_target = list(dict.fromkeys(sum([list(s.module_target) for s in seed_skills], [])))
        skill = SkillAsset(
            name=data.get("name", "创新复合技能"),
            skill_id=gen_id("innov"),
            last_updated=now_iso(),
            domain="ai_cinema",
            sub_domain=seed_skills[0].sub_domain,
            cinematic_role=seed_skills[0].cinematic_role,
            module_target=module_target,
            deliverable_type=seed_skills[0].deliverable_type,
            maturity="v0",
            forge_mode="cold",
            status="draft",
            innovation_meta={"is_innovative": True, "combination": data.get("combination", ""), "gain": data.get("gain", ""), "seed_skills": [s.skill_id for s in seed_skills[:4]]},
            weighted_recall_text=_build_weighted_recall_text(recall_data),
        )
        return skill


# ============================================================
# Layer 1: 成熟度与进化层（Layer E，纯自动化 v0→v3）
# ============================================================

class MaturityEvolver:
    """成熟度管理 + 实战反馈自然选择 + 召回权重。"""

    WEIGHT_BY_MATURITY = {"v3": 1.5, "v2": 1.2, "v1": 1.0, "v0": 0.6}

    @classmethod
    def weight(cls, skill: "SkillAsset") -> float:
        return cls.WEIGHT_BY_MATURITY.get(skill.maturity, 1.0)

    @classmethod
    def should_retire(cls, skill: "SkillAsset") -> bool:
        """连续差反馈的自然淘汰。"""
        hist = skill.quality_history
        return skill.call_count >= 5 and len(hist) >= 4 and all(q < 50 for q in hist[-4:])


# ============================================================
# Layer 1: SkillForgeEngine（生产侧总控）
# ============================================================

class SkillForgeEngine:
    """
    技能锻造子系统总控。整合外部知识获取 + 知识融合 + 多阶段锻造 + 三段式保障 + 组合创新 + 成熟度进化。
    双模式入口：cold_forge / hot_forge。
    """

    def __init__(self, llm: Optional[LLMClient] = None, system_message: str = "",
                 user_template: str = "", enable_innovation: bool = True):
        self.llm = llm or LLMClient()
        self.system_message = system_message
        self.user_template = user_template
        self.forger = MultiStageForger(self.llm)
        self.innovator = InnovationComposer(self.llm) if enable_innovation else None
        self.evolver = MaturityEvolver()

    def _make_payload(self, matrix_entry: Dict, task: str) -> Dict:
        agent = matrix_entry["agent"]
        sys_name = matrix_entry.get("system", "MyStudio")
        role = matrix_entry["cinematic_role"]
        sub = matrix_entry["sub_domain"]
        deliverable = _guess_deliverable(role, task)
        stage = _guess_project_stage(task)
        # 确定性 skill_id：基于 (system, agent, role, sub, task) 哈希，保证 cold_start 幂等不堆积
        skill_id = "pcf_" + _hash_key(sys_name, agent, role, sub, task)[:16]
        return {
            "output_mode": "blueprint", "output_format": "json",
            "skill_name": task, "skill_id": skill_id,
            "package_version": "1.0.0", "skill_version": "1.0.0",
            "last_updated": now_iso(), "author": "PandaCineForge", "license": "internal", "status": "draft",
            "domain": "ai_cinema", "sub_domain": sub, "type": "cinema_skill",
            "priority": "P1", "tags": [role, sub, deliverable],
            "cinematic_role": role, "module_target": [f"{sys_name}.{agent}"],
            "deliverable_type": deliverable, "project_stage": stage,
            "title": task, "summary": f"{task}（{sub}）",
            "skill_type": "deep_analysis", "automation_level": "L2", "risk_level": "medium",
            "core_goal": task, "non_goals": [], "success_metrics": [], "user_scenarios": [],
            "target_audience": [agent], "trigger_intents": [task],
            "estimated_user_time": "10min", "estimated_system_time": "30s", "difficulty": 3,
            "output_style": "table_first", "execution_layer": "5", "execution_mode": "sequential",
            "domain_pack": DOMAIN_PACKS.get(sub, {}),
        }

    def cold_forge(self, matrix: Optional[List[Dict]] = None, enable_innovation: bool = False) -> List["SkillAsset"]:
        """冷启动批量生成。按全域技能矩阵批量生成，走完整锻造流程。
        enable_innovation 默认 False（组合创新会让 generated_count 不可预测，开源默认关闭）；
        显式传 True 时触发跨域组合创新，追加创新复合技能。"""
        matrix = matrix if matrix is not None else COLD_FORGE_MATRIX
        skills: List[SkillAsset] = []
        failures = 0
        for entry in matrix:
            for task in entry.get("tasks", []):
                payload = self._make_payload(entry, task)
                try:
                    skill = self.forger.forge(payload, self.system_message, self.user_template, mode="cold")
                    skills.append(skill)
                except Exception as e:
                    failures += 1
                    logger.warning("cold_forge 失败 [task=%s]: %s", task, e, exc_info=True)
                    continue
        if failures:
            logger.warning("cold_forge 完成: 成功 %d 个, 失败 %d 个", len(skills), failures)
        # 组合创新：默认关闭，显式开启时追加
        if enable_innovation and self.innovator and len(skills) >= 4:
            for i in range(0, min(6, len(skills) - 1), 2):
                innov = self.innovator.compose(skills[i:i + 3])
                if innov:
                    skills.append(innov)
        return skills

    def hot_forge(self, request: Dict) -> "SkillAsset":
        """热运行实时生成。简化锻造保速度：外部知识浅抓 + 置信度门禁快速判定。"""
        payload = dict(request)
        payload.setdefault("output_mode", "blueprint")
        payload.setdefault("output_format", "json")
        payload.setdefault("domain", "ai_cinema")
        payload.setdefault("forge_mode", "hot")
        skill = self.forger.forge(payload, self.system_message, self.user_template, mode="hot")
        return skill


def _guess_deliverable(role: str, task: str) -> str:
    """根据 cinematic_role + task 文本猜测 deliverable_type。"""
    hints = [
        ("节拍", "beat_sheet"), ("大纲", "beat_sheet"), ("结构", "beat_sheet"),
        ("视觉", "storyboard"), ("分镜", "shotlist"), ("色彩", "color_script"), ("调色", "color_script"),
        ("运镜", "shotlist"), ("布光", "shotlist"),
        ("混音", "mix_plan"), ("声音", "sound_map"), ("音效", "sound_map"), ("配乐", "sound_map"),
        ("连贯", "continuity_report"), ("穿帮", "continuity_report"),
        ("提示词", "prompt_pack"), ("Prompt", "prompt_pack"),
        ("开场", "opening_sequence"), ("片头", "opening_sequence"),
        ("剪辑", "edit_decision_list"), ("EDL", "edit_decision_list"),
    ]
    for kw, dt in hints:
        if kw in task:
            return dt
    role_default = {
        "scene_design": "beat_sheet", "visual_language": "shotlist", "audio_design": "sound_map",
        "continuity_review": "continuity_report", "prompt_fusion": "prompt_pack",
        "opening_design": "opening_sequence", "editing": "edit_decision_list",
        "color_grading": "color_script", "vfx": "shotlist",
    }
    return role_default.get(role, "shotlist")


def _guess_project_stage(task: str) -> str:
    """根据 task 文本猜测 project_stage（替换原硬编码 preproduction）。"""
    if any(kw in task for kw in ["剪辑", "调色", "色彩", "混音", "视效", "合成", "后期", "精剪", "粗剪", "口型", "连贯", "穿帮", "渲染", "套LUT", "Foley", "对白", "旁白", "音效", "配乐", "字幕"]):
        return "postproduction"
    if any(kw in task for kw in ["发行", "交付", "DCP", "投流", "上线", "复盘", "矩阵", "带货"]):
        return "distribution"
    if any(kw in task for kw in ["拍摄", "布光", "收声", "场记", "现场"]):
        return "production"
    return "preproduction"


# ============================================================
# Layer 2-3: 索引 + 召回（分层级联 R0-R5）
# 底层算子（BM25/Embedding/Topic/Slot）组织为分层级联，命中即返
# ============================================================

class SkillIndexer:
    """技能索引器：结构化索引 + 向量索引 + 关键词索引。"""

    def __init__(self):
        self.skills: Dict[str, SkillAsset] = {}
        # 结构化索引（R0 路由用）
        self.idx_role: Dict[str, Set[str]] = defaultdict(set)
        self.idx_module: Dict[str, Set[str]] = defaultdict(set)
        self.idx_deliverable: Dict[str, Set[str]] = defaultdict(set)
        self.idx_stage: Dict[str, Set[str]] = defaultdict(set)
        self.idx_subdomain: Dict[str, Set[str]] = defaultdict(set)
        # 关键词索引（R3 用）
        self.phrase_index: Dict[str, List[Tuple[str, str]]] = defaultdict(list)
        self.topic_index: Dict[str, Set[str]] = defaultdict(set)
        self.domain_index: Dict[str, Set[str]] = defaultdict(set)
        self.urgency_index: Dict[str, Set[str]] = defaultdict(set)
        self.slot_indexes: Dict[str, Dict[str, Set[str]]] = {k: defaultdict(set) for k in ("who", "actions", "objects", "scenarios", "project_stages")}
        # BM25 索引
        self.doc_len: Dict[str, int] = {}
        self.avg_doc_len: float = 1.0
        self.df: Dict[str, int] = {}
        self.ngram_postings: Dict[str, Dict[str, int]] = defaultdict(dict)
        self.doc_count: int = 0
        # 向量索引（R1 用）
        self.embeddings: Dict[str, List[float]] = {}

    def upsert(self, skill: SkillAsset):
        # 先移除旧记录的索引痕迹（若存在），再增量插入，避免全量重建
        if skill.skill_id in self.skills:
            self._remove_one(skill.skill_id)
        self.skills[skill.skill_id] = skill
        self._index_incremental(skill)
        # 重算派生统计量（df / avg_doc_len / doc_count）
        self._recompute_stats()

    def _remove_one(self, skill_id: str):
        """从所有派生索引中移除单个 skill 的痕迹。"""
        skill = self.skills.pop(skill_id, None)
        if not skill:
            return
        for idx in (self.idx_role, self.idx_module, self.idx_deliverable, self.idx_stage, self.idx_subdomain,
                    self.topic_index, self.domain_index, self.urgency_index):
            for _k, sset in list(idx.items()):
                sset.discard(skill_id)
                if not sset:
                    del idx[_k]
        for sub in self.slot_indexes.values():
            for _k, sset in list(sub.items()):
                sset.discard(skill_id)
                if not sset:
                    del sub[_k]
        # phrase 索引
        for norm, pairs in list(self.phrase_index.items()):
            new_pairs = [(sid, src) for sid, src in pairs if sid != skill_id]
            if new_pairs:
                self.phrase_index[norm] = new_pairs
            else:
                del self.phrase_index[norm]
        # BM25：按该 skill 自身的 gram 反向清理（O(该文档 gram 数)，避免遍历全量 postings）+ df 增量递减
        self.doc_len.pop(skill_id, None)
        old_tf = self._build_ngram_tf(skill)
        for gram in old_tf:
            postings = self.ngram_postings.get(gram)
            if postings is not None:
                postings.pop(skill_id, None)
                if not postings:
                    del self.ngram_postings[gram]
            cnt = self.df.get(gram, 0)
            if cnt <= 1:
                self.df.pop(gram, None)
            else:
                self.df[gram] = cnt - 1
        self.embeddings.pop(skill_id, None)

    def _index_incremental(self, skill: SkillAsset):
        """增量索引单个 skill（不重建全部）。df 增量维护，避免 O(V) 全量重建。"""
        self._index_structured(skill)
        self._index_phrases(skill)
        self._index_slots(skill)
        self._index_topics(skill)
        tf = self._build_ngram_tf(skill)
        dl = sum(tf.values())
        self.doc_len[skill.skill_id] = dl
        for gram, freq in tf.items():
            self.ngram_postings[gram][skill.skill_id] = freq
            self.df[gram] = self.df.get(gram, 0) + 1
        if skill.embedding:
            self.embeddings[skill.skill_id] = skill.embedding

    def _recompute_stats(self):
        """重算 doc_count / avg_doc_len（df 已在增量插入/删除时维护，无需全量扫描）。"""
        self.doc_count = len(self.skills)
        total = sum(self.doc_len.values())
        self.avg_doc_len = (total / self.doc_count) if self.doc_count else 1.0

    def bulk_load(self, skills: List[SkillAsset]):
        self.skills = {s.skill_id: s for s in skills}
        self._rebuild_all()

    def _rebuild_all(self):
        # 清空派生索引
        for d in (self.idx_role, self.idx_module, self.idx_deliverable, self.idx_stage, self.idx_subdomain,
                  self.phrase_index, self.topic_index, self.domain_index, self.urgency_index):
            d.clear()
        for d in self.slot_indexes.values():
            d.clear()
        self.doc_len.clear(); self.df.clear(); self.ngram_postings.clear()
        self.embeddings.clear()
        self.doc_count = len(self.skills)
        total_len = 0
        for skill in self.skills.values():
            self._index_structured(skill)
            self._index_phrases(skill)
            self._index_slots(skill)
            self._index_topics(skill)
            tf = self._build_ngram_tf(skill)
            dl = sum(tf.values())
            self.doc_len[skill.skill_id] = dl
            total_len += dl
            for gram, freq in tf.items():
                self.ngram_postings[gram][skill.skill_id] = freq
            if skill.embedding:
                self.embeddings[skill.skill_id] = skill.embedding
        self.avg_doc_len = (total_len / self.doc_count) if self.doc_count else 1.0
        self.df = {gram: len(postings) for gram, postings in self.ngram_postings.items()}

    def _index_structured(self, skill: SkillAsset):
        if skill.cinematic_role:
            self.idx_role[skill.cinematic_role].add(skill.skill_id)
        for mt in skill.module_target:
            self.idx_module[mt].add(skill.skill_id)
        if skill.deliverable_type:
            self.idx_deliverable[skill.deliverable_type].add(skill.skill_id)
        if skill.project_stage:
            self.idx_stage[skill.project_stage].add(skill.skill_id)
        if skill.sub_domain:
            self.idx_subdomain[skill.sub_domain].add(skill.skill_id)

    def _index_phrases(self, skill: SkillAsset):
        phrases = [(skill.name, "name")]
        phrases.extend((x, "alias") for x in skill.aliases)
        phrases.extend((x, "sample_query") for x in skill.sample_queries)
        phrases.extend((x, "trigger") for x in skill.trigger_keywords)
        phrases.extend((x, "pattern") for x in skill.problem_patterns)
        for phrase, _src in phrases:
            norm = normalize_text(phrase)
            if len(norm) < 2:
                continue
            self.phrase_index[norm].append((skill.skill_id, _src))

    def _index_slots(self, skill: SkillAsset):
        rp = skill.retrieval_profile
        for item in rp.entities.who:
            self.slot_indexes["who"][normalize_text(item)].add(skill.skill_id)
        for item in rp.entities.actions:
            self.slot_indexes["actions"][normalize_text(item)].add(skill.skill_id)
        for item in rp.entities.objects:
            self.slot_indexes["objects"][normalize_text(item)].add(skill.skill_id)
        for item in rp.scenarios:
            self.slot_indexes["scenarios"][normalize_text(item)].add(skill.skill_id)
        for item in rp.project_stages:
            self.slot_indexes["project_stages"][normalize_text(item)].add(skill.skill_id)

    def _index_topics(self, skill: SkillAsset):
        for topic in skill.logical_topics:
            self.topic_index[topic].add(skill.skill_id)
        if skill.domain:
            self.domain_index[skill.domain].add(skill.skill_id)
        self.urgency_index[skill.retrieval_profile.urgency or "normal"].add(skill.skill_id)

    def _build_ngram_tf(self, skill: SkillAsset) -> Counter:
        counter = Counter()
        for term in (skill.weighted_recall_text or "").split():
            norm = normalize_text(term)
            if len(norm) < 2:
                continue
            counter.update(char_ngrams(norm))
        return counter


class RecallEngine:
    """分层级联回：R0 结构化路由 → R1 语义向量 → R2 上下文 → R3 关键词 → R4 安全兜底 → R5 实时生成兜底。"""

    SOURCE_WEIGHTS = {"name": 8.0, "alias": 7.0, "sample_query": 7.5, "trigger": 5.5, "pattern": 5.0}
    SLOT_WEIGHTS = {"who": 1.2, "actions": 3.0, "objects": 2.2, "scenarios": 1.4, "project_stages": 1.8}

    def __init__(self, indexer: SkillIndexer, topic_mapper: "TopicMapper",
                 forge_engine: Optional[SkillForgeEngine] = None, rrf_k: int = 60):
        self.indexer = indexer
        self.topic_mapper = topic_mapper
        self.forge_engine = forge_engine
        self.rrf_k = rrf_k

    def understand(self, text: str, route_fields: Optional[Dict] = None, context: Optional[Dict] = None) -> QueryUnderstanding:
        normalized = normalize_text(text)
        qu = QueryUnderstanding(
            raw_text=text, normalized_text=normalized,
            expanded_queries=self._expand(text, normalized),
            char_ngrams=char_ngrams(normalized),
            slots=self._extract_slots(normalized),
            scenarios=self._extract_scenarios(normalized),
            project_stages=extract_project_stages(normalized),
            urgency=self._detect_urgency(normalized),
            route_fields=route_fields or {},
            context=context or {},
        )
        qu.topics = self.topic_mapper.detect_topics(qu)
        return qu

    def _expand(self, text: str, normalized: str) -> List[str]:
        expanded = [normalized]
        slots = self._extract_slots(normalized)
        for item in slots.who + slots.actions + slots.objects:
            if item:
                expanded.append(normalize_text(item))
        return list(dict.fromkeys([x for x in expanded if x]))[:32]

    def _extract_slots(self, normalized: str) -> RetrievalEntities:
        who, actions, objects = [], [], []
        for item in CINEMA_ENTITIES.get("who", []):
            if normalize_text(item) in normalized:
                who.append(item)
        for item in CINEMA_ENTITIES.get("actions", []):
            if normalize_text(item) in normalized:
                actions.append(item)
        for item in CINEMA_ENTITIES.get("objects", []):
            if normalize_text(item) in normalized:
                objects.append(item)
        return RetrievalEntities(who=list(dict.fromkeys(who)), actions=list(dict.fromkeys(actions)), objects=list(dict.fromkeys(objects)))

    def _extract_scenarios(self, normalized: str) -> List[str]:
        out = []
        for sc in CINEMA_SCENARIOS:
            if normalize_text(sc) in normalized:
                out.append(sc)
        return list(dict.fromkeys(out))

    def _detect_urgency(self, normalized: str) -> str:
        norm_kws = [normalize_text(k) for k in _HIGH_URGENCY_KW]
        if any(k in normalized for k in norm_kws):
            return "high"
        norm_med = [normalize_text(k) for k in _MEDIUM_URGENCY_KW]
        if any(k in normalized for k in norm_med):
            return "medium"
        return "normal"

    # ---------- R0 结构化精确路由 ----------
    def r0_structured_route(self, qu: QueryUnderstanding) -> Tuple[Dict[str, float], Dict[str, List[str]], str]:
        rf = qu.route_fields or {}
        if not rf:
            return {}, {}, ""
        # 仅启用索引中实际存在的结构化字段做过滤；任一提供的字段都必须匹配（交集），
        # 未提供的字段（值为 None/空）不参与过滤。字段值在索引中无对应技能时，该字段过滤结果为空 → 整体为空。
        candidates: Optional[Set[str]] = None
        # 单值字段：值非空时取索引集合，值为 None/空时返回 None（不过滤）
        def _single(field_name: str, idx: Dict[str, Set[str]]) -> Optional[Set[str]]:
            v = rf.get(field_name)
            if not v:
                return None
            return set(idx.get(v, set()))
        field_specs: List[Tuple[str, Optional[Set[str]]]] = [
            ("module_target", self._collect_module_ids(rf.get("module_target"))),
            ("cinematic_role", _single("cinematic_role", self.indexer.idx_role)),
            ("deliverable_type", _single("deliverable_type", self.indexer.idx_deliverable)),
            ("project_stage", _single("project_stage", self.indexer.idx_stage)),
            ("sub_domain", _single("sub_domain", self.indexer.idx_subdomain)),
        ]
        for _field, ids in field_specs:
            if ids is None:
                continue  # 该字段未提供，跳过
            candidates = set(ids) if candidates is None else (candidates & set(ids))
            if not candidates:
                return {}, {}, ""  # 任一提供的字段无匹配，整体不命中
        if not candidates:
            return {}, {}, ""
        scores = {sid: 1.0 for sid in candidates}
        evidences = {sid: ["r0:route_match"] for sid in candidates}
        return scores, evidences, "R0"

    def _collect_module_ids(self, module_target: Any) -> Optional[Set[str]]:
        """module_target 为列表，需并集多值；未提供时返回 None 表示不过滤。"""
        if not module_target:
            return None
        # 容错：字符串入参按整体匹配（避免 for 遍历字符导致返回空集）
        if isinstance(module_target, str):
            module_target = [module_target]
        ids: Set[str] = set()
        for mt in module_target:
            ids |= self.indexer.idx_module.get(mt, set())
        return ids

    # ---------- R1 语义向量召回（核心）----------
    def r1_semantic_recall(self, qu: QueryUnderstanding, top_n: int = 40) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores, evidences = {}, defaultdict(list)
        if not self.indexer.embeddings:
            return {}, {}
        query_vec = self._embed(qu.raw_text)
        if not query_vec:
            # 无 embedding 时退化到 phrase 精确匹配
            return self._phrase_recall(qu, top_n)
        for sid, vec in self.indexer.embeddings.items():
            sim = _cosine(query_vec, vec)
            if sim > 0.3:
                scores[sid] = sim
                evidences[sid].append(f"r1:semantic:{sim:.3f}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    def _embed(self, text: str) -> List[float]:
        # 优先用索引中 LLM 客户端；若无则返回空
        if self.forge_engine and self.forge_engine.llm.available:
            return self.forge_engine.llm.embed(text)
        return []

    def _phrase_recall(self, qu: QueryUnderstanding, top_n: int) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores = defaultdict(float)
        evidences = defaultdict(list)
        for form in dict.fromkeys([qu.normalized_text] + qu.expanded_queries):
            for sid, source in self.indexer.phrase_index.get(form, []):
                scores[sid] += self.SOURCE_WEIGHTS.get(source, 5.0) + 4.0
                evidences[sid].append(f"r1_phrase:{source}:{form}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    # ---------- R2 上下文召回（AI 专属）----------
    def r2_context_recall(self, qu: QueryUnderstanding, top_n: int = 30) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores = defaultdict(float)
        evidences = defaultdict(list)
        ctx = qu.context or {}
        # 基于项目类型/阶段/Agent 预测性召回
        project_stage = ctx.get("project_stage") or qu.route_fields.get("project_stage")
        if project_stage:
            for sid in self.indexer.idx_stage.get(project_stage, set()):
                scores[sid] += 2.0
                evidences[sid].append(f"r2:stage:{project_stage}")
        # 上下游技能：上游交付物 → 邻居扩散（精确匹配 deliverable_type，避免子串误召）
        upstream = ctx.get("upstream_deliverable")
        if upstream:
            up_dt = upstream.split("_v")[0]
            for sid, skill in self.indexer.skills.items():
                if skill.deliverable_type == up_dt:
                    for n in skill.neighbors[:4]:
                        scores[n] += 1.5
                        evidences[n].append(f"r2:upstream_neighbor:{sid}")
        # 链路预判：SceneDesign 完成 → 预判 VisualLanguage 需要分镜
        caller = ctx.get("caller_agent") or qu.route_fields.get("caller_agent")
        if caller:
            predict = {"SceneDesign": "visual_language", "VisualLanguage": "audio_design", "AudioDesign": "editing"}
            next_role = predict.get(caller)
            if next_role:
                for sid in self.indexer.idx_role.get(next_role, set()):
                    scores[sid] += 1.0
                    evidences[sid].append(f"r2:predict:{next_role}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    # ---------- R3 关键词/Topic 补充召回（BM25 + Topic + Slot）----------
    def r3_keyword_recall(self, qu: QueryUnderstanding, top_n: int = 60) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        bm25_s, bm25_e = self._recall_bm25(qu, top_n)
        topic_s, topic_e = self._recall_topics(qu, top_n)
        slot_s, slot_e = self._recall_slots(qu, top_n)
        scores: Dict[str, float] = defaultdict(float)
        evidences: Dict[str, List[str]] = defaultdict(list)
        for sid, s in bm25_s.items():
            scores[sid] += s
            evidences[sid].extend(bm25_e.get(sid, []))
        for sid, s in topic_s.items():
            scores[sid] += s
            evidences[sid].extend(topic_e.get(sid, []))
        for sid, s in slot_s.items():
            scores[sid] += s
            evidences[sid].extend(slot_e.get(sid, []))
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:6] for sid in top_ids}

    def _recall_bm25(self, qu: QueryUnderstanding, top_n: int) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores = defaultdict(float)
        evidences = defaultdict(list)
        query_tf = Counter(qu.char_ngrams)
        if not query_tf:
            return {}, {}
        k1, b = 1.2, 0.75
        for gram, _ in query_tf.items():
            postings = self.indexer.ngram_postings.get(gram)
            if not postings:
                continue
            df = self.indexer.df.get(gram, 0)
            if df <= 0 or df / max(1, self.indexer.doc_count) > 0.65:
                continue
            idf = log(1.0 + (self.indexer.doc_count - df + 0.5) / (df + 0.5))
            for sid, tf in postings.items():
                dl = self.indexer.doc_len.get(sid, 1)
                denom = tf + k1 * (1 - b + b * dl / max(self.indexer.avg_doc_len, 1.0))
                scores[sid] += idf * ((tf * (k1 + 1)) / max(denom, 1e-9))
                if len(evidences[sid]) < 4:
                    evidences[sid].append(f"r3_bm25:{gram}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    def _recall_topics(self, qu: QueryUnderstanding, top_n: int) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores = defaultdict(float)
        evidences = defaultdict(list)
        for ts in qu.topics:
            for sid in self.indexer.topic_index.get(ts.topic, set()):
                scores[sid] += ts.confidence * 10.0
                evidences[sid].append(f"r3_topic:{ts.topic}:{ts.confidence:.2f}")
        expanded = self.topic_mapper.expand_domains(qu.topics)
        for domain, ds in expanded.items():
            for sid in self.indexer.domain_index.get(domain, set()):
                scores[sid] += ds * 3.5
                evidences[sid].append(f"r3_domain:{domain}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    def _recall_slots(self, qu: QueryUnderstanding, top_n: int) -> Tuple[Dict[str, float], Dict[str, List[str]]]:
        scores = defaultdict(float)
        evidences = defaultdict(list)
        for term in qu.slots.who:
            for sid in self.indexer.slot_indexes["who"].get(normalize_text(term), set()):
                scores[sid] += self.SLOT_WEIGHTS["who"]
                evidences[sid].append(f"r3_who:{term}")
        for term in qu.slots.actions:
            for sid in self.indexer.slot_indexes["actions"].get(normalize_text(term), set()):
                scores[sid] += self.SLOT_WEIGHTS["actions"]
                evidences[sid].append(f"r3_action:{term}")
        for term in qu.slots.objects:
            for sid in self.indexer.slot_indexes["objects"].get(normalize_text(term), set()):
                scores[sid] += self.SLOT_WEIGHTS["objects"]
                evidences[sid].append(f"r3_object:{term}")
        for term in qu.scenarios:
            for sid in self.indexer.slot_indexes["scenarios"].get(normalize_text(term), set()):
                scores[sid] += self.SLOT_WEIGHTS["scenarios"]
                evidences[sid].append(f"r3_scenario:{term}")
        for term in qu.project_stages:
            for sid in self.indexer.slot_indexes["project_stages"].get(normalize_text(term), set()):
                scores[sid] += self.SLOT_WEIGHTS["project_stages"]
                evidences[sid].append(f"r3_stage:{term}")
        top_ids = _top_ids(scores, top_n)
        return {sid: scores[sid] for sid in top_ids}, {sid: evidences[sid][:4] for sid in top_ids}

    # ---------- R4 安全兜底 ----------
    def r4_safety_guard(self, qu: QueryUnderstanding) -> Tuple[Dict[str, float], Dict[str, List[str]], bool]:
        has_safety = qu.urgency == "high" or any(t.topic in ("continuity_check", "platform_compliance", "copyright_clearance", "backup_strategy") for t in qu.topics)
        if not has_safety:
            return {}, {}, False
        scores, evidences = defaultdict(float), defaultdict(list)
        for topic in ("continuity_check", "platform_compliance", "copyright_clearance", "backup_strategy"):
            for sid in self.indexer.topic_index.get(topic, set()):
                scores[sid] += 5.0
                evidences[sid].append(f"r4_guard:{topic}")
        for lvl in ("high", "critical"):
            for sid in self.indexer.urgency_index.get(lvl, set()):
                scores[sid] += 4.0
                evidences[sid].append(f"r4_urgency:{lvl}")
        return dict(scores), {sid: evidences[sid][:4] for sid in scores}, True

    # ---------- 主入口：分层级联 ----------
    def recall(self, qu: QueryUnderstanding, topk: int = 10, recall_mode: str = "full") -> RecallResult:
        all_scores: Dict[str, float] = defaultdict(float)
        all_evidences: Dict[str, List[str]] = defaultdict(list)
        layer_rankings: Dict[str, List[str]] = {}
        hit_layer = ""
        layers: List[Tuple[str, Dict[str, float], Dict[str, List[str]], bool]] = []

        # R0
        s0, e0, l0 = self.r0_structured_route(qu)
        layers.append(("R0", s0, e0, True))
        if s0 and recall_mode == "fast":
            return self._assemble(qu, {"R0": s0}, {"R0": e0}, topk, "R0")

        # R1
        s1, e1 = self.r1_semantic_recall(qu)
        layers.append(("R1", s1, e1, True))

        if recall_mode == "fast":
            merged = self._merge({"R0": s0, "R1": s1})
            return self._assemble(qu, {"R0": s0, "R1": s1}, {"R0": e0, "R1": e1}, topk, "R1" if s1 else "R0")

        # R2
        s2, e2 = self.r2_context_recall(qu)
        layers.append(("R2", s2, e2, True))

        # R3
        s3, e3 = self.r3_keyword_recall(qu)
        layers.append(("R3", s3, e3, True))

        # R4
        s4, e4, urgent = self.r4_safety_guard(qu)
        layers.append(("R4", s4, e4, urgent))

        score_maps = {name: s for name, s, _, _ in layers}
        evidence_maps = {name: e for name, _, e, _ in layers}
        return self._assemble(qu, score_maps, evidence_maps, topk, self._determine_hit_layer(layers))

    def _merge(self, score_maps: Dict[str, Dict[str, float]]) -> Dict[str, float]:
        merged: Dict[str, float] = defaultdict(float)
        for s in score_maps.values():
            for sid, sc in s.items():
                merged[sid] += sc
        return merged

    def _determine_hit_layer(self, layers: List[Tuple[str, Dict[str, float], Dict[str, List[str]], bool]]) -> str:
        for name, s, _, active in layers:
            if active and s:
                return name
        return ""

    def _assemble(self, qu: QueryUnderstanding, score_maps: Dict[str, Dict[str, float]],
                  evidence_maps: Dict[str, Dict[str, List[str]]], topk: int, hit_layer: str) -> RecallResult:
        # RRF 融合
        rrf_scores: Dict[str, float] = defaultdict(float)
        layer_rankings: Dict[str, List[str]] = {}
        for name, scores in score_maps.items():
            ranked = _top_ids(scores, max(50, topk * 5))
            layer_rankings[name] = ranked
            rank_map = {sid: r for r, sid in enumerate(ranked, 1)}
            for sid in ranked:
                rrf_scores[sid] += 1.0 / (self.rrf_k + rank_map[sid])

        candidates: List[RecallCandidate] = []
        for sid, fused in nlargest(topk, rrf_scores.items(), key=lambda x: x[1]):
            rank_by_layer, layer_scores, evs = {}, {}, {}
            for name, scores in score_maps.items():
                ranked = layer_rankings.get(name, [])
                if sid in ranked:
                    rank_by_layer[name] = ranked.index(sid) + 1
                    layer_scores[name] = round(scores.get(sid, 0.0), 6)
                    evs[name] = evidence_maps.get(name, {}).get(sid, [])[:6]
            candidates.append(RecallCandidate(skill_id=sid, rrf_score=round(fused, 8), rank_by_layer=rank_by_layer, layer_scores=layer_scores, evidences=evs))
        return RecallResult(understanding=qu, candidates=candidates, layer_rankings=layer_rankings, hit_layer=hit_layer)

    # ---------- R5 实时生成兜底 ----------
    def r5_hot_forge_fallback(self, qu: QueryUnderstanding) -> Optional[SkillAsset]:
        if not self.forge_engine:
            return None
        try:
            request = {
                "cinematic_role": qu.route_fields.get("cinematic_role", ""),
                "module_target": qu.route_fields.get("module_target", []),
                "deliverable_type": qu.route_fields.get("deliverable_type", ""),
                "project_stage": qu.route_fields.get("project_stage", ""),
                "sub_domain": qu.route_fields.get("sub_domain", "cinema"),
                "skill_name": qu.raw_text[:40] or "实时生成技能",
                "query_text": qu.raw_text,
            }
            return self.forge_engine.hot_forge(request)
        except Exception:
            return None


def _cosine(a: List[float], b: List[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = sum(x * y for x, y in zip(a, b))
    na = sum(x * x for x in a) ** 0.5
    nb = sum(y * y for y in b) ** 0.5
    if na == 0 or nb == 0:
        return 0.0
    return dot / (na * nb)


def extract_project_stages(text: str) -> List[str]:
    """按制作阶段识别（替换原 extract_age_stages）。"""
    stages = []
    if any(kw in text for kw in ["筹备", "剧本", "前期", "选角", "堪景"]):
        stages.append("preproduction")
    if any(kw in text for kw in ["拍摄", "布光", "收声", "场记", "现场"]):
        stages.append("production")
    if any(kw in text for kw in ["剪辑", "调色", "混音", "视效", "合成", "后期"]):
        stages.append("postproduction")
    if any(kw in text for kw in ["发行", "交付", "DCP", "投流", "上线"]):
        stages.append("distribution")
    return stages


# ============================================================
# 影视 Topic 映射器（数据影视化）
# ============================================================

class TopicMapper:
    """基于规则检测查询的 logical topic，影视化 50+ topics。"""

    def __init__(self, rules: Optional[Dict[str, Dict]] = None):
        raw = rules if rules is not None else CINEMA_TOPICS
        self.rules: Dict[str, Dict] = {}
        for topic, cfg in raw.items():
            self.rules[topic] = {
                "keywords": [normalize_text(x) for x in cfg.get("keywords", [])],
                "aliases": [normalize_text(x) for x in cfg.get("aliases", [])],
                "physical_domains": list(cfg.get("physical_domains", []) or []),
                "negative_keywords": [normalize_text(x) for x in cfg.get("negative_keywords", [])],
                "weight": float(cfg.get("weight", 1.0)),
                "cinematic_role": cfg.get("cinematic_role", ""),
            }

    def detect_topics(self, query: Union[str, QueryUnderstanding], top_n: int = 5) -> List[TopicScore]:
        if isinstance(query, QueryUnderstanding):
            normalized = query.normalized_text
            slots = query.slots
            scenarios = query.scenarios
            stages = query.project_stages
        else:
            normalized = normalize_text(query)
            slots = None
            scenarios = []
            stages = []
        scored: List[TopicScore] = []
        for topic, cfg in self.rules.items():
            score = 0.0
            evidence: List[str] = []
            for kw in cfg["keywords"]:
                if kw and kw in normalized:
                    score += 1.8
                    evidence.append(f"kw:{kw}")
            for alias in cfg["aliases"]:
                if not alias:
                    continue
                if alias == normalized:
                    score += 2.8
                    evidence.append(f"alias_exact:{alias}")
                elif alias in normalized or normalized in alias:
                    score += 2.2
                    evidence.append(f"alias_partial:{alias}")
            if slots is not None:
                for a in slots.actions:
                    if normalize_text(a) in cfg["keywords"] or normalize_text(a) in cfg["aliases"]:
                        score += 1.2
                        evidence.append(f"action:{a}")
                for o in slots.objects:
                    if normalize_text(o) in cfg["keywords"] or normalize_text(o) in cfg["aliases"]:
                        score += 1.0
                        evidence.append(f"object:{o}")
            if scenarios:
                for sc in scenarios:
                    if normalize_text(sc) in cfg["keywords"]:
                        score += 1.0
                        evidence.append(f"scenario:{sc}")
            if stages:
                score += 0.4 * len(stages)
                evidence.append(f"stage:{','.join(stages)}")
            for neg in cfg["negative_keywords"]:
                if neg and neg in normalized:
                    score -= 1.2
            score *= cfg["weight"]
            if score >= 1.5:
                scored.append(TopicScore(topic=topic, confidence=round(min(0.99, score / 8.0), 4), evidence=evidence[:8]))
        scored.sort(key=lambda x: x.confidence, reverse=True)
        return scored[:top_n]

    def expand_domains(self, topics: List[TopicScore]) -> Dict[str, float]:
        ds: Dict[str, float] = defaultdict(float)
        for ts in topics:
            cfg = self.rules.get(ts.topic)
            if not cfg:
                continue
            for d in cfg["physical_domains"]:
                ds[d] += ts.confidence * cfg["weight"]
        return dict(sorted(ds.items(), key=lambda x: x[1], reverse=True))


# ============================================================
# Layer 4: 排序（精排 + cinematic_role 匹配奖励 + maturity 加权）
# ============================================================

class RankingOptimizer:
    """精排：RRF 基础分 + Topic 匹配奖励 + cinematic_role 匹配 + maturity 加权。"""

    def __init__(self, indexer: SkillIndexer, topic_mapper: TopicMapper):
        self.indexer = indexer
        self.topic_mapper = topic_mapper

    def rank(self, result: RecallResult, topk: int = 5) -> List[RankedSkill]:
        qu = result.understanding
        query_role = qu.route_fields.get("cinematic_role", "")
        query_topics = {t.topic for t in qu.topics}
        ranked: List[RankedSkill] = []
        for cand in result.candidates:
            skill = self.indexer.skills.get(cand.skill_id)
            if not skill:
                continue
            if skill.status == "deprecated":
                continue
            base = cand.rrf_score
            # cinematic_role 匹配奖励
            role_bonus = 0.15 if query_role and skill.cinematic_role == query_role else 0.0
            # Topic 匹配奖励
            topic_bonus = 0.1 * len(set(skill.logical_topics) & query_topics)
            # maturity 加权
            maturity_w = MaturityEvolver.weight(skill)
            # priority 加权
            prio_w = {"P0": 1.3, "P1": 1.15, "P2": 1.0, "P3": 0.85}.get(skill.priority, 1.0)
            final = (base + role_bonus + topic_bonus) * maturity_w * prio_w
            ranked.append(RankedSkill(
                skill_id=skill.skill_id, name=skill.name, domain=skill.domain, score=round(final, 6),
                details={
                    "rrf_score": cand.rrf_score, "role_bonus": role_bonus, "topic_bonus": topic_bonus,
                    "maturity": skill.maturity, "maturity_weight": maturity_w, "priority": skill.priority,
                    "hit_layer": result.hit_layer, "rank_by_layer": cand.rank_by_layer,
                    "evidences": cand.evidences, "deliverable_type": skill.deliverable_type,
                    "cinematic_role": skill.cinematic_role, "module_target": skill.module_target,
                },
            ))
        ranked.sort(key=lambda x: x.score, reverse=True)
        return ranked[:topk]


# ============================================================
# Layer 5: 编排（按 module_target 分组分发至制作系统 Agent）
# ============================================================

class Orchestrator:
    """编排器：TopK 技能按 module_target 分组 → 并行/串行分发 → 结果汇总。"""

    def __init__(self, indexer: SkillIndexer):
        self.indexer = indexer

    def build_workflow(self, ranked: List[RankedSkill]) -> Dict:
        """按 module_target 分组构建执行步骤。同一 agent 的多个技能按 ranked 顺序保留（不再静默丢弃）。"""
        steps = []
        order = 1
        for rs in ranked:
            skill = self.indexer.skills.get(rs.skill_id)
            if not skill:
                continue
            for mt in skill.module_target:
                steps.append({
                    "skill_id": skill.skill_id,
                    "skill_name": skill.name,
                    "agent": mt,
                    "cinematic_role": skill.cinematic_role,
                    "deliverable_type": skill.deliverable_type,
                    "order": order,
                    "parallel_with": None,
                })
                order += 1
        return {"steps": steps, "total": len(steps)}


def dispatch_to_agent(agent_name: str, skill: SkillAsset, context: Optional[Dict] = None) -> Dict:
    """
    按 module_target 分发至对应制作系统 Agent。
    实际生产中此处对接调用方制作系统的 Agent 接口。
    """
    sys_name = agent_name.split(".")[0] if "." in agent_name else "Unknown"
    agent_short = agent_name.split(".")[-1] if "." in agent_name else agent_name
    registry = AGENT_REGISTRY.get(sys_name, {})
    role_map = registry.get("role_map", {})
    expected_role = role_map.get(agent_short, "")
    return {
        "dispatch_to": agent_name,
        "skill_id": skill.skill_id,
        "skill_name": skill.name,
        "cinematic_role": skill.cinematic_role,
        "expected_role": expected_role,
        "role_match": (expected_role == skill.cinematic_role) if expected_role else False,
        "registered": bool(expected_role),
        "deliverable_type": skill.deliverable_type,
        "context": context or {},
        "status": "dispatched",
        "dispatched_at": now_iso(),
    }


# ============================================================
# Layer 6: 质检（影视化质量门禁）
# ============================================================

class QAGate:
    """影视质量门禁：一票否决项 + 11 维评分 + 实战反馈记录。"""

    def __init__(self, feedback_evolver: Optional[FeedbackEvolver] = None):
        self.feedback_evolver = feedback_evolver

    def check(self, skill: SkillAsset, execution_outcome: Optional[Dict] = None) -> Dict:
        # 一票否决项检查
        veto_hit = self._check_veto(skill)
        if veto_hit:
            return {"final_status": "rejected", "overall_score": 0, "veto_hit": veto_hit, "issues": [veto_hit]}
        # 11 维评分（结构化规则 + 可选 LLM）
        scores = self._score_dimensions(skill)
        overall = int(sum(scores.values()) / max(1, len(scores)))
        final_status = "validated" if overall >= QA_PASS_THRESHOLD else ("rework" if overall >= 70 else "rejected")
        result = {
            "final_status": final_status, "overall_score": overall,
            "dimension_scores": scores, "veto_hit": None,
            "issues": [] if final_status == "validated" else [f"score_below_threshold:{overall}"],
        }
        # 实战反馈记录（第三段）
        if execution_outcome and self.feedback_evolver:
            self.feedback_evolver.record(
                skill,
                execution_outcome.get("execution_outcome", "success"),
                int(execution_outcome.get("quality_score", overall)),
                execution_outcome.get("failure_reasons"),
                execution_outcome.get("user_corrections"),
            )
        return result

    def _check_veto(self, skill: SkillAsset) -> Optional[str]:
        text = (skill.content or json.dumps(skill.body, ensure_ascii=False)).lower()
        # 检查是否触发影视否决场景但未声明处理
        # 注意：rec.709/rec.2020 同时出现是正常色彩知识介绍，仅当明确"混用/直接用"且无"转换/管理"声明时才否决
        veto_checks = [
            (("180度线", "越轴"), "轴线错乱未声明", ()),
            (("rec.709", "rec.2020"), "色彩空间混用未声明转换", ("混用", "直接用", "不转换", "未转换")),
            (("口型", "不同步"), "对白口型不同步未处理", ()),
        ]
        for (kw1, kw2), desc, extra in veto_checks:
            if kw1 in text and kw2 in text:
                # 需要额外危险词的规则（如色彩空间），必须命中 extra 才考虑否决
                if extra and not any(e in text for e in extra):
                    continue
                if "声明" not in text and "转换" not in text and "管理" not in text:
                    return f"veto:{desc}"
        # 检查确认门：有写操作但无确认
        ec = skill.execution_contract or {}
        if ec.get("tools_write") and not ec.get("confirmation_required_for"):
            return "veto:写操作无确认门"
        return None

    def _score_dimensions(self, skill: SkillAsset) -> Dict[str, int]:
        scores = {}
        rp = skill.retrieval_profile
        # 完整性
        scores["completeness"] = 90 if skill.body or skill.content else 60
        # 个性化
        scores["personalization"] = 85 if skill.persona_adaptation else 70
        # 上下文忠实度
        scores["context_fidelity"] = 88 if skill.runtime_contract else 65
        # 领域专业度
        kp = skill.knowledge_provenance
        scores["domain_professionalism"] = min(95, 60 + sum(kp.knowledge_points.values()) * 3)
        # 可执行性
        scores["actionability"] = 88 if skill.execution_contract.get("tools_read") or skill.execution_contract.get("tools_write") else 65
        # 工具合理性
        scores["tool_rationality"] = 85 if skill.capabilities.get("tools") else 60
        # 风险控制
        scores["risk_control"] = 90 if skill.fallback_strategy else 65
        # 清晰度
        scores["clarity"] = 85 if skill.content else 60
        # 影视专业度（新增）
        cinema_terms = sum(1 for kw in ["运镜", "调色", "分镜", "混音", "剪辑", "视效"] if kw in (skill.weighted_recall_text or ""))
        scores["cinematic_professionalism"] = min(95, 65 + cinema_terms * 6)
        # 连贯性安全（新增）
        scores["continuity_safety"] = 88 if "continuity" in skill.cinematic_role or skill.deliverable_type == "continuity_report" else 80
        # 平台合规（新增）
        scores["platform_compliance"] = 85 if skill.sub_domain in ("short_video", "ai_manga_drama") else 88
        return scores


# ============================================================
# Layer 7: 契约层（固定化输出契约，AI-AI 结构化协议）
# ============================================================

class ContractGateway:
    """调用契约解析 + 返回契约构建。"""

    REQUIRED_ROUTE_FIELDS = ["cinematic_role", "deliverable_type"]

    def parse_call(self, contract_json: Union[str, Dict]) -> QueryUnderstanding:
        data = json.loads(contract_json) if isinstance(contract_json, str) else dict(contract_json or {})
        route_fields = data.get("route_fields", {}) or {}
        # 校验必填路由字段
        missing = [f for f in self.REQUIRED_ROUTE_FIELDS if not route_fields.get(f)]
        if missing:
            raise ValueError(f"route_fields 缺失必填字段: {missing}")
        text = data.get("query_text", "") or data.get("intent", "")
        context = data.get("context", {}) or {}
        return QueryUnderstanding(
            raw_text=text, route_fields=route_fields, context=context,
        )

    def build_return(self, call_id: str, status: str, source_layer: str,
                     skills: List[SkillAsset], workflow: Optional[Dict] = None,
                     execution_ready: bool = True, fallback_note: str = "") -> Dict:
        return {
            "call_id": call_id,
            "status": status,
            "source_layer": source_layer,
            "skills": [s.to_recall_record() for s in skills],
            "workflow": workflow or {"steps": []},
            "execution_ready": execution_ready and bool(skills),
            "fallback_note": fallback_note,
            "returned_at": now_iso(),
        }


# ============================================================
# 主引擎：PandaCineForge（统一装配 Layer 0-7）
# ============================================================

class PandaCineForge:
    """
    大熊猫影视创作技能引擎主控。
    装配生产侧（SkillForgeEngine）+ 索引/召回（SkillIndexer/RecallEngine）+ 排序 + 编排 + 质检 + 契约。
    双入口：cold_start（冷启动）/ serve（热运行）。
    """

    def __init__(self, llm: Optional[LLMClient] = None, system_message: str = "",
                 user_template: str = "", enable_innovation: bool = True):
        self.llm = llm or LLMClient()
        self.system_message = system_message
        self.user_template = user_template
        # Layer 1
        self.forge_engine = SkillForgeEngine(self.llm, system_message, user_template, enable_innovation)
        self.knowledge_cache = self.forge_engine.forger.knowledge_fetcher.cache
        self.feedback_evolver = FeedbackEvolver(self.knowledge_cache)
        # Layer 2-3
        self.indexer = SkillIndexer()
        self.topic_mapper = TopicMapper()
        self.recall_engine = RecallEngine(self.indexer, self.topic_mapper, self.forge_engine)
        # Layer 4-7
        self.ranker = RankingOptimizer(self.indexer, self.topic_mapper)
        self.orchestrator = Orchestrator(self.indexer)
        self.qa_gate = QAGate(self.feedback_evolver)
        self.contract = ContractGateway()

    # ---------- 冷启动入口 ----------
    def cold_start(self, matrix: Optional[List[Dict]] = None, enable_innovation: bool = False) -> Dict:
        """冷启动批量生成技能并入库。
        enable_innovation 默认 False（组合创新让生成数不可预测，开源默认关闭）。"""
        skills = self.forge_engine.cold_forge(matrix, enable_innovation=enable_innovation)
        self.indexer.bulk_load(skills)
        return {
            "status": "cold_start_completed",
            "generated_count": len(skills),
            "skill_ids": [s.skill_id for s in skills],
            "maturity_dist": self._maturity_dist(skills),
            "completed_at": now_iso(),
        }

    # ---------- 热运行入口（Agent 调用）----------
    def serve(self, request_json: Union[str, Dict]) -> Dict:
        """热运行主入口。AI Agent 按固定契约发起请求。"""
        # 一次性解析请求，避免重复 json.loads
        if isinstance(request_json, str):
            try:
                req = json.loads(request_json)
            except json.JSONDecodeError as e:
                return {"status": "error", "call_id": "", "message": f"invalid JSON: {e}", "execution_ready": False}
        elif isinstance(request_json, dict):
            req = dict(request_json)
        else:
            return {"status": "error", "call_id": "", "message": f"请求必须是 dict 或 JSON 字符串，收到 {type(request_json).__name__}", "execution_ready": False}
        call_id = req.get("call_id", gen_id("call"))
        try:
            qu = self.contract.parse_call(req)
        except ValueError as e:
            return {"status": "error", "call_id": call_id, "message": str(e), "execution_ready": False}
        # topk 边界校验：[1, 20]，避免 0/负数误触发 R5
        topk = max(1, min(_safe_int(req.get("topk", 3), 3), 20))
        recall_mode = str(req.get("recall_mode", "full"))

        # 完整查询理解（复用 recall_engine.understand，确保 expanded_queries/char_ngrams/slots/topics 全部就位）
        qu = self.recall_engine.understand(
            qu.raw_text, route_fields=qu.route_fields, context=qu.context
        )

        # 分层级联回
        result = self.recall_engine.recall(qu, topk=max(topk * 2, 6), recall_mode=recall_mode)

        # 精排
        ranked = self.ranker.rank(result, topk=topk)

        # 召回不足 → R5 实时生成兜底（补充而非丢弃已召回结果）
        if len(ranked) < topk:
            forged = self.recall_engine.r5_hot_forge_fallback(qu)
            if forged:
                self.indexer.upsert(forged)  # 生成即沉淀（飞轮反哺）
                # 若已召回为空，纯 R5 返回；否则把生成的并入结果
                if not ranked:
                    ranked = [RankedSkill(forged.skill_id, forged.name, forged.domain, 1.0, {"hit_layer": "R5", "evidences": ["r5_hot_forge_fallback"]})]
                    source_layer = "R5"
                    fallback_note = "R5_hot_forge_fallback"
                else:
                    ranked.append(RankedSkill(forged.skill_id, forged.name, forged.domain, 0.5, {"hit_layer": "R5", "evidences": ["r5_supplemented"]}))
                    source_layer = result.hit_layer or "R5"
                    fallback_note = "R5_supplemented"
            elif not ranked:
                # 召回为空且实时生成不可用 → 降级方案
                return self.contract.build_return(
                    call_id, status="fallback_degraded", source_layer=result.hit_layer or "none",
                    skills=[], workflow={"steps": []}, execution_ready=False,
                    fallback_note="召回为空且实时生成不可用，返回降级方案"
                )
            else:
                source_layer = result.hit_layer or "R3"
                fallback_note = ""
        else:
            source_layer = result.hit_layer or "R3"
            fallback_note = ""

        # 编排
        workflow = self.orchestrator.build_workflow(ranked)
        # 取回 SkillAsset
        skills = [self.indexer.skills[rs.skill_id] for rs in ranked if rs.skill_id in self.indexer.skills]
        # status 语义：仅纯 R5（召回为空、完全靠实时生成）才标 forged；
        # R5_supplemented（已有召回命中 + R5 补充）记 hit，通过 fallback_note 标记是否补充。
        # 这样"飞轮反哺后第二次命中"能正确返回 hit，而纯兜底生成才 forged。
        status = "forged" if fallback_note == "R5_hot_forge_fallback" else "hit"
        return self.contract.build_return(
            call_id, status=status, source_layer=source_layer,
            skills=skills, workflow=workflow, execution_ready=bool(skills),
            fallback_note=fallback_note,
        )

    # ---------- 实战反馈回传 ----------
    def report_feedback(self, skill_id: str, execution_outcome: str, quality_score: int,
                        failure_reasons: Optional[List[str]] = None, user_corrections: Optional[List[str]] = None) -> Dict:
        skill = self.indexer.skills.get(skill_id)
        if not skill:
            return {"status": "error", "skill_id": skill_id, "message": f"skill not found: {skill_id}"}
        result = self.qa_gate.check(skill, {
            "execution_outcome": execution_outcome, "quality_score": quality_score,
            "failure_reasons": failure_reasons, "user_corrections": user_corrections,
        })
        # 更新索引（成熟度可能变化）
        self.indexer.upsert(skill)
        return {"status": "feedback_recorded", "skill_id": skill_id, "qa_result": result, "maturity": skill.maturity}

    # ---------- 质检 ----------
    def qa_check(self, skill_id: str) -> Dict:
        skill = self.indexer.skills.get(skill_id)
        if not skill:
            return {"status": "error", "skill_id": skill_id, "message": f"skill not found: {skill_id}"}
        return self.qa_gate.check(skill)

    @staticmethod
    def _maturity_dist(skills: List[SkillAsset]) -> Dict[str, int]:
        dist: Dict[str, int] = defaultdict(int)
        for s in skills:
            dist[s.maturity] += 1
        return dict(dist)

    # ---------- 单技能生成（手动）----------
    def forge_one(self, payload: Dict) -> SkillAsset:
        """手动生成单个技能（调试/补全用）。"""
        skill = self.forge_engine.forger.forge(payload, self.system_message, self.user_template, mode="cold")
        self.indexer.upsert(skill)
        return skill


# ============================================================
# 模块级单例与便捷入口
# ============================================================

_ENGINE: Optional[PandaCineForge] = None
_ENGINE_LOCK = threading.Lock()
_ENGINE_CONFIG: Tuple[str, str] = ("", "")


def get_engine(system_message: str = "", user_template: str = "") -> PandaCineForge:
    """获取模块级单例引擎（线程安全）。二次调用传入不同配置会记录警告但不重建（避免静默漂移）。"""
    global _ENGINE, _ENGINE_CONFIG
    with _ENGINE_LOCK:
        if _ENGINE is None:
            _ENGINE = PandaCineForge(system_message=system_message, user_template=user_template)
            _ENGINE_CONFIG = (system_message, user_template)
        elif (system_message or user_template) and (system_message, user_template) != _ENGINE_CONFIG:
            logger.warning("get_engine 配置漂移：单例已存在（旧配置），本次传入的新配置被忽略。如需新引擎请直接 new PandaCineForge()。")
        return _ENGINE


def cold_start(matrix: Optional[List[Dict]] = None, system_message: str = "", user_template: str = "") -> Dict:
    return get_engine(system_message, user_template).cold_start(matrix)


def serve(request_json: Union[str, Dict], system_message: str = "", user_template: str = "") -> Dict:
    return get_engine(system_message, user_template).serve(request_json)


def report_feedback(skill_id: str, execution_outcome: str, quality_score: int,
                    failure_reasons: Optional[List[str]] = None,
                    user_corrections: Optional[List[str]] = None) -> Dict:
    return get_engine().report_feedback(skill_id, execution_outcome, quality_score, failure_reasons, user_corrections)


# ============================================================
# 自测入口
# ============================================================

if __name__ == "__main__":
    engine = PandaCineForge()
    print(f"[PandaCineForge] 引擎初始化完成 | LLM可用={engine.llm.available} | 矩阵技能数={len(COLD_FORGE_MATRIX)}")
    print(f"[PandaCineForge] 影视Topic数={len(CINEMA_TOPICS)} | 种子源数={len(CINEMA_SEED_SOURCES)} | 搜索源={engine.forge_engine.forger.knowledge_fetcher.search_gateway.active}")
    # 无 LLM 时验证索引/召回链路可用性
    fake = SkillAsset(
        skill_id="test_001", name="电影调色色彩脚本技能",
        domain="ai_cinema", sub_domain="cinema", cinematic_role="visual_language",
        module_target=["MyStudio.VisualLanguage"], deliverable_type="color_script",
        project_stage="postproduction", maturity="v2", priority="P1",
        tags=["调色", "色彩脚本"], weighted_recall_text="调色 色彩脚本 color_script Rec.709 ACES 达芬奇 LUT",
        retrieval_profile=RetrievalProfile(
            logical_topics=["color_grading"], aliases=["色彩脚本", "调色方案"],
            sample_queries=["电影调色怎么做", "色彩脚本设计"],
            entities=RetrievalEntities(who=["调色师"], actions=["调色"], objects=["LUT", "色彩脚本"]),
            scenarios=["调色"], project_stages=["postproduction"], urgency="normal", summary="电影调色",
        ),
    )
    engine.indexer.upsert(fake)
    result = engine.serve({
        "call_id": "test_call", "caller_agent": "VisualLanguage",
        "route_fields": {"cinematic_role": "visual_language", "deliverable_type": "color_script", "module_target": ["MyStudio.VisualLanguage"], "project_stage": "postproduction", "sub_domain": "cinema"},
        "context": {"project_id": "p1", "caller_agent": "VisualLanguage"},
        "query_text": "电影调色", "recall_mode": "fast", "topk": 3,
    })
    print(f"[PandaCineForge] 自测召回 status={result.get('status')} layer={result.get('source_layer')} skills={len(result.get('skills', []))}")