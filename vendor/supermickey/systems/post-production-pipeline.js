#!/usr/bin/env node
/**
 * 【系统级】通用后期制作管线 v4
 * 适用于所有科普/宣传片项目
 * 
 * 系统约束：
 * 1. 横版输出（16:9） - 竖版素材自动横屏化
 * 2. 无字幕输出 - 合成已包含字幕，后期不再单独添加
 * 3. 单版输出 - 只输出一版成片，无字幕版/静音版等副本
 * 4. 画面文字 - Prompt中禁止小字，只允许大背景少量大字
 */

const fs = require('fs').promises;
const fss = require('fs');
const path = require('path');
const { execSync, spawnSync } = require('child_process');

class PostProductionPipeline {
  constructor(projectConfig) {
    this.config = {
      outputRatio: '16:9',
      outputWidth: 1280,
      outputHeight: 720,
      // v3: 字幕由人工后期单独添加，系统不生成字幕
      ...projectConfig
    };
  }

  /**
   * 主流程：合并 + 横版转换 + 片头标题烧录
   * v3变更：移除字幕生成和烧录，字幕由人工后期单独添加
   * 【v5.0-patch22 新增】片头标题强制烧录
   */
  async produce(shots, options = {}) {
    const {
      shotsDir,
      finalDir,
      title = '成片',
      titleConfig           // { mainTitle, subTitle, producer }
    } = options;

    // 确保输出目录
    if (!fss.existsSync(finalDir)) {
      fss.mkdirSync(finalDir, { recursive: true });
    }

    console.log(`🎬 后期制作: ${title}`);
    console.log(`   镜头数: ${shots.length}`);
    console.log(`   输出比例: ${this.config.outputRatio} (${this.config.outputWidth}x${this.config.outputHeight})`);
    console.log(`   字幕: ❌ 系统不生成（人工后期单独添加）`);
    console.log('='.repeat(60));

    // 步骤0: 片头标题烧录（v5.0-patch22 新增）
    if (titleConfig && titleConfig.mainTitle) {
      this.burnTitleOverlay(shots, shotsDir, titleConfig);
    }

    // 步骤1: 测量每个镜头的实际时长（用于报告）
    const shotDurations = this.measureActualDurations(shots, shotsDir);
    
    // 步骤2: 合并 + 横版转换
    const cleanPath = path.join(finalDir, `${title}.mp4`);
    this.mergeAndConvert(shots, shotsDir, cleanPath);

    // 步骤3: 输出报告
    return this.generateReport(cleanPath, shots, shotDurations);
  }

  /**
   * 测量每个镜头的实际时长（仅用于报告，不用于字幕）
   */
  measureActualDurations(shots, shotsDir) {
    const durations = [];
    
    for (const shot of shots) {
      const videoPath = path.join(shotsDir, `${shot.id}.mp4`);
      if (!fss.existsSync(videoPath)) {
        console.warn(`⚠️ 视频不存在: ${shot.id}`);
        durations.push({
          shotId: shot.id,
          expectedDuration: shot.duration,
          actualDuration: shot.duration,
          hasVideo: false
        });
        continue;
      }

      try {
        // P1-fix: 用 spawnSync 数组传参替代 execSync 字符串拼接，杜绝命令注入
        const ffprobeResult = spawnSync('ffprobe', [
          '-v', 'error',
          '-show_entries', 'format=duration',
          '-of', 'default=noprint_wrappers=1:nokey=1',
          videoPath
        ], { encoding: 'utf8', timeout: 10000 });
        if (ffprobeResult.status !== 0) throw new Error(`ffprobe 失败: ${ffprobeResult.stderr?.slice(0, 200)}`);
        const result = ffprobeResult.stdout.trim();
        const actualDuration = parseFloat(result);

        durations.push({
          shotId: shot.id,
          expectedDuration: shot.duration,
          actualDuration: actualDuration,
          hasVideo: true
        });

        const diff = Math.abs(actualDuration - shot.duration);
        if (diff > 1) {
          console.log(`   ⚠️ ${shot.id}: 设计时长${shot.duration}s ≠ 实际${actualDuration.toFixed(1)}s`);
        } else {
          console.log(`   ✅ ${shot.id}: ${actualDuration.toFixed(1)}s`);
        }
      } catch (e) {
        console.warn(`   ❌ ${shot.id}: 测量失败`);
        durations.push({
          shotId: shot.id,
          expectedDuration: shot.duration,
          actualDuration: shot.duration,
          hasVideo: false
        });
      }
    }

    return durations;
  }

