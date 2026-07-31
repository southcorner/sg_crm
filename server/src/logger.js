'use strict';

const pino = require('pino');

const level = process.env.LOG_LEVEL || (process.env.NODE_ENV === 'production' ? 'info' : 'debug');

const logger = pino({
  level,
  base: undefined, // no pid/hostname noise on a single-machine deployment
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
