export type DeviceConnectionHistoryEvent =
  | 'connected'
  | 'reconnected'
  | 'disconnected'
  | 'removed'
  | 'failed';

/** A redacted, user-visible record of a device connection lifecycle event. */
export interface DeviceConnectionHistoryEntry {
  id: string;
  event: DeviceConnectionHistoryEvent;
  occurredAt: string;
  deviceId?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  detail?: string;
}
