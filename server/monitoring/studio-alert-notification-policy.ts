import type { AlertConfig } from './alert-config.js';
import { deliverTransition } from './studio-alert-delivery.js';
import type { AlertTransition, AlertWorkerState } from './studio-alert-state.js';

const SYNTHETIC_NOTIFICATION_ORDER = [
  'synthetic-login',
  'synthetic-ai-chat',
  'synthetic-tool-call',
] as const;

function isSyntheticKey(key: string): key is (typeof SYNTHETIC_NOTIFICATION_ORDER)[number] {
  return SYNTHETIC_NOTIFICATION_ORDER.includes(
    key as (typeof SYNTHETIC_NOTIFICATION_ORDER)[number],
  );
}

/** Collapse sibling synthetic failures into one externally visible page. */
export function shouldCoalesceSyntheticTransition(
  transition: AlertTransition,
  transitions: readonly AlertTransition[],
): boolean {
  if (!isSyntheticKey(transition.key)) return false;
  const sameKind = transitions.filter(
    (candidate) => candidate.kind === transition.kind && isSyntheticKey(candidate.key),
  );
  if (sameKind.length < 2) return false;
  const root = SYNTHETIC_NOTIFICATION_ORDER.find((key) =>
    sameKind.some((candidate) => candidate.key === key),
  );
  return root !== transition.key;
}

type TransitionDelivery = Awaited<ReturnType<typeof deliverTransition>>;

function suppressed(error: string): TransitionDelivery {
  return { delivered: false, channel: 'suppressed', attempts: 0, error };
}

/** Deliver one transition and update its durable notification/cooldown state. */
export async function deliverAndRecordTransition(
  state: AlertWorkerState,
  transition: AlertTransition,
  transitions: readonly AlertTransition[],
  config: AlertConfig,
): Promise<TransitionDelivery> {
  const history = (state.notificationHistory ??= []);
  const coalesced = shouldCoalesceSyntheticTransition(transition, transitions);
  const delivery = coalesced
    ? suppressed('related_synthetic_alert_coalesced')
    : history.length >= config.global.maxNotificationsPerHour
      ? suppressed('hourly_notification_budget_exhausted')
      : await deliverTransition(transition, config);
  const keyState = state.keys[transition.key];
  if (keyState) {
    keyState.lastAttemptAt = transition.at;
    if (delivery.delivered || coalesced) {
      keyState.notified = transition.kind !== 'resolved';
      if (delivery.delivered) {
        keyState.lastNotifiedAt = transition.at;
        history.push(transition.at);
      } else if (transition.kind !== 'resolved') {
        keyState.lastNotifiedAt = transition.at;
      }
    }
  }
  return delivery;
}
