import { Pill } from './Pill';

const toneByValue: Record<string, 'neutral' | 'success' | 'warning' | 'danger' | 'info' | 'paper'> = {
  BUY: 'success',
  PASS: 'neutral',
  AVOID: 'danger',
  BLACKOUT: 'warning',
  OK_FOR_AI: 'info',
  SKIP: 'neutral',
  open: 'info',
  pending_entry: 'warning',
  stopped: 'danger',
  target_hit: 'success',
  time_closed: 'neutral',
  corp_action: 'warning',
  success: 'success',
  partial: 'warning',
  failed: 'danger',
  skipped: 'neutral',
  running: 'info'
};

export function StatusBadge({ value }: { value: string | null | undefined }) {
  const v = value ?? '-';
  return <Pill tone={toneByValue[v] ?? 'neutral'}>{v}</Pill>;
}
