#!/usr/bin/env python3
"""
Post-run Audit — 运行后审计
用法: python3 scripts/postrun_audit.py <run_result.json>
"""
import json, sys

def audit_skills(run_result):
    warnings = []
    stages = run_result.get('stages', {})
    prematch = stages.get('skillPrematch') or []
    if prematch:
        no_match = [s for s in prematch if not s.get('skills')]
        post_merge = [s for s in prematch if s.get('injection') == 'post-merge']
        if no_match:
            warnings.append(f"技能零命中镜头: {[s['shotId'] for s in no_match]}（检查情绪是否已在 taxonomy.json 注册）")
        if len(post_merge) > len(prematch) / 2:
            warnings.append("过半镜头走备援注入通道，主通道可能未生效")
    else:
        warnings.append("无 skillPrematch 计量——L3 主通道未接入或被跳过")
    return warnings

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print("Usage: python3 scripts/postrun_audit.py <run_result.json>")
        sys.exit(1)
    with open(sys.argv[1]) as f:
        run_result = json.load(f)
    warnings = audit_skills(run_result)
    for w in warnings:
        print(f"⚠️  {w}")
    if warnings:
        sys.exit(2)
    else:
        print("✅ 技能审计通过")
        sys.exit(0)
