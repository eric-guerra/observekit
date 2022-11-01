'use strict';
const express = require('express');
const api = require('@opentelemetry/api');

function createCheckoutApp(tel, inventoryUrl) {
  const app = express();
  app.use(tel.middleware());
  app.use(express.json());

  app.post('/checkout', async (req, res) => {
    const items = req.body.items || [];
    // Business attributes on the active server span make traces searchable ("show me failed checkouts for store 42").
    api.trace.getSpan(api.context.active())?.setAttributes({ 'checkout.items': items.length, 'store.id': req.get('x-store-id') || 'web' });
    try {
      const results = await Promise.all(items.map(async ({ sku, qty }) => {
        const r = await tel.tracedFetch(`${inventoryUrl}/stock/${encodeURIComponent(sku)}`, {}, 'inventory');
        if (r.status === 404) return { sku, ok: false, reason: 'unknown' };
        if (!r.ok) throw new Error(`inventory ${r.status}`);
        const body = await r.json();
        return { sku, ok: body.available >= qty, reason: body.available >= qty ? null : 'insufficient' };
      }));
      const problems = results.filter((r) => !r.ok);
      if (problems.length) return res.status(409).json({ problems });
      const orderId = await tel.withSpan('orders.insert', { 'db.system': 'postgresql' }, async () => `O-${Date.now().toString(36)}`);
      req.log.info('checkout complete', { orderId, items: items.length });
      res.status(201).json({ orderId });
    } catch (e) {
      req.log.error('checkout failed', { err: e });
      res.status(502).json({ error: 'dependency failure' });
    }
  });

  app.get('/metrics', tel.metricsHandler());
  app.get('/healthz', (_req, res) => res.send('ok'));
  return app;
}

module.exports = { createCheckoutApp };

if (require.main === module) {
  const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
  const { initTelemetry } = require('../lib/telemetry');
  const tel = initTelemetry({ serviceName: 'checkout', exporter: new OTLPTraceExporter(), sampleRatio: Number(process.env.SAMPLE_RATIO || 1) });
  createCheckoutApp(tel, process.env.INVENTORY_URL || 'http://localhost:8082')
    .listen(process.env.PORT || 8081, () => tel.logger.info('listening', { port: process.env.PORT || 8081 }));
  process.on('SIGTERM', () => tel.shutdown().finally(() => process.exit(0)));
}
