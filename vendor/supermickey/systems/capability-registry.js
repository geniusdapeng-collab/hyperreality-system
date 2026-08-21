'use strict';

const { createLogger } = require('./logger');

class CapabilityRegistry {
  constructor(options = {}) {
    this.logger = options.logger || createLogger('capability-registry');
    this.capabilities = new Map();
  }

  register(name, provider) {
    if (!name || typeof name !== 'string') {
      throw new Error('Capability name 必须是非空字符串');
    }

    if (!provider) {
      throw new Error(`Capability ${name} provider 不能为空`);
    }

    this.capabilities.set(name, provider);
    this.logger.info('能力已注册', { name });
    return provider;
  }

  get(name) {
    return this.capabilities.get(name) || null;
  }

  has(name) {
    return this.capabilities.has(name);
  }

  require(name) {
    const capability = this.get(name);
    if (!capability) {
      throw new Error(`缺少能力注册: ${name}`);
    }
    return capability;
  }

  list() {
    return Array.from(this.capabilities.keys());
  }

  exportMeta() {
    return this.list().map(name => ({
      name,
      type: typeof this.capabilities.get(name)
    }));
  }
}

function createDefaultCapabilityRegistry(options = {}) {
  const registry = new CapabilityRegistry(options);

  registry.register('scriptService', nullSafeRequire('../systems/stages/stage-script', 'StageScriptService'));
  registry.register('durationService', nullSafeRequire('../systems/stages/stage-duration', 'StageDurationService'));
  registry.register('storyboardService', nullSafeRequire('../systems/stages/stage-storyboard', 'StageStoryboardService'));
  registry.register('cameraService', nullSafeRequire('../systems/stages/stage-camera', 'StageCameraService'));
  registry.register('renderPrepService', nullSafeRequire('../systems/stages/stage-render-prep', 'StageRenderPrepService'));
  registry.register('qualityGate', nullSafeRequire('../systems/quality-gate', 'QualityGate'));
  registry.register('renderSubmitter', nullSafeRequire('../systems/render-submitter', 'RenderSubmitter'));

  return registry;
}

function nullSafeRequire(modulePath, exportName) {
  try {
    const mod = require(modulePath);
    return mod[exportName] || mod || null;
  } catch (err) {
    return null;
  }
}

module.exports = {
  CapabilityRegistry,
  createDefaultCapabilityRegistry
};
