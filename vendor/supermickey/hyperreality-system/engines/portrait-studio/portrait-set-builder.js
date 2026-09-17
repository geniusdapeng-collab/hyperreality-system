'use strict';

/**
 * PortraitSetBuilder — 定妆照集交付物构建器
 * ------------------------------------------------------------
 * 将角色与商品定妆照任务汇总为标准交付项"定妆照集"：
 *   - manifest.json   结构化清单（机器可读，供下游渲染/审核消费）
 *   - 定妆照集.md      交付文档（人读，按角色/商品分组呈现）
 *
 * 定妆照集是 SuperMickey 的固定交付项，与创意主题/需求洞察/PRD/
 * 镜头提示词同级，保证用户在渲染前即可直观预览角色与商品最终形象。
 */

const fs = require('fs');
const path = require('path');

class PortraitSetBuilder {
  /**
   * @param {Object} options
   * @param {string} options.outputDir 定妆照集输出根目录
   */
  constructor(options = {}) {
    this.outputDir = options.outputDir || path.join(process.cwd(), 'deliverables', 'portraits');
  }

  /**
   * 构建定妆照集
   * @param {Object} params
   * @param {Array}  params.characterTasks 角色定妆照任务数组
   * @param {Array}  params.productTasks   商品定妆照任务数组
   * @param {Object} params.visualStyle    视觉系统锚点
   * @param {Object} params.projectMeta    项目元信息 { title, runId, generatedAt }
   * @returns {Object} { manifestPath, docPath, manifest, stats }
   */
  build(params = {}) {
    const characterTasks = params.characterTasks || [];
    const productTasks = params.productTasks || [];
    const visualStyle = params.visualStyle || {};
    const projectMeta = params.projectMeta || {};

    fs.mkdirSync(this.outputDir, { recursive: true });

    const manifest = this._buildManifest(characterTasks, productTasks, visualStyle, projectMeta);
    const manifestPath = path.join(this.outputDir, 'manifest.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

    const docPath = path.join(this.outputDir, '定妆照集.md');
    fs.writeFileSync(docPath, this._buildDoc(manifest), 'utf8');

    return {
      manifestPath,
      docPath,
      manifest,
      stats: manifest.stats
    };
  }

  // ========== 内部方法 ==========

  _buildManifest(characterTasks, productTasks, visualStyle, projectMeta) {
    const charPortraits = characterTasks.flatMap(t => t.portraits);
    const prodPortraits = productTasks.flatMap(t => t.stages.stylization.portraits);

    return {
      setType: 'portrait-set',
      title: projectMeta.title || '未命名项目',
      runId: projectMeta.runId || null,
      generatedAt: projectMeta.generatedAt || new Date().toISOString(),
      visualStyleAnchor: {
        renderStyle: visualStyle.renderStyle || null,
        tone: visualStyle.tone || null,
        lighting: visualStyle.lighting || null,
        atmosphere: visualStyle.atmosphere || null
      },
      characters: characterTasks.map(t => ({
        characterId: t.characterId,
        characterName: t.characterName,
        tier: t.tier,
        angleCount: t.angleCount,
        portraits: t.portraits.map(p => ({
          portraitId: p.portraitId,
          angle: p.angle,
          angleName: p.angleName,
          purpose: p.purpose,
          priority: p.priority,
          prompt: p.prompt,
          status: p.status,
          outputFile: p.outputFile
        }))
      })),
      products: productTasks.map(t => ({
        productId: t.productId,
        productName: t.productName,
        heroImageId: t.heroImageId,
        referenceSearch: {
          queries: t.stages.referenceSearch.queries,
          minImages: t.stages.referenceSearch.minImages,
          requirements: t.stages.referenceSearch.requirements,
          referenceImages: t.stages.referenceSearch.referenceImages,
          status: t.stages.referenceSearch.status
        },
        processing: {
          pipeline: t.stages.processing.pipeline,
          outputBaseImage: t.stages.processing.outputBaseImage,
          status: t.stages.processing.status
        },
        portraits: t.stages.stylization.portraits.map(p => ({
          portraitId: p.portraitId,
          view: p.view,
          viewName: p.viewName,
          purpose: p.purpose,
          priority: p.priority,
          prompt: p.prompt,
          status: p.status,
          outputFile: p.outputFile
        }))
      })),
      stats: {
        characterCount: characterTasks.length,
        productCount: productTasks.length,
        totalPortraits: charPortraits.length + prodPortraits.length,
        completedPortraits: [...charPortraits, ...prodPortraits].filter(p => p.status === 'completed').length,
        pendingPortraits: [...charPortraits, ...prodPortraits].filter(p => p.status === 'pending').length
      }
    };
  }

  _buildDoc(manifest) {
    const lines = [];
    lines.push(`# 定妆照集 — ${manifest.title}`);
    lines.push('');
    lines.push(`生成时间：${manifest.generatedAt}`);
    lines.push(`角色 ${manifest.stats.characterCount} 个 / 商品 ${manifest.stats.productCount} 个 / 定妆照共 ${manifest.stats.totalPortraits} 张（已完成 ${manifest.stats.completedPortraits}，待执行 ${manifest.stats.pendingPortraits}）`);
    lines.push('');

    // 视觉系统锚点
    const vs = manifest.visualStyleAnchor;
    if (vs.renderStyle || vs.tone || vs.lighting || vs.atmosphere) {
      lines.push('## 视觉系统锚点');
      lines.push('');
      if (vs.renderStyle) lines.push(`- 渲染风格：${vs.renderStyle}`);
      if (vs.tone) lines.push(`- 色调：${vs.tone}`);
      if (vs.lighting) lines.push(`- 光影：${vs.lighting}`);
      if (vs.atmosphere) lines.push(`- 氛围：${vs.atmosphere}`);
      lines.push('');
      lines.push('> 全部定妆照必须与上述视觉系统保持一致，禁止风格漂移。');
      lines.push('');
    }

    // 角色定妆照
    if (manifest.characters.length > 0) {
      lines.push('## 角色定妆照');
      lines.push('');
      const tierName = { lead: '主角', supporting: '配角', cameo: '客串' };
      for (const c of manifest.characters) {
        lines.push(`### ${c.characterName}（${tierName[c.tier] || c.tier} · ${c.angleCount} 角度）`);
        lines.push('');
        for (const p of c.portraits) {
          lines.push(`${p.priority}. **${p.angleName}** — ${p.purpose}（状态：${this._statusText(p.status)}）`);
          if (p.outputFile) lines.push(`   - 文件：\`${p.outputFile}\``);
        }
        lines.push('');
      }
    }

    // 商品定妆照
    if (manifest.products.length > 0) {
      lines.push('## 商品定妆照');
      lines.push('');
      for (const p of manifest.products) {
        lines.push(`### ${p.productName}`);
        lines.push('');
        lines.push(`参考图搜索（${p.referenceSearch.status === 'completed' ? '已完成' : '待执行'}）：`);
        p.referenceSearch.queries.forEach((q, i) => lines.push(`${i + 1}. ${q}`));
        if (p.referenceSearch.referenceImages.length > 0) {
          lines.push('');
          lines.push('已回填参考图：');
          p.referenceSearch.referenceImages.forEach((img, i) => lines.push(`${i + 1}. ${img.url || img.localPath || img}`));
        }
        lines.push('');
        lines.push('处理管线：');
        p.processing.pipeline.forEach((step, i) => lines.push(`${i + 1}. ${step.name} — ${step.instruction}`));
        lines.push('');
        lines.push('定妆视角：');
        for (const v of p.portraits) {
          lines.push(`${v.priority}. **${v.viewName}** — ${v.purpose}（状态：${this._statusText(v.status)}）`);
          if (v.outputFile) lines.push(`   - 文件：\`${v.outputFile}\``);
        }
        lines.push('');
      }
    }

    lines.push('---');
    lines.push('');
    lines.push('说明：本定妆照集与镜头提示词共用同一视觉系统锚点；`manifest.json` 为机器可读清单，供渲染与审核环节消费。');
    return lines.join('\n');
  }

  _statusText(status) {
    return { pending: '待执行', completed: '已完成', failed: '失败', skipped: '已跳过' }[status] || status;
  }
}

module.exports = { PortraitSetBuilder };
