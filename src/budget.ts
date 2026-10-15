import { fail, StrataError } from './model.js';

export type BudgetLimits = { operations: number; bytes: number; input_tokens: number; output_tokens: number; attempts: number; duration_ms: number };
export type Charge = Partial<Omit<BudgetLimits, 'duration_ms'>>;
const RESOURCES = ['operations', 'bytes', 'input_tokens', 'output_tokens', 'attempts'] as const;
// Synchronous reservations happen before dispatch. Failed/ambiguous work remains charged;
// this is a deterministic application guard, not a provider billing cap.
export class RunBudget {
  readonly limits: BudgetLimits;
  private readonly started: number;
  private stopped = false;
  private usage = { operations: 0, bytes: 0, input_tokens: 0, output_tokens: 0, attempts: 0 };
  constructor(limits: BudgetLimits, private readonly now: () => number = () => performance.now()) {
    for (const key of [...RESOURCES, 'duration_ms'] as const) if (!Number.isSafeInteger(limits[key]) || limits[key] < 0) fail('INVALID_BUDGET', 2, 'Budget limits must be nonnegative safe integers.');
    this.limits = Object.freeze({ ...limits }); this.started = now();
  }
  check() {
    if (this.stopped) fail('RUN_STOPPED', 7, 'The run has been stopped.');
    if (this.now() - this.started >= this.limits.duration_ms) fail('BUDGET_DEADLINE', 7, 'The run deadline has been reached.');
  }
  reserve(charge: Charge) {
    this.check();
    for (const key of Object.keys(charge)) if (!(RESOURCES as readonly string[]).includes(key)) fail('INVALID_BUDGET', 2, 'Unknown budget resource.');
    const next = { ...this.usage };
    for (const key of RESOURCES) {
      const amount = charge[key] ?? 0;
      if (!Number.isSafeInteger(amount) || amount < 0) fail('INVALID_BUDGET', 2, 'Reservations must be nonnegative safe integers.');
      next[key] += amount;
      if (!Number.isSafeInteger(next[key]) || next[key] > this.limits[key]) fail('BUDGET_EXHAUSTED', 7, `Run budget exhausted: ${key}.`);
    }
    this.usage = next;
  }
  stop() { this.stopped = true; }
  async bounded<T>(operation: () => Promise<T>): Promise<T> {
    const remaining = this.remainingMs(); let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([operation(), new Promise<never>((_, reject) => {
        timer = setTimeout(() => { this.stop(); reject(new StrataError('BUDGET_DEADLINE', 7, 'Run deadline reached; no retry or new work is permitted.')); }, remaining);
      })]);
      this.check(); return result;
    } finally { clearTimeout(timer); }
  }
  remainingMs() { this.check(); return Math.max(1, Math.floor(this.limits.duration_ms - (this.now() - this.started))); }
  snapshot() { return { limits: { ...this.limits }, reserved: { ...this.usage }, stopped: this.stopped, elapsed_ms: Math.max(0, this.now() - this.started), provider_hard_cap: false }; }
}
