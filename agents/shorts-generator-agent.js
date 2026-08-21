const path = require('path');
const fs = require('fs').promises;
const { Logger } = require('../utils/logger');
const { AIVideoGenerator } = require('../utils/ai-video-generator');
const { extractSectionText } = require('../utils/script-text');

class ShortsGeneratorAgent {
  constructor(db, credentials) {
    this.db = db;
    this.logger = new Logger('ShortsGenerator');
    this.aiVideoGenerator = new AIVideoGenerator(credentials?.credentials || credentials || {});
  }

  async initialize() {
    this.logger.info('Initializing Shorts Generator Agent...');
    await fs.mkdir(path.join(__dirname, '..', 'data', 'shorts'), { recursive: true });
    return true;
  }

  // Picks up to `count` sections that are short enough to stand alone as a
  // Short, preferring the most substantial ones under the cap so Shorts
  // aren't built from throwaway one-line sections. Returns to script order
  // so publish sequencing follows the video's original narrative order.
  selectSections(script, count, maxDurationSeconds) {
    const sections = script?.mainContent?.sections || [];
    // A section's declared `duration` is pacing metadata, not a reliable proxy
    // for how much real narration text it holds — generic/template-fallback
    // sections can claim 60s while containing one boilerplate sentence. The
    // operator's quality gate requires >=200 chars of full script text
    // (title + body combined); filter on the body text alone at >=200 so the
    // check passes regardless of how short the section title happens to be.
    const MIN_TEXT_LENGTH = 200;

    return sections
      .map((section, originalIndex) => ({
        section,
        originalIndex,
        duration: Number(section.duration) || 60,
        text: extractSectionText(section)
      }))
      .filter(entry => entry.text.length >= MIN_TEXT_LENGTH && entry.duration <= maxDurationSeconds)
      .sort((a, b) => b.text.length - a.text.length)
      .slice(0, count)
      .sort((a, b) => a.originalIndex - b.originalIndex)
      .map(({ section, originalIndex }) => ({ section, originalIndex }));
  }

  buildShortScript(parentScript, section, originalIndex) {
    const bodyText = extractSectionText(section);
    const durationSeconds = Number(section.duration) || 60;

    return {
      title: section.title || parentScript.title,
      hook: { type: 'short', text: section.title, duration: '0:00-0:03' },
      mainContent: { sections: [section], totalDuration: durationSeconds },
      fullScript: `${section.title}\n\n${bodyText}`,
      duration: this.formatDuration(durationSeconds),
      tone: parentScript.tone,
      pacing: 'quick',
      keywords: parentScript.keywords || [],
      sourceSectionIndex: originalIndex,
      metadata: {
        parentTitle: parentScript.title,
        generatedAt: new Date().toISOString(),
        version: '1.0'
      }
    };
  }

  buildShortSeo(parentSeo = {}, section) {
    const bodyText = extractSectionText(section);
    const tags = Array.from(new Set([...(parentSeo.tags || []), 'shorts']))
      .slice(0, 30);
    const hashtags = Array.from(new Set([...(parentSeo.hashtags || []), '#Shorts']));

    return {
      title: `${section.title} #Shorts`.slice(0, 100),
      description: `${bodyText.slice(0, 400)}\n\n#Shorts`.trim(),
      tags,
      hashtags,
      chapters: [],
      endScreen: parentSeo.endScreen || null,
      seoScore: parentSeo.seoScore || 0,
      metadata: parentSeo.metadata || { category: 22, language: 'en' }
    };
  }

