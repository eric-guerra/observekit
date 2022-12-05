'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { InMemorySpanExporter } = require('@opentelemetry/sdk-trace-base');
const { initTelemetry } = require('../lib/telemetry');
const { createInventoryApp } = require('../services/inventory');
const { createCheckoutApp } = require('../services/checkout');
const { rulesFor, budgetRemaining, toYaml, validate } = require('../slo/burnrate');
const { dashboard } = require('../slo/generate');

const listen = (app) => new Promise((r) => { const s = app.listen(0, () => r(s)); });
const url = (s) => `http://127.0.0.1:${s.address().port}`;

function sink() {
  const lines = [];
  return { lines, write: (l) => lines.push(JSON.parse(l)) };
}

let invExp, coExp, inv, co, invTel, coTel, invSrv, coSrv, coLogs;
const faults = { latencyMs: 0, errorRate: 0 };

before(async () => {
  invExp = new InMemorySpanExporter();
  coExp = new InMemorySpanExporter();
  coLogs = sink();
  invTel = initTelemetry({ serviceName: 'inventory', exporter: invExp, sync: true, logStream: sink() });
  coTel = initTelemetry({ serviceName: 'checkout', exporter: coExp, sync: true, logStream: coLogs });
  invSrv = await listen(createInventoryApp(invTel, faults));
  coSrv = await listen(createCheckoutApp(coTel, url(invSrv)));
  inv = url(invSrv);
  co = url(coSrv);
});

after(async () => {
  invSrv.closeAllConnections(); invSrv.close();
  coSrv.closeAllConnections(); coSrv.close();
});

async function checkout(items, headers = {}) {
  return fetch(`${co}/checkout`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ items }) });
}

test('one trace spans checkout → inventory with correct parentage', async () => {
  coExp.reset(); invExp.reset();
  const res = await checkout([{ sku: 'TEE-M', qty: 1 }, { sku: 'MUG', qty: 1 }], { 'x-store-id': '42' });
  assert.equal(res.status, 201);
  const traceparent = res.headers.get('traceparent');
  assert.match(traceparent, /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);

  const coSpans = coExp.getFinishedSpans();
  const invSpans = invExp.getFinishedSpans();
  const server = coSpans.find((s) => s.name === 'POST /checkout');
  const clients = coSpans.filter((s) => s.kind === 2 /* CLIENT */);
  const invServers = invSpans.filter((s) => s.name === 'GET /stock/:sku');
  assert.ok(server, 'checkout server span named by route template');
  assert.equal(clients.length, 2);
  assert.equal(invServers.length, 2);

  const traceId = server.spanContext().traceId;
  assert.equal(traceparent.split('-')[1], traceId);
  for (const s of [...coSpans, ...invSpans]) assert.equal(s.spanContext().traceId, traceId, `${s.name} in same trace`);
  // inventory server spans are children of checkout's client spans
  const clientIds = new Set(clients.map((c) => c.spanContext().spanId));
  for (const s of invServers) assert.ok(clientIds.has(s.parentSpanId));
  for (const c of clients) assert.equal(c.parentSpanId, server.spanContext().spanId);
  // DB child span under inventory server span
  const db = invSpans.find((s) => s.name === 'db.select stock');
  assert.ok(invServers.some((s) => s.spanContext().spanId === db.parentSpanId));
  assert.equal(server.attributes['store.id'], '42');
  assert.equal(server.attributes['http.route'], '/checkout');
});

test('logs carry the trace id of the request', async () => {
  coExp.reset();
  coLogs.lines.length = 0;
  await checkout([{ sku: 'TEE-M', qty: 1 }]);
  const traceId = coExp.getFinishedSpans().find((s) => s.name === 'POST /checkout').spanContext().traceId;
  const done = coLogs.lines.find((l) => l.msg === 'checkout complete');
  assert.equal(done.trace_id, traceId);
  assert.equal(done.service, 'checkout');
});

