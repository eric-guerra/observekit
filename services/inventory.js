'use strict';
const express = require('express');

/**
 * Inventory service. `faults` lets tests and the load script inject latency / errors so the
 * dashboards and burn-rate alerts have something to show.
 */
function createInventoryApp(tel, faults = { latencyMs: 0, errorRate: 0 }) {
  const app = express();
  app.use(tel.middleware());
  const stock = new Map([['TEE-M', 25], ['MUG', 3], ['CAP', 0]]);

  app.get('/stock/:sku', async (req, res) => {
    const qty = await tel.withSpan('db.select stock', { 'db.system': 'postgresql', 'db.operation': 'SELECT' }, async () => {
      if (faults.latencyMs) await new Promise((r) => setTimeout(r, faults.latencyMs));
      if (Math.random() < faults.errorRate) throw new Error('connection reset');
      return stock.get(req.params.sku);
    }).catch((e) => {
      req.log.error('stock lookup failed', { err: e, sku: req.params.sku });
      return undefined;
    });
    if (qty === undefined && stock.has(req.params.sku)) return res.status(503).json({ error: 'unavailable' });
    if (qty === undefined) return res.status(404).json({ error: 'unknown sku' });
    res.json({ sku: req.params.sku, available: qty });
  });

  app.get('/metrics', tel.metricsHandler());
  app.get('/healthz', (_req, res) => res.send('ok'));
  return app;
}

module.exports = { createInventoryApp };

if (require.main === module) {
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { initTelemetry } = require('../lib/telemetry');
  const tel = initTelemetry({ serviceName: 'inventory', exporter: new OTLPTraceExporter(), sampleRatio: Number(process.env.SAMPLE_RATIO || 1) });
  const faults = { latencyMs: Number(process.env.FAULT_LATENCY_MS || 0), errorRate: Number(process.env.FAULT_ERROR_RATE || 0) };
  createInventoryApp(tel, faults).listen(process.env.PORT || 8082, () => tel.logger.info('listening', { port: process.env.PORT || 8082 }));
  process.on('SIGTERM', () => tel.shutdown().finally(() => process.exit(0)));
}
