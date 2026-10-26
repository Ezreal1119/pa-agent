import { compactVisualResolutions } from "./visual-review.js";
import { hash, type Job, type Item, type Plan } from "./core.js";
export type ChangeHeader = {
  path: string;
  action: string;
  lazy: true;
  revision: string;
};
/** Small derived views only; canonical reports and publication plans remain unchanged. */
export class ReportViews {
  private plans = new WeakMap<Plan, ChangeHeader[]>();
  private headers = new Map<string, ChangeHeader[]>();
  private coverage = new Map<string, number>();
  record(item: Item) {
    if (item.coverage) this.coverage.set(item.id, item.coverage.length);
    if (!item.plan?.changes.length) return;
    let headers = this.plans.get(item.plan);
    if (!headers) {
      headers = item.plan.changes.map((c) => ({
        path: c.path,
        action:
          c.before === null ? "Add" : c.after === null ? "Remove" : "Update",
        lazy: true as const,
        revision: hash(
          c.path +
            "\0" +
            (c.before === null ? "null" : hash(c.before)) +
            "\0" +
            (c.after === null ? "null" : hash(c.after)),
        ),
      }));
      this.plans.set(item.plan, headers);
    }
    this.headers.set(item.id, headers);
  }
  job(job: Job, running = false) {
    return {
      ...job,
      status: running ? "running" : job.status,
      items: job.items.map((item) => {
        this.record(item);
        const { wecom, coverage, plan, visualResolutions, attempts, ...rest } = item;
        return {
          ...rest,
          ...(visualResolutions ? { visualResolutions: compactVisualResolutions(visualResolutions) } : {}),
          ...(attempts ? { attempts: attempts.map(a => ({ ...a, visualResolutions: compactVisualResolutions(a.visualResolutions) })) } : {}),
          coverageCount: this.coverage.get(item.id) ?? 0,
          ...(plan
            ? { plan: { ...plan, changes: this.headers.get(item.id) ?? [] } }
            : {}),
        };
      }),
    };
  }
  revision(item: Item, index: number) {
    this.record(item);
    return this.headers.get(item.id)?.[index]?.revision;
  }
}