test('dependency failures mark spans as errors and count as 5xx', async () => {
  coExp.reset(); invExp.reset();
  faults.errorRate = 1;
  const res = await checkout([{ sku: 'TEE-M', qty: 1 }]);
  faults.errorRate = 0;
  assert.equal(res.status, 502);
  const server = coExp.getFinishedSpans().find((s) => s.name === 'POST /checkout');
  assert.equal(server.status.code, 2 /* ERROR */);
  const db = invExp.getFinishedSpans().find((s) => s.name === 'db.select stock');
  assert.equal(db.events[0].name, 'exception');

  const metrics = await (await fetch(`${co}/metrics`)).text();
  assert.match(metrics, /http_server_requests_total\{method="POST",route="\/checkout",status_class="5xx",service="checkout"\} [1-9]/);
});

test('metrics use route templates, not raw paths', async () => {
  await fetch(`${inv}/stock/TEE-M`);
  await fetch(`${inv}/stock/CAP`);
  await fetch(`${inv}/nope/123`);
  const m = await (await fetch(`${inv}/metrics`)).text();
  assert.match(m, /route="\/stock\/:sku"/);
  assert.match(m, /route="unmatched"/);
  assert.doesNotMatch(m, /route="\/stock\/TEE-M"/);
  assert.match(m, /http_server_duration_seconds_bucket\{le="0.3",method="GET",route="\/stock\/:sku",status_class="2xx",service="inventory"\}/);
});

test('incoming traceparent is continued (and unsampled parents stay unsampled)', async () => {
  coExp.reset();
  const parent = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';
  await fetch(`${co}/healthz`, { headers: { traceparent: parent } });
  const span = coExp.getFinishedSpans().find((s) => s.name.endsWith('/healthz'));
  assert.equal(span.spanContext().traceId, '0af7651916cd43dd8448eb211c80319c');
  assert.equal(span.parentSpanId, 'b7ad6b7169203331');

  coExp.reset();
  await fetch(`${co}/healthz`, { headers: { traceparent: '00-1af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00' } });
  assert.equal(coExp.getFinishedSpans().length, 0);
});

test('burn-rate rules follow the workbook windows', () => {
  const { recording, alerts } = rulesFor({ name: 'checkout_availability', service: 'checkout', route: '/checkout', type: 'availability', objective: 0.999 });
  assert.deepEqual(recording.map((r) => r.record.split('_').pop()), ['1h', '5m', '6h', '30m', '1d', '2h', '3d']);
  assert.equal(alerts.length, 4);
  assert.match(alerts[0].expr, /slo:checkout_availability:error_ratio_1h > \(14\.4 \* 0\.001\)\nand\nslo:checkout_availability:error_ratio_5m > \(14\.4 \* 0\.001\)/);
  assert.deepEqual(alerts.map((a) => a.labels.severity), ['page', 'page', 'ticket', 'ticket']);
  assert.match(recording[0].expr, /status_class="5xx"/);
});

test('latency SLO uses the bucket at the threshold', () => {
  const { recording } = rulesFor({ name: 'inv_lat', service: 'inventory', type: 'latency', objective: 0.995, thresholdSeconds: 0.3 });
  assert.match(recording[0].expr, /le="0\.3"/);
  assert.throws(() => validate({ name: 'x', service: 's', type: 'latency', objective: 0.99 }), /thresholdSeconds/);
  assert.throws(() => validate({ name: 'x', service: 's', type: 'availability', objective: 1 }), /objective/);
});

test('error budget math', () => {
  assert.equal(budgetRemaining(0.999, 0), 1);
  assert.ok(Math.abs(budgetRemaining(0.999, 0.0005) - 0.5) < 1e-9);
  assert.equal(budgetRemaining(0.999, 0.01), -1);
});

test('rule YAML and dashboard are well-formed', () => {
  const slo = { name: 'a', service: 'svc', type: 'availability', objective: 0.99 };
  const { recording, alerts } = rulesFor(slo);
  const yaml = toYaml([{ name: 'slo-a', rules: [...recording, ...alerts] }]);
  assert.match(yaml, /^groups:\n  - name: "slo-a"/);
  assert.match(yaml, /      - alert: "SLOBurn_a_1h"\n        expr: \|-\n          slo:a:error_ratio_1h/);
  const d = dashboard('svc', [slo]);
  assert.equal(d.uid, 'slo-svc');
  assert.equal(new Set(d.panels.map((p) => p.id)).size, d.panels.length);
});
