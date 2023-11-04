# ObserveKit

Portfolio reference implementation of a 2022 project, built to show a drop-in observability kit for Node services: traces, RED metrics, correlated logs and SLO burn-rate alerting. It is demonstrated on a checkout → inventory call path.

**Stack:** OpenTelemetry JS (API 1.1, SDK 1.3), OTLP, the OpenTelemetry Collector (with tail sampling), Jaeger, Prometheus (`prom-client`), Grafana 9, Express.

## What one `initTelemetry()` call gives a service
- **Tracing:**
  - W3C `traceparent` and baggage propagation.
  - A server span per request, named by route template (`GET /stock/:sku`).
  - A client span and context injection for outbound `tracedFetch`.
  - `withSpan()` for DB, cache and queue work.
  - Parent-based head sampling, with tail sampling in the Collector that keeps every error and slow trace plus 10% of the rest.
- **RED metrics:** request counter and duration histogram labelled by **route template** (never the raw path, to avoid a cardinality explosion) and status class. Histogram buckets sit on the SLO thresholds (300 ms, 1 s), so SLO queries are exact.
- **Correlated logs:** JSON lines carrying `trace_id` and `span_id`, so you can jump from a log line to its trace.

## SLOs as code
`slo/slos.json` → `node slo/generate.js` produces:
- `deploy/prometheus/slo-rules.yml`, with recording rules per window and **multi-window, multi-burn-rate alerts** (SRE Workbook):

  | Long window | Short window | Burn rate | Severity |
  |---|---|---|---|
  | 1h | 5m | 14.4× | page |
  | 6h | 30m | 6× | page |
  | 1d | 2h | 3× | ticket |
  | 3d | 6h | 1× | ticket |

- `deploy/grafana/dashboards/slo-<service>.json`: RED panels plus error-budget-remaining stat panels.

Availability and latency SLOs are both supported. Every alert carries a runbook link and the dashboard link.

## Run
```bash
npm install
docker compose up          # services + collector + Jaeger :16686 + Prometheus :9090 + Grafana :3000
FAULT_ERROR_RATE=0.2 docker compose up -d inventory   # inject failures and watch the burn-rate alerts fire
```

## Test
```bash
npm test
```
The 9 tests run two real HTTP services in-process with in-memory span exporters. They check:
- A single trace spans both services, with exact parent/child links.
- Log lines carry the trace id.
- Error status propagates to spans and to 5xx metrics.
- Metric labels use route templates.
- An incoming `traceparent` is continued, and unsampled parents are respected.
- Burn-rate rules, error budget math and the generated YAML and dashboards are correct.
