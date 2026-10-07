import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PANEL_KINDS,
  PANEL_REGISTRY_SCHEMA,
  PANEL_REGISTRY_VERSION,
  PANEL_SPEC_VERSION,
  compatibilityFallback,
  getPanelRegistrySummary,
  isPanelSpecCompatible,
  listPanelDataSources,
  listPanelRenderers,
  normalizePanelSpec,
  registerPanelDataSource,
  registerPanelRenderer,
  validatePanelSpec,
} from './observability-panel-registry.js';

test('panel registry exposes the built-in renderer and data-source capabilities', () => {
  const summary = getPanelRegistrySummary();
  assert.equal(summary.schema, PANEL_REGISTRY_SCHEMA);
  assert.equal(summary.version, PANEL_REGISTRY_VERSION);
  assert.equal(summary.specVersion, PANEL_SPEC_VERSION);
  assert.deepEqual(summary.renderers.map((item) => item.kind), [...PANEL_KINDS]);
  assert.deepEqual(summary.dataSources.map((item) => item.id), ['metrics', 'logs', 'traces', 'events', 'topology']);
  // The public summary is intentionally minimal and must not expose renderer internals.
  assert.equal('features' in summary.renderers[0]!, false);
});

test('normalizePanelSpec fills safe defaults and keeps the versioned contract', () => {
  const spec = normalizePanelSpec({
    version: '1',
    kind: 'timeseries',
    query: { source: 'metrics', metric: 'http.server.duration', groupBy: ['service.name', 'service.name'] },
    transform: [{ type: 'rate', field: 'value' }, { type: '' }, 'bad'],
    viz: { title: 'Latency', thresholds: [{ value: '100', color: 'orange' }] },
    interactions: { zoom: true, crossFilter: true },
    drilldown: [{ label: 'Open traces', target: '/traces', params: { service: 'api' } }],
    refresh: { mode: 'poll', intervalSeconds: 1 },
  });
  assert.equal(spec.version, PANEL_SPEC_VERSION);
  assert.equal(spec.kind, 'line');
  assert.equal(spec.query.dataSource, 'metrics');
  assert.deepEqual(spec.query.groupBy, ['service.name']);
  assert.equal(spec.transform.length, 1);
  assert.equal(spec.viz.thresholds[0]?.value, 100);
  assert.equal(spec.interactions.zoom, true);
  assert.equal(spec.refresh.intervalSeconds, 5);
  assert.equal(validatePanelSpec(spec).ok, true);
  assert.equal(isPanelSpecCompatible(spec), true);
});

test('unknown versions and kinds use a safe stat compatibility fallback', () => {
  const future = normalizePanelSpec({ version: '2.0.0', kind: 'sunburst', query: { metric: 'x' } });
  assert.equal(future.version, PANEL_SPEC_VERSION);
  assert.equal(future.kind, 'stat');
  assert.equal(future.query.metric, 'x');
  assert.equal(isPanelSpecCompatible({ version: '2.0.0', kind: 'stat' }), false);
  assert.deepEqual(compatibilityFallback(null).query, normalizePanelSpec({ kind: 'stat' }).query);
  assert.deepEqual(validatePanelSpec({ version: '2.0.0', kind: 'stat' }), {
    ok: false,
    errors: ['unsupported_panel_spec_version', 'panel_query_required', 'panel_transform_array_required', 'panel_viz_required', 'panel_interactions_required', 'panel_drilldown_array_required', 'panel_refresh_required'],
  });
});

test('custom renderer and source registrations are normalized and included in full listings', () => {
  const renderer = registerPanelRenderer({ id: 'custom-score', kind: 'score', version: '1.2.0', label: 'Score', dataSources: ['metrics'], features: ['drilldown'] });
  const source = registerPanelDataSource({ id: 'warehouse', version: '1.1.0', signals: ['metrics'], protocols: ['sql'], features: ['aggregate'] });
  assert.equal(renderer.id, 'custom-score');
  assert.equal(source.id, 'warehouse');
  assert.ok(listPanelRenderers().some((item) => item.id === 'custom-score'));
  assert.ok(listPanelDataSources().some((item) => item.id === 'warehouse'));
  assert.equal(getPanelRegistrySummary().renderers.some((item) => item.id === 'custom-score'), true);
  assert.equal(getPanelRegistrySummary().dataSources.some((item) => item.id === 'warehouse'), true);
});
