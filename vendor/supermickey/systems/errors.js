'use strict';

class AppError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code || 'APP_ERROR';
    this.stage = options.stage || null;
    this.retryable = options.retryable || false;
    this.details = options.details || null;
  }
}

class ConfigError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'CONFIG_ERROR', retryable: false });
  }
}

class ValidationError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'VALIDATION_ERROR', retryable: false });
  }
}

class StageExecutionError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'STAGE_EXECUTION_ERROR', retryable: true });
  }
}

class ExternalAPIError extends AppError {
  constructor(message, options = {}) {
    super(message, { ...options, code: 'EXTERNAL_API_ERROR', retryable: true });
  }
}

module.exports = {
  AppError,
  ConfigError,
  ValidationError,
  StageExecutionError,
  ExternalAPIError
};
