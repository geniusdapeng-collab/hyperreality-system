/**
 * error-classifier.js - LLM 错误智能分类器
 * 根据错误类型选择最优重试策略
 */

class ErrorClassifier {
  // 【P2-QUAL-02 修复】为错误分类添加上下文信息
  static classify(error, context = {}) {
    if (!error) return { type: 'UNKNOWN', retryable: true, strategy: 'default', context };

    const message = (error.message || error.toString()).toLowerCase();
    const baseResult = { context };

    // 【修复 P1-5】底层已判定不可重试时，直接尊重底层判定
    if (error.retryable === false) {
      return {
        ...baseResult,
        type: error.llmErrorType || 'UNKNOWN',
        retryable: false,
        strategy: 'stop',
        message: '底层判定不可重试'
      };
    }

    // 【修复 P1-5】HTTP 状态码用语义化匹配，杜绝 "45000ms" 里的 "500" 误判
    const hasStatus = (code) =>
      new RegExp(`(?:http|status|状态码|错误码|code)[^0-9]{0,10}${code}(?!\\d)`).test(message) ||
      new RegExp(`^${code}(?!\\d)\\s`).test(message);

    // 1. 【修复 P1-5】JSON 解析类错误最优先（防止 "invalid json" 落入 PARAM 熔断）
    if (message.includes('json') ||
        message.includes('parse') ||
        message.includes('解析') ||
        message.includes('unexpected token') ||
        (message.includes('invalid') && message.includes('response'))) {
      // JSON 解析超时单独细分
      if (message.includes('timeout') || message.includes('timed out') || message.includes('超时')) {
        return {
          ...baseResult,
          type: 'PARSE',
          retryable: true,
          strategy: 'shrink-prompt',
          shrinkRatio: 0.7,
          message: 'JSON解析超时，缩短prompt重试'
        };
      }
      return {
        ...baseResult,
        type: 'PARSE',
        retryable: true,
        strategy: 'shrink-prompt',
        shrinkRatio: 0.7,
        message: 'JSON 解析失败，缩短 prompt 重试'
      };
    }

    // 2. 【修复 P1-5】超时（含中文"超时"，本地 _callWithTimeout / 并发许可产生的错误）
    if (message.includes('timeout') ||
        message.includes('timed out') ||
        message.includes('etimedout') ||
        message.includes('超时') ||
        message.includes('abort') ||
        message.includes('socket hang up')) {
      return {
        ...baseResult,
        type: 'TIMEOUT',
        retryable: true,
        strategy: 'fixed-timeout',
        message: '网络/调用超时，固定超时时间重试'
      };
    }

    // 3. 鉴权/配置错误 → 不可重试
    if (message.includes('unauthorized') ||
        message.includes('invalid key') ||
        message.includes('api key') ||
        message.includes('apikey') ||
        message.includes('forbidden') ||
        message.includes('鉴权') ||
        message.includes('密钥') ||
        hasStatus(401) || hasStatus(403)) {
      return {
        ...baseResult,
        type: 'AUTH',
        retryable: false,
        strategy: 'circuit-break',
        message: '鉴权失败，请检查 API Key 配置'
      };
    }

    // 4. 限流错误 → 指数退避
    if (message.includes('rate limit') ||
        message.includes('too many request') ||
        message.includes('throttle') ||
        message.includes('quota') ||
        message.includes('限流') ||
        hasStatus(429)) {
      return {
        ...baseResult,
        type: 'RATE_LIMIT',
        retryable: true,
        strategy: 'exponential-backoff',
        backoffMs: 2000,
        message: 'API 限流，指数退避重试'
      };
    }

    // 5. 服务端错误 (5xx) → 渐进式重试
    if (hasStatus(500) || hasStatus(502) || hasStatus(503) || hasStatus(504) ||
        hasStatus(507) || hasStatus(508) || hasStatus(520) || hasStatus(521) ||
        hasStatus(522) || hasStatus(523) || hasStatus(524) || hasStatus(525) ||
        hasStatus(526) || hasStatus(527) || hasStatus(530) ||
        message.includes('internal error') ||
        message.includes('server error') ||
        message.includes('bad gateway') ||
        message.includes('service unavailable') ||
        message.includes('gateway timeout') ||
        message.includes('服务端错误') ||
        message.includes('服务器错误')) {
      return {
        ...baseResult,
        type: 'SERVER',
        retryable: true,
        strategy: 'progressive-backoff',
        backoffMs: 3000,
        message: '服务端错误，渐进式重试'
      };
    }

    // 6. 网络连接错误 → 立即重试
    if (message.includes('network') ||
        message.includes('econnrefused') ||
        message.includes('enotfound') ||
        message.includes('dns') ||
        message.includes('网络错误') ||
        message.includes('连接失败') ||
        message.includes('connect')) {
      return {
        ...baseResult,
        type: 'NETWORK',
        retryable: true,
        strategy: 'immediate',
        message: '网络错误，立即重试'
      };
    }

    // 7. 【修复 P1-5】参数错误放最后，且移除裸 'invalid'/'schema' 子串（防误伤）
    if (message.includes('bad request') ||
        message.includes('参数错误') ||
        message.includes('缺少参数') ||
        hasStatus(400)) {
      return {
        ...baseResult,
        type: 'PARAM',
        retryable: false,
        strategy: 'stop',
        message: '参数错误，需检查配置'
      };
    }

    // 默认：未知错误，保守重试
    return {
      ...baseResult,
      type: 'UNKNOWN',
      retryable: true,
      strategy: 'default',
      message: '未知错误，默认重试策略'
    };
  }
  