  /**
   * 【v4已移除】字幕相关方法已删除
   * 合成已包含字幕，后期不再单独添加字幕/SRT/烧录
   */

  /**
   * 【v5.0-patch22 新增】片头标题强制烧录
   * 自动检测片头镜头(S00/opening)并叠加主标题+副标题+出品人
   * 
   * 样式规范（山海经系列强制英文）：
   * - 主标题: 48px, 白色, 居中偏上, 粗体
   * - 副标题: 28px, 白色, 主标题下方
   * - 出品人: 36px, 金色(#FFD700), 底部居中, 粗体, 占底部30%高度
   * 
   * @param {Array} shots - 故事板镜头列表
   * @param {String} shotsDir - 镜头素材目录
   * @param {Object} titleConfig - { mainTitle, subTitle, producer }
   */
  burnTitleOverlay(shots, shotsDir, titleConfig) {
    const openingShot = shots.find(s => 
      s.id === 'S00' || s.type === 'opening' || s.isOpening === true
    );
    
    if (!openingShot) {
      console.log('   ℹ️ 无片头镜头(S00)，跳过标题烧录');
      return;
    }
    
    const videoPath = path.join(shotsDir, `${openingShot.id}.mp4`);
    if (!fss.existsSync(videoPath)) {
      console.warn(`   ⚠️ 片头视频不存在: ${videoPath}，跳过标题烧录`);
      return;
    }
    
    const { mainTitle, subTitle, producer = 'by Genius' } = titleConfig;
    if (!mainTitle) {
      console.log('   ℹ️ 未配置主标题，跳过片头标题烧录');
      return;
    }
    
    console.log(`\n🔥 片头标题烧录: ${openingShot.id}`);
    console.log(`   主标题: ${mainTitle}`);
    console.log(`   副标题: ${subTitle || '(无)'}`);
    console.log(`   出品人: ${producer}`);
    
    const tempPath = path.join(shotsDir, `${openingShot.id}_titled.mp4`);
    
    // 构建 ffmpeg drawtext 滤镜链
    // 注意：需要 ffmpeg 编译时支持 libfreetype
    // 标题语言：山海经系列强制英文（已在调用方处理）
    const esc = (text) => text.replace(/'/g, "'\\''").replace(/:/g, '\\:');
    
    const drawtextMain = `drawtext=text='${esc(mainTitle)}':fontsize=48:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=h*0.22:box=1:boxcolor=black@0.6:boxborderw=12`;
    
    const drawtextSub = subTitle 
      ? `,drawtext=text='${esc(subTitle)}':fontsize=28:fontcolor=white:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf:x=(w-text_w)/2:y=h*0.32:box=1:boxcolor=black@0.4:boxborderw=8`
      : '';
    
    const drawtextProducer = `drawtext=text='${esc(producer)}':fontsize=36:fontcolor=#FFD700:fontfile=/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf:x=(w-text_w)/2:y=h*0.82:box=1:boxcolor=black@0.5:boxborderw=10`;
    
    const vf = `${drawtextMain}${drawtextSub},${drawtextProducer}`;
    
    const cmd = `ffmpeg -y -i "${videoPath}" -vf "${vf}" -c:v libx264 -preset fast -crf 23 -c:a copy "${tempPath}"`;
    
    try {
      execSync(cmd, { stdio: 'pipe', timeout: 120000 });
      
      // 替换原文件
      const finalPath = path.join(shotsDir, `${openingShot.id}.mp4`);
      if (fss.existsSync(finalPath)) {
        fss.unlinkSync(finalPath);
      }
      fss.renameSync(tempPath, finalPath);
      
      console.log(`   ✅ 片头标题烧录完成: ${openingShot.id}`);
    } catch (e) {
      console.warn(`   ⚠️ 片头标题烧录失败: ${e.message}`);
      console.warn(`   可能原因: ffmpeg 未编译 libfreetype 支持，或字体文件不存在`);
      // 失败不拦截，清理临时文件后继续合并
      if (fss.existsSync(tempPath)) {
        fss.unlinkSync(tempPath);
      }
    }
  }

  /**
   * 合并镜头 + 横版转换
   * 竖版素材(720x1280) → 横版(1280x720)
   */
  mergeAndConvert(shots, shotsDir, outputPath) {
    console.log('\n📹 合并 + 横版转换...');

    // 检查所有素材
    const validShots = shots.filter(shot => {
      const videoPath = path.join(shotsDir, `${shot.id}.mp4`);
      return fss.existsSync(videoPath);
    });

    if (validShots.length === 0) {
      throw new Error('没有可用的视频素材');
    }

    // 方法：concat filter + 横屏化
    const concatInputs = validShots.map((shot, i) => {
      return `-i "${path.join(shotsDir, `${shot.id}.mp4`)}"`;
    }).join(' ');

    // 每个输入都先转为横版，再合并
    const filters = [];
    for (let i = 0; i < validShots.length; i++) {
      // scale+pad: 将720x1280竖版转为1280x720横版
      // 方案：缩放+黑边填充（保持比例）
      filters.push(`[${i}:v]scale=406:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:black[v${i}]`);
    }

    // 合并视频和音频
    const concatVideo = filters.map((f, i) => `[v${i}]`).join('') + `concat=n=${validShots.length}:v=1:a=0[outv]`;
    const concatAudio = validShots.map((f, i) => `[${i}:a:0]`).join('') + `concat=n=${validShots.length}:v=0:a=1[outa]`;

    const fullFilter = `${filters.join(';')};${concatVideo};${concatAudio}`;

    const cmd = `ffmpeg -y ${concatInputs} -filter_complex "${fullFilter}" -map [outv] -map [outa] -c:v libx264 -preset fast -crf 23 -c:a aac -b:a 128k -r 30 -s ${this.config.outputWidth}x${this.config.outputHeight} "${outputPath}"`;

    try {
      execSync(cmd, { stdio: 'inherit', timeout: 300000 });
      console.log(`✅ 纯净版完成: ${outputPath}`);
    } catch (e) {
      console.error('❌ 合并失败:', e.message);
      throw e;
    }
  }

  /**
   * 【v4已移除】字幕烧录方法已删除
   * 合成已包含字幕，后期不再单独烧录字幕
   */

  /**
   * 生成制作报告（v4: 仅输出单版成片）
   */
  generateReport(cleanPath, shots, durations) {
    const cleanStats = fss.statSync(cleanPath);

    try {
      // P1-fix: 用 spawnSync 数组传参替代 execSync 字符串拼接
      const ffprobeResult = spawnSync('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        cleanPath
      ], { encoding: 'utf8' });
      if (ffprobeResult.status !== 0) throw new Error(`ffprobe 失败: ${ffprobeResult.stderr?.slice(0, 200)}`);
      const durationStr = ffprobeResult.stdout.trim();
      const totalDuration = parseFloat(durationStr);

      console.log('\n🎉 后期制作完成！');
      console.log('='.repeat(60));
      console.log(`📁 成片: ${cleanPath}`);
      console.log(`   大小: ${(cleanStats.size / 1024 / 1024).toFixed(1)}MB`);
      console.log(`   时长: ${totalDuration.toFixed(1)}秒`);
      console.log(`   分辨率: ${this.config.outputWidth}x${this.config.outputHeight}`);
      console.log(`   字幕: ❌ 系统不生成（人工后期单独添加）`);
      console.log('='.repeat(60));

      return {
        success: true,
        cleanFile: cleanPath,
        cleanSize: cleanStats.size,
        duration: totalDuration,
        resolution: `${this.config.outputWidth}x${this.config.outputHeight}`,
        shots: durations,
        subtitleGenerated: false
      };
    } catch (e) {
      console.log('\n🎉 后期制作完成！');
      console.log('='.repeat(60));
      console.log(`📁 成片: ${cleanPath}`);
      console.log(`   大小: ${(cleanStats.size / 1024 / 1024).toFixed(1)}MB`);
      console.log(`   字幕: 人工后期单独添加`);
      console.log('='.repeat(60));

      return {
        success: true,
        cleanFile: cleanPath,
        cleanSize: cleanStats.size,
        shots: durations,
        subtitleGenerated: false
      };
    }
  }
}

module.exports = { PostProductionPipeline };
