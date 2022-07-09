'use strict';
// Minimal JSON logger. Every line carries trace_id/span_id so Grafana can jump log → trace (Loki derived field).

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function createLogger(service, stream = process.stdout, base = {}, minLevel = process.env.LOG_LEVEL || 'info') {
  const write = (level, msg, fields) => {
    if (LEVELS[level] < LEVELS[minLevel]) return;
    const line = { ts: new Date().toISOString(), level, service, msg, ...base, ...fields };
    if (fields && fields.err instanceof Error) line.err = { message: fields.err.message, stack: fields.err.stack };
    stream.write(JSON.stringify(line) + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (spanContext) => createLogger(service, stream, { ...base, trace_id: spanContext.traceId, span_id: spanContext.spanId }, minLevel),
  };
}

module.exports = { createLogger };
