import type { ChildProcess } from "node:child_process";

/** Every child that outlives a request (ssh, analysis workers), so a signal or deadline can stop them all. */
const live = new Set<ChildProcess>();

export function track<T extends ChildProcess>(child: T): T {
  live.add(child);
  child.once("exit", () => live.delete(child));
  child.once("error", () => live.delete(child));
  return child;
}

/** SIGTERM every tracked child, including any started meanwhile, then SIGKILL the ones still running after the grace period. */
export async function stopChildren(graceMs = 2_000): Promise<void> {
  const signalled = new Set<ChildProcess>(), running = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;
  const deadline = Date.now() + graceMs;
  for (;;) {
    for (const child of live) if (!signalled.has(child)) { signalled.add(child); child.kill("SIGTERM"); }
    if (![...live].some(running) || Date.now() >= deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  for (const child of new Set([...signalled, ...live])) if (running(child)) child.kill("SIGKILL");
}

const signalNumbers = { SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const;
let signalled = false, installed = false;

/** True once a signal is stopping this process: failures it causes are not news, and its handler sets the exit code. */
export function stopping(): boolean {
  return signalled;
}

/**
 * Stop children before exiting on SIGINT, SIGTERM or SIGHUP, so no ssh or worker is orphaned.
 * A second signal kills them at once. `exitCode` defaults to 128 + the signal number. Installed once per process.
 */
export function stopOnSignals(close: () => void = () => {}, exitCode?: number): void {
  if (installed) return;
  installed = true;
  for (const signal of Object.keys(signalNumbers) as Array<keyof typeof signalNumbers>) {
    process.on(signal, () => {
      const code = exitCode ?? 128 + signalNumbers[signal];
      if (signalled) {
        for (const child of live) child.kill("SIGKILL");
        process.exit(code);
      }
      signalled = true;
      try { close(); } catch { /* Exiting regardless. */ }
      void stopChildren().finally(() => process.exit(code));
    });
  }
}