  /**
   * 计算下次重试的超时时间
   */
  static calculateTimeout(baseTimeout, attempt, classification) {
    switch (classification.strategy) {
      case 'fixed-timeout':
        // 固定超时：不增加超时时间
        return baseTimeout;
      case 'progressive-timeout':
        // 渐进式：60→120→180→240→300s
        return Math.min(300000, baseTimeout * Math.pow(classification.timeoutMultiplier || 1.5, attempt - 1));
      case 'exponential-backoff':
        // 指数退避：2^attempt × 起始退避
        return Math.min(300000, baseTimeout + (classification.backoffMs || 2000) * Math.pow(2, attempt - 1));
      case 'immediate':
        return baseTimeout;
      case 'shrink-prompt':
        return baseTimeout;
      default:
        return Math.min(300000, baseTimeout * 1.2);
    }
  }
  
  /**
   * 计算下次重试的等待时间（重试前停顿）
   */
  static calculateDelay(attempt, classification) {
    switch (classification.strategy) {
      case 'exponential-backoff':
        return Math.min(30000, (classification.backoffMs || 2000) * Math.pow(2, attempt - 1));
      case 'progressive-backoff':
        return Math.min(30000, (classification.backoffMs || 3000) * attempt);
      case 'immediate':
        return 0;
      case 'shrink-prompt':
        return 500; // 短暂停顿
      default:
        return Math.min(10000, 1000 * attempt);
    }
  }
  
  /**
   * 是否需要缩短 prompt
   */
  static shouldShrinkPrompt(classification) {
    return classification.strategy === 'shrink-prompt';
  }
  
  /**
   * 缩短 prompt
   */
  static shrinkPrompt(prompt, ratio) {
    const targetLen = Math.floor(prompt.length * (ratio || 0.7));
    // 保留 system prompt 部分，缩短示例部分
    const systemEnd = prompt.indexOf('【目标JSON结构示例】');
    if (systemEnd > 0) {
      // 保留 system prompt，缩短示例
      return prompt.substring(0, systemEnd) + '\n[输出结构见schema]\n}';
    }
    // 简单粗暴：截断
    return prompt.substring(0, targetLen);
  }
}

module.exports = { ErrorClassifier };