  async assembleShort(shortId, shortScript, visualAssets) {
    const audioPath = path.join(__dirname, '..', 'data', 'shorts', `${shortId}_narration.mp3`);
    const videoPath = path.join(__dirname, '..', 'data', 'shorts', `${shortId}_final.mp4`);
    const thumbnailPath = path.join(__dirname, '..', 'data', 'shorts', `${shortId}_thumbnail.jpg`);
    const durationSeconds = shortScript.mainContent.totalDuration;

    try {
      await this.aiVideoGenerator.generateTTSAudio(shortScript.fullScript, audioPath);
    } catch (error) {
      this.logger.error(`Short narration failed for ${shortId}:`, error);
    }

    const producedPath = await this.aiVideoGenerator.generateShortVideo(
      shortScript, visualAssets, audioPath, videoPath, durationSeconds
    );

    if (!producedPath || path.extname(producedPath).toLowerCase() !== '.mp4') {
      return {
        audio: { path: audioPath, duration: shortScript.duration, format: 'mp3', simulated: true },
        finalVideo: { path: producedPath, fileSize: 0, duration: shortScript.duration, simulated: true },
        thumbnail: null
      };
    }

    const stats = await fs.stat(videoPath);
    let thumbnail = null;
    try {
      await this.aiVideoGenerator.extractThumbnailFrame(videoPath, thumbnailPath);
      const thumbStats = await fs.stat(thumbnailPath);
      thumbnail = {
        path: thumbnailPath,
        dimensions: { width: 1080, height: 1920 },
        fileSize: thumbStats.size,
        generatedWith: 'ffmpeg-frame'
      };
    } catch (error) {
      this.logger.error(`Thumbnail frame extraction failed for ${shortId}:`, error);
    }

    return {
      audio: { path: audioPath, duration: shortScript.duration, format: 'mp3', generatedWith: 'AI' },
      finalVideo: {
        path: videoPath,
        fileSize: stats.size,
        duration: shortScript.duration,
        generatedWith: 'AI',
        resolution: '1080x1920',
        format: 'mp4'
      },
      thumbnail
    };
  }

  async generateShorts(parentProductionData, count) {
    const finalVideo = parentProductionData.assets?.finalVideo;
    if (!finalVideo?.path || finalVideo.simulated) {
      this.logger.warn('Skipping Shorts: parent video is missing or simulated');
      return [];
    }

    const maxDurationSeconds = parseInt(await this.db.getSetting('shorts_max_duration_seconds'), 10) || 90;
    const gapHours = parseInt(await this.db.getSetting('shorts_publish_gap_hours'), 10) || 3;
    const script = parentProductionData.script;
    const candidates = this.selectSections(script, count, maxDurationSeconds);

    if (candidates.length === 0) {
      this.logger.warn('No script sections short enough to become a Short (all exceed shorts_max_duration_seconds)');
      return [];
    }

    const parentVisualAssets = parentProductionData.assets?.video?.visualAssets || [];
    const parentPublishTime = new Date(parentProductionData.scheduledPublishTime || Date.now());
    const results = [];

    for (const [i, { section, originalIndex }] of candidates.entries()) {
      const shortId = this.generateShortId();
      const shortScript = this.buildShortScript(script, section, originalIndex);
      const visualAsset = parentVisualAssets[Math.min(originalIndex + 1, parentVisualAssets.length - 1)];

      this.logger.info(`Assembling Short ${i + 1}/${candidates.length}: ${section.title}`);
      const assets = await this.assembleShort(shortId, shortScript, visualAsset ? [visualAsset] : []);
      const shortSeo = this.buildShortSeo(parentProductionData.seo, section);
      const simulated = Boolean(assets.finalVideo.simulated);
      const publishTime = new Date(parentPublishTime.getTime() + (i + 1) * gapHours * 60 * 60 * 1000);

      results.push({
        id: shortId,
        contentFormat: 'short',
        parentProductionId: parentProductionData.id,
        status: simulated ? 'simulated' : 'ready',
        strategy: parentProductionData.strategy,
        script: shortScript,
        thumbnail: assets.thumbnail,
        seo: shortSeo,
        assets,
        timeline: {
          created: new Date().toISOString(),
          audioGenerated: assets.audio?.generatedWith === 'AI' ? new Date().toISOString() : null,
          videoGenerated: new Date().toISOString(),
          readyForUpload: simulated ? null : new Date().toISOString()
        },
        scheduledPublishTime: publishTime.toISOString(),
        priority: parentProductionData.priority,
        estimatedDuration: shortScript.duration,
        createdAt: new Date().toISOString()
      });

      if (simulated) {
        this.logger.warn(`Short ${shortId} produced PLACEHOLDER assets only — it will not be uploaded.`);
      }
    }

    return results;
  }

  formatDuration(seconds) {
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
  }

  generateShortId() {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 15);
    return `short_${timestamp}_${random}`;
  }
}

module.exports = { ShortsGeneratorAgent };
