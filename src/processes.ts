import type { ChildProcess } from "node:child_process";

/** Every child that outlives a request (ssh, analysis workers), so a signal or deadline can stop them all. */
const live = new Set<ChildProcess>();

export function track<T extends ChildProcess>(child: T): T {
  live.add(child);
  child.once("exit", () => live.delete(child));
  child.once("error", () => live.delete(child));
  return child;
}

/** SIGTERM every tracked child, then SIGKILL the ones still running after the grace period. */
export async function stopChildren(graceMs = 2_000): Promise<void> {
  const children = [...live];
  for (const child of children) child.kill("SIGTERM");
  const deadline = Date.now() + graceMs;
  while (children.some((child) => child.exitCode === null && child.signalCode === null) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
}

const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;

/**
 * Stop children before exiting on SIGINT, SIGTERM or SIGHUP, so no ssh or worker is orphaned.
 * A second signal kills them at once. `exitCode` defaults to 128 + the signal number.
 */
export function stopOnSignals(close: () => void = () => {}, exitCode?: number): void {
  let stopping = false;
  for (const signal of Object.keys(signalNumbers) as Array<keyof typeof signalNumbers>) {
    process.on(signal, () => {
      const code = exitCode ?? 128 + signalNumbers[signal];
      if (stopping) {
        for (const child of live) child.kill("SIGKILL");
        process.exit(code);
      }
      stopping = true;
      try { close(); } catch { /* Exiting regardless. */ }
      void stopChildren().finally(() => process.exit(code));
    });
  }
}
