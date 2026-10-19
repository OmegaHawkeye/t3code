import { MAX_AUTH_IDLE_PERIOD_DAYS, MIN_AUTH_IDLE_PERIOD_DAYS } from "@t3tools/contracts";

export function parseAuthIdlePeriodDays(value: string): number | null {
  const days = Number(value);
  return Number.isInteger(days) &&
    days >= MIN_AUTH_IDLE_PERIOD_DAYS &&
    days <= MAX_AUTH_IDLE_PERIOD_DAYS
    ? days
    : null;
}
