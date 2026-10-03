// The full snapshot already contains its aggregate. Filtered scopes run in a
// module worker, with a bounded cache tied to this exact snapshot object.
export function createWorkflowScope({ workerFactory = () => new Worker(new URL("./workflow-worker.js", import.meta.url), { type: "module" }), yieldTask = () => new Promise((resolve) => setTimeout(resolve, 0)), batchSize = 128, cacheLimit = 8 } = {}) {
  let current = null, worker = null, ready = null, indices = null, cache = new Map(), nextId = 0, revision = 0;
  const pending = new Map();
  const failure = () => new Error("Workflow calculation unavailable.");
  function stop() {
    revision += 1;
    worker?.terminate(); worker = null; ready = null;
    for (const request of pending.values()) request.reject(failure());
    pending.clear(); cache.clear();
  }
  function initialize(snapshot) {
    if (ready) return ready;
    const epoch = revision;
    // Let the pending state paint before creating/cloning worker input.
    ready = (async () => {
      await yieldTask();
      if (revision !== epoch) throw failure();
      const instance = workerFactory(); worker = instance;
      instance.onmessage = ({ data }) => {
        const request = pending.get(data.id);
        if (!request) return;
        pending.delete(data.id);
        if (data.error) request.reject(failure()); else request.resolve(data.result);
      };
      instance.onerror = () => { if (worker === instance) stop(); };
      instance.postMessage({ type: "initialize", inventory: { ...snapshot.workflow?.inventory, skills: snapshot.workflow?.installedSkills || [] }, asOf: snapshot.generatedAt });
      // Bound each structured-clone task so changing filters remains responsive
      // even for thousands of sessions. Only public workflow inputs are sent.
      for (let start = 0; start < snapshot.sessions.length; start += batchSize) {
        if (revision !== epoch || worker !== instance) throw failure();
        const sessions = snapshot.sessions.slice(start, start + batchSize).map((s) => ({
          provider: s.provider, repositoryId: s.repositoryId, createdAt: s.createdAt, skills: s.skills,
          transcript: { status: s.transcript.status, snapshotWhileWorking: s.transcript.snapshotWhileWorking }, workflow: s.workflow,
        }));
        instance.postMessage({ type: "sessions", sessions });
        await yieldTask();
      }
      return instance;
    })();
    return ready;
  }
  function get(snapshot, sessions, repositoryIds, provider = "all") {
    if (snapshot !== current) {
      stop(); current = snapshot;
      indices = new Map(snapshot.sessions.map((s, index) => [s, index]));
    }
    const epoch = revision;
    const selected = sessions.filter((s) => provider === "all" || s.provider === provider);
    const selection = selected.map((s) => indices.get(s)).sort((a, b) => a - b);
    const repositories = [...new Set(repositoryIds)].sort();
    const fullRepositories = snapshot.repositories.map((r) => r.repository.id).sort();
    if (provider === "all" && snapshot.workflow && selection.length === snapshot.sessions.length && selection.every((n, i) => n === i) &&
      repositories.length === fullRepositories.length && repositories.every((id, i) => id === fullRepositories[i])) return snapshot.workflow;
    if (selection.some((index) => index === undefined)) return Promise.reject(failure());
    const key = JSON.stringify([provider, repositories, selection]);
    if (cache.has(key)) { const value = cache.get(key); cache.delete(key); cache.set(key, value); return value; }
    const result = initialize(snapshot).then((instance) => {
      if (revision !== epoch || worker !== instance) throw failure();
      return new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject });
        try { instance.postMessage({ type: "select", id, indices: selection, repositoryIds: repositories, provider }); }
        catch { pending.delete(id); reject(failure()); }
      });
    });
    cache.set(key, result);
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value);
    result.then((value) => { if (revision === epoch && cache.get(key) === result) cache.set(key, value); }, () => {
      if (revision === epoch && cache.get(key) === result) cache.delete(key);
      if (revision === epoch && !worker) ready = null;
    });
    return result;
  }
  return { get, dispose: () => { stop(); current = null; indices = null; } };
}
