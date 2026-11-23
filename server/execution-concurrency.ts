import { maxExecutionConcurrency } from '../shared/types.js';

export const executionConcurrencySchema = { type: 'integer', minimum: 1, maximum: maxExecutionConcurrency } as const;

export function validExecutionConcurrency(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= maxExecutionConcurrency;
}

export function defaultExecutionConcurrency() {
  const limit = Number(process.env.BRIDGE_EXECUTOR_CONCURRENCY);
  return validExecutionConcurrency(limit) ? limit : 4;
}
