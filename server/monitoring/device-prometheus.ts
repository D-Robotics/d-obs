import {
  listDeviceMetricSnapshots,
  type DeviceMetricSnapshot,
} from './device-registry.js';

function escapeLabel(value: unknown): string {
  return String(value ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
}

function labels(values: Array<[string, unknown]>): string {
  return `{${values.map(([key, value]) => `${key}="${escapeLabel(value)}"`).join(',')}}`;
}

function metricName(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_:]/g, '_').replace(/^[^a-zA-Z_:]+/, '').slice(0, 80);
  return normalized || 'unknown';
}

function number(value: unknown): string {
  return Number.isFinite(Number(value)) ? String(Number(value)) : '0';
}

function renderSnapshot(snapshot: DeviceMetricSnapshot, nowMs: number): string[] {
  const device = snapshot.device;
  const deviceLabels = [
    ['device', device.deviceId],
    ['model', device.model],
    ['firmware', device.firmware],
    ['status', device.status],
  ] as Array<[string, unknown]>;
  const lines = [
    `rdk_edge_device_info${labels(deviceLabels)} 1`,
    `rdk_edge_device_online${labels([['device', device.deviceId]])} ${device.online ? 1 : 0}`,
  ];
  if (device.lastSeenAt) {
    const lastSeenMs = Date.parse(device.lastSeenAt);
    if (Number.isFinite(lastSeenMs)) {
      lines.push(`rdk_edge_device_last_seen_timestamp_seconds${labels([['device', device.deviceId]])} ${number(lastSeenMs / 1000)}`);
    }
  }
  if (snapshot.sampleTs !== null) {
    lines.push(`rdk_edge_device_sample_timestamp_seconds${labels([['device', device.deviceId]])} ${number(snapshot.sampleTs / 1000)}`);
    lines.push(`rdk_edge_device_sample_age_seconds${labels([['device', device.deviceId]])} ${number(Math.max(0, nowMs - snapshot.sampleTs) / 1000)}`);
  }
  for (const [key, value] of Object.entries(snapshot.metrics).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`rdk_edge_device_metric${labels([['device', device.deviceId], ['metric', metricName(key)]])} ${number(value)}`);
  }
  return lines;
}

/** Prometheus exposition for the端侧域；历史仍保留在 PostgreSQL 的设备样本表。 */
export async function renderDevicePrometheusMetrics(): Promise<string> {
  const snapshots = await listDeviceMetricSnapshots();
  const nowMs = Date.now();
  const online = snapshots.filter((snapshot) => snapshot.device.online).length;
  const lines = [
    '# d-obs edge device metrics',
    '# HELP rdk_edge_devices_total Registered edge devices.',
    '# TYPE rdk_edge_devices_total gauge',
    `rdk_edge_devices_total ${snapshots.length}`,
    '# HELP rdk_edge_devices_online_total Edge devices with a heartbeat inside the offline window.',
    '# TYPE rdk_edge_devices_online_total gauge',
    `rdk_edge_devices_online_total ${online}`,
    '# HELP rdk_edge_device_info Registered edge device identity and lifecycle state.',
    '# TYPE rdk_edge_device_info gauge',
    '# HELP rdk_edge_device_online Whether the edge device is inside the heartbeat window.',
    '# TYPE rdk_edge_device_online gauge',
    '# HELP rdk_edge_device_last_seen_timestamp_seconds Last heartbeat received from the edge device.',
    '# TYPE rdk_edge_device_last_seen_timestamp_seconds gauge',
    '# HELP rdk_edge_device_sample_timestamp_seconds Timestamp of the latest edge metric sample.',
    '# TYPE rdk_edge_device_sample_timestamp_seconds gauge',
    '# HELP rdk_edge_device_sample_age_seconds Age of the latest edge metric sample.',
    '# TYPE rdk_edge_device_sample_age_seconds gauge',
    '# HELP rdk_edge_device_metric Latest numeric metric reported by an edge device.',
    '# TYPE rdk_edge_device_metric gauge',
  ];
  for (const snapshot of snapshots) lines.push(...renderSnapshot(snapshot, nowMs));
  return `${lines.join('\n')}\n`;
}
