import { execFileSync } from "node:child_process";

export type KeySource = "env" | "keychain" | "none";

/**
 * Load the TypeSafe key once at startup and keep it in memory only. Never log the value.
 * Order: process.env.TYPESAFE_API_KEY (dotenv loads .env first), then on macOS the
 * Keychain generic password with service TYPESAFE_API_KEY.
 */
export function loadKey(): { key: string | undefined; source: KeySource } {
  const fromEnv = process.env.TYPESAFE_API_KEY?.trim();
  if (fromEnv) return { key: fromEnv, source: "env" };
  if (process.platform === "darwin" && process.env.REFLEX_NO_KEYCHAIN !== "1") {
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", "TYPESAFE_API_KEY", "-w"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      }).trim();
      if (out) return { key: out, source: "keychain" };
    } catch {
      // Not found or access denied. Fall through without logging anything about the value.
    }
  }
  return { key: undefined, source: "none" };
}
