'use strict';

function safeStringify(meta) {
  try {
    return JSON.stringify(meta);
  } catch (err) {
    return '[Unserializable Meta]';
  }
}

function createLogger(moduleName) {
  function format(level, message, meta = null) {
    const time = new Date().toISOString();
    const metaText = meta ? ` ${safeStringify(meta)}` : '';
    return `[${time}] [${level}] [${moduleName}] ${message}${metaText}`;
  }

  return {
    debug(message, meta = null) {
      console.debug(format('DEBUG', message, meta));
    },
    info(message, meta = null) {
      console.log(format('INFO', message, meta));
    },
    warn(message, meta = null) {
      console.warn(format('WARN', message, meta));
    },
    error(message, meta = null) {
      console.error(format('ERROR', message, meta));
    }
  };
}

module.exports = { createLogger };
