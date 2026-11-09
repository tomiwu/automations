import type { ModelSpec } from "./config.ts";

export const LIMIT_ERROR = /credit|quota|usage limit|rate limit|payment|out of (fast )?requests|insufficient/i;

export function isLimitError(text: string): boolean {
  return LIMIT_ERROR.test(text);
}

// Tracks which model of the ordered list is active. A limit error moves to the next model.
export class ModelOrder {
  private index = 0;

  constructor(private readonly models: ModelSpec[]) {}

  current(): ModelSpec {
    return this.models[this.index] as ModelSpec;
  }

  // Returns the next model, or undefined when the list has no more models.
  advance(): ModelSpec | undefined {
    if (this.index + 1 >= this.models.length) return undefined;
    this.index += 1;
    return this.current();
  }
}

// Run `attempt` with the active model. On a limit error, change to the next model and run again.
export async function withFallback<T>(
  order: ModelOrder,
  attempt: (model: ModelSpec) => Promise<T>,
  log: (message: string) => void = () => {},
): Promise<T> {
  for (;;) {
    try {
      return await attempt(order.current());
    } catch (error) {
      const text = `${error}`;
      const failed = order.current();
      if (!isLimitError(text) || !order.advance()) throw error;
      log(`${failed.provider}:${failed.model} failed (${text.slice(0, 200)}). Change to ${order.current().provider}:${order.current().model}.`);
    }
  }
}
