import { createHash } from "node:crypto";
import { stableStringify } from "./stable";
import type { Judgment } from "./types";

/** Cache key: hash of engine, model, the question's state, and the question itself. */
export function cacheKey(engine: string, model: string, state: unknown, spec: unknown): string {
  return createHash("sha256").update(stableStringify({ engine, model, state, spec })).digest("hex");
}

export class JudgmentCache {
  private map = new Map<string, Judgment>();
  get(key: string): Judgment | undefined {
    return this.map.get(key);
  }
  set(key: string, j: Judgment): void {
    this.map.set(key, j);
  }
  has(key: string): boolean {
    return this.map.has(key);
  }
  clear(): void {
    this.map.clear();
  }
  get size(): number {
    return this.map.size;
  }
}
