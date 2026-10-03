import { parentPort } from "node:worker_threads";
import { workflowWorkerHandler } from "../src/public/workflow-worker.js";
const handle = workflowWorkerHandler((data) => parentPort.postMessage(data));
parentPort.on("message", (data) => handle({ data }));
