import { type ChildProcess } from "node:child_process";

/** Reap the profile owner before teardown removes files it may still be writing. */
export async function stopBrowserProcess(
  child: ChildProcess | null,
  requestShutdown?: () => Promise<unknown>,
  { graceMs = 3_000, killMs = 3_000 }: { graceMs?: number; killMs?: number } = {},
): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  let closed = false;
  let complete!: () => void;
  const completion = new Promise<void>((resolve) => { complete = resolve; });
  const onClose = () => { closed = true; complete(); };
  child.once("close", onClose);
  const wait = async (milliseconds: number): Promise<boolean> => {
    if (closed) return true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        completion.then(() => true),
        new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), milliseconds); }),
      ]);
    } finally { clearTimeout(timer); }
  };
  try {
    if (requestShutdown) {
      // CDP Browser.close coordinates Chrome's subprocesses. A broken connection
      // falls back to signals; neither a rejected request nor its timeout proves exit.
      void Promise.resolve().then(requestShutdown).catch(() => {});
      if (await wait(graceMs)) return;
    }
    child.kill("SIGTERM");
    if (await wait(graceMs)) return;
    child.kill("SIGKILL");
    if (!await wait(killMs)) throw new Error(`Child process ${child.pid ?? "unknown"} did not close after SIGKILL; refusing profile cleanup.`);
  } finally { child.off("close", onClose); }
}
