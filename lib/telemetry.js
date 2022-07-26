'use strict';
// One call per service: tracer provider + W3C propagation + RED metrics + correlated logs.
const api = require('@opentelemetry/api');
const { NodeTracerProvider } = require('@opentelemetry/sdk-trace-node');
const { BatchSpanProcessor, SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { Resource } = require('@opentelemetry/resources');
const { SemanticResourceAttributes: R, SemanticAttributes: A } = require('@opentelemetry/semantic-conventions');
const { W3CTraceContextPropagator, W3CBaggagePropagator, CompositePropagator, ParentBasedSampler, TraceIdRatioBasedSampler } = require('@opentelemetry/core');
const client = require('prom-client');
const { createLogger } = require('./logger');

/**
 * @param {object} o
 * @param {string} o.serviceName
 * @param {import('@opentelemetry/sdk-trace-base').SpanExporter} [o.exporter]  OTLP in prod, in-memory in tests
 * @param {number} [o.sampleRatio]  head sampling for root spans; children follow their parent
 * @param {boolean} [o.sync]  export spans synchronously (tests)
 */
function initTelemetry({ serviceName, serviceVersion = '1.0.0', exporter, sampleRatio = 1, sync = false, logStream }) {
  const provider = new NodeTracerProvider({
    resource: new Resource({
      [R.SERVICE_NAME]: serviceName,
      [R.SERVICE_VERSION]: serviceVersion,
      [R.DEPLOYMENT_ENVIRONMENT]: process.env.DEPLOY_ENV || 'dev',
    }),
    sampler: new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(sampleRatio) }),
  });
  if (exporter) provider.addSpanProcessor(sync ? new SimpleSpanProcessor(exporter) : new BatchSpanProcessor(exporter));
  provider.register({
    propagator: new CompositePropagator({ propagators: [new W3CTraceContextPropagator(), new W3CBaggagePropagator()] }),
  });
  const tracer = provider.getTracer(serviceName, serviceVersion);

  // Each service gets its own registry so tests can run two services in one process.
  const registry = new client.Registry();
  registry.setDefaultLabels({ service: serviceName });
  client.collectDefaultMetrics({ register: registry, prefix: 'process_' });
  const duration = new client.Histogram({
    name: 'http_server_duration_seconds',
    help: 'Inbound HTTP request duration',
    labelNames: ['method', 'route', 'status_class'],
    // Buckets bracket the SLO thresholds (300 ms, 1 s) so the SLO query is exact.
    buckets: [0.025, 0.05, 0.1, 0.2, 0.3, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const requests = new client.Counter({
    name: 'http_server_requests_total',
    help: 'Inbound HTTP requests',
    labelNames: ['method', 'route', 'status_class'],
    registers: [registry],
  });
  const outbound = new client.Histogram({
    name: 'http_client_duration_seconds',
    help: 'Outbound HTTP call duration',
    labelNames: ['peer', 'status_class'],
    buckets: [0.025, 0.05, 0.1, 0.3, 1, 3],
    registers: [registry],
  });

  const logger = createLogger(serviceName, logStream);

  /** Express middleware: server span, RED metrics, request-scoped logger. Mount first. */
  function middleware() {
    return (req, res, next) => {
      const parent = api.propagation.extract(api.context.active(), req.headers);
      const span = tracer.startSpan(`${req.method} ${req.path}`, {
        kind: api.SpanKind.SERVER,
        attributes: { [A.HTTP_METHOD]: req.method, [A.HTTP_TARGET]: req.originalUrl, [A.HTTP_USER_AGENT]: req.get('user-agent') || '' },
      }, parent);
      const ctx = api.trace.setSpan(parent, span);
      const start = process.hrtime.bigint();
      req.log = logger.child(span.spanContext());
      res.setHeader('traceparent', `00-${span.spanContext().traceId}-${span.spanContext().spanId}-0${span.spanContext().traceFlags}`);

      res.on('finish', () => {
        // Use the route template, not the raw path, so /orders/123 doesn't explode label cardinality.
        const route = req.route ? req.baseUrl + req.route.path : 'unmatched';
        const statusClass = `${Math.floor(res.statusCode / 100)}xx`;
        const secs = Number(process.hrtime.bigint() - start) / 1e9;
        duration.observe({ method: req.method, route, status_class: statusClass }, secs);
        requests.inc({ method: req.method, route, status_class: statusClass });
        span.updateName(`${req.method} ${route}`);
        span.setAttribute(A.HTTP_ROUTE, route);
        span.setAttribute(A.HTTP_STATUS_CODE, res.statusCode);
        if (res.statusCode >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
        span.end();
        req.log.info('request', { method: req.method, route, status: res.statusCode, ms: Math.round(secs * 1000) });
      });
      api.context.with(ctx, next);
    };
  }

  /** fetch() with a client span and trace context injected into the outgoing headers. */
  async function tracedFetch(url, init = {}, peer = new URL(url).host) {
    const span = tracer.startSpan(`HTTP ${init.method || 'GET'} ${peer}`, {
      kind: api.SpanKind.CLIENT,
      attributes: { [A.HTTP_METHOD]: init.method || 'GET', [A.HTTP_URL]: url, [A.NET_PEER_NAME]: peer },
    });
    const ctx = api.trace.setSpan(api.context.active(), span);
    const headers = { ...(init.headers || {}) };
    api.propagation.inject(ctx, headers);
    const start = process.hrtime.bigint();
    try {
      const res = await api.context.with(ctx, () => fetch(url, { ...init, headers }));
      span.setAttribute(A.HTTP_STATUS_CODE, res.status);
      if (res.status >= 500) span.setStatus({ code: api.SpanStatusCode.ERROR });
      outbound.observe({ peer, status_class: `${Math.floor(res.status / 100)}xx` }, Number(process.hrtime.bigint() - start) / 1e9);
      return res;
    } catch (e) {
      span.recordException(e);
      span.setStatus({ code: api.SpanStatusCode.ERROR, message: e.message });
      outbound.observe({ peer, status_class: 'error' }, Number(process.hrtime.bigint() - start) / 1e9);
      throw e;
    } finally {
      span.end();
    }
  }

  /** Wrap any async unit of work (DB call, cache, queue publish) in a child span. */
  async function withSpan(name, attributes, fn) {
    return tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn(span);
      } catch (e) {
        span.recordException(e);
        span.setStatus({ code: api.SpanStatusCode.ERROR, message: e.message });
        throw e;
      } finally {
        span.end();
      }
    });
  }

  function metricsHandler() {
    return async (_req, res) => {
      res.set('Content-Type', registry.contentType);
      res.end(await registry.metrics());
    };
  }

  async function shutdown() {
    await provider.shutdown();
  }

  return { tracer, registry, logger, middleware, tracedFetch, withSpan, metricsHandler, shutdown, provider };
}

module.exports = { initTelemetry };
