import { summarizeWorkflow } from "./workflow-data.js";

export function workflowWorkerHandler(reply) {
  let sessions = [], inventory, asOf;
  return ({ data }) => {
    if (data.type === "initialize") { sessions = []; inventory = data.inventory; asOf = data.asOf; }
    else if (data.type === "sessions") sessions.push(...data.sessions);
    else if (data.type === "select") {
      try {
        const scopedInventory = { ...inventory, skills: inventory.skills.filter((s) => data.provider === "all" || s.provider === data.provider) };
        const result = summarizeWorkflow(data.indices.map((index) => sessions[index]), scopedInventory, asOf, data.repositoryIds);
        reply({ id: data.id, result });
      } catch { reply({ id: data.id, error: true }); }
    }
  };
}

if (typeof self !== "undefined") self.onmessage = workflowWorkerHandler((result) => self.postMessage(result));
