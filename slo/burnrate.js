'use strict';
// Multi-window, multi-burn-rate SLO alerts (Google SRE Workbook, ch. 5), generated from a small
// SLO spec so every service gets the same, reviewed alert math instead of hand-written PromQL.

/** Workbook defaults for a 30-day window: [long window, short window, burn rate, severity]. */
const WINDOWS = [
  { long: '1h', short: '5m', burn: 14.4, severity: 'page' }, // 2% of budget in 1h
  { long: '6h', short: '30m', burn: 6, severity: 'page' }, // 5% of budget in 6h
  { long: '1d', short: '2h', burn: 3, severity: 'ticket' }, // 10% of budget in 1d
  { long: '3d', short: '6h', burn: 1, severity: 'ticket' }, // 10% of budget in 3d
];

function validate(slo) {
  if (!/^[a-z][a-z0-9_]*$/.test(slo.name)) throw new Error(`bad slo name ${slo.name}`);
  if (!(slo.objective > 0 && slo.objective < 1)) throw new Error(`${slo.name}: objective must be in (0,1)`);
  if (!['availability', 'latency'].includes(slo.type)) throw new Error(`${slo.name}: type must be availability|latency`);
  if (slo.type === 'latency' && !(slo.thresholdSeconds > 0)) throw new Error(`${slo.name}: latency SLO needs thresholdSeconds`);
}

/** PromQL for the *error ratio* of this SLO over a window. */
function errorRatio(slo, window) {
  const sel = `service="${slo.service}"${slo.route ? `,route="${slo.route}"` : ''}`;
  if (slo.type === 'availability') {
    return `sum(rate(http_server_requests_total{${sel},status_class="5xx"}[${window}]))\n/\nsum(rate(http_server_requests_total{${sel}}[${window}]))`;
  }
  // latency: fraction of requests slower than the threshold = 1 - (fast / all)
  return `1 - (\n  sum(rate(http_server_duration_seconds_bucket{${sel},le="${slo.thresholdSeconds}"}[${window}]))\n  /\n  sum(rate(http_server_duration_seconds_count{${sel}}[${window}]))\n)`;
}

function recordName(slo, window) {
  return `slo:${slo.name}:error_ratio_${window}`;
}

/** Recording rules (one per distinct window) + alerting rules (one per long/short pair). */
function rulesFor(slo) {
  validate(slo);
  const budget = +(1 - slo.objective).toPrecision(6);
  const windows = [...new Set(WINDOWS.flatMap((w) => [w.long, w.short]))];
  const recording = windows.map((w) => ({
    record: recordName(slo, w),
    expr: errorRatio(slo, w),
    labels: { slo: slo.name, service: slo.service },
  }));
  const alerts = WINDOWS.map((w) => ({
    alert: `SLOBurn_${slo.name}_${w.long}`,
    // Both windows must burn: the long one proves it's significant, the short one that it's still happening
    // (so the alert resolves quickly once fixed).
    expr: `${recordName(slo, w.long)} > (${w.burn} * ${budget})\nand\n${recordName(slo, w.short)} > (${w.burn} * ${budget})`,
    for: w.severity === 'page' ? '2m' : '15m',
    labels: { severity: w.severity, slo: slo.name, service: slo.service },
    annotations: {
      summary: `${slo.service}: ${slo.description || slo.name} burning error budget ${w.burn}x`,
      description: `Error ratio over ${w.long} and ${w.short} exceeds ${w.burn}x the ${(budget * 100).toFixed(3)}% budget of a ${(slo.objective * 100).toFixed(2)}% SLO.`,
      runbook_url: slo.runbook || `https://runbooks.example.com/slo/${slo.name}`,
      dashboard: `/d/slo-${slo.service}`,
    },
  }));
  return { recording, alerts };
}

/** Budget remaining given an observed error ratio over the full SLO window (for dashboards/tests). */
function budgetRemaining(objective, observedErrorRatio) {
  const budget = 1 - objective;
  return Math.max(-1, (budget - observedErrorRatio) / budget);
}

/** Minimal YAML emitter for the rule-file shape (no dependency, deterministic output). */
function toYaml(groups) {
  const q = (s) => JSON.stringify(String(s));
  const block = (s, indent) => s.includes('\n') ? `|-\n${s.split('\n').map((l) => ' '.repeat(indent) + l).join('\n')}` : q(s);
  const kv = (obj, indent) => Object.entries(obj).map(([k, v]) => `${' '.repeat(indent)}${k}: ${q(v)}`).join('\n');
  let out = 'groups:\n';
  for (const g of groups) {
    out += `  - name: ${q(g.name)}\n    interval: ${q(g.interval || '30s')}\n    rules:\n`;
    for (const r of g.rules) {
      out += r.record ? `      - record: ${q(r.record)}\n` : `      - alert: ${q(r.alert)}\n`;
      out += `        expr: ${block(r.expr, 10)}\n`;
      if (r.for) out += `        for: ${q(r.for)}\n`;
      if (r.labels) out += `        labels:\n${kv(r.labels, 10)}\n`;
      if (r.annotations) out += `        annotations:\n${kv(r.annotations, 10)}\n`;
    }
  }
  return out;
}

module.exports = { WINDOWS, rulesFor, errorRatio, budgetRemaining, toYaml, validate };
