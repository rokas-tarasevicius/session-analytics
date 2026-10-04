import { once } from "node:events";
import type { Writable } from "node:stream";
import type { MachineAnalytics } from "./types.ts";

/** Keep the serialized snapshot out of the capped worker's heap; respect pipe backpressure. */
export async function writeAnalysisSnapshot(snapshot: MachineAnalytics, output: Writable): Promise<void> {
  const write = async (chunk: string) => { if (!output.write(chunk)) await once(output, "drain"); };
  const object = async (record: object): Promise<void> => {
    await write("{");
    let separator = "";
    for (const [key, value] of Object.entries(record)) {
      if (value === undefined) continue;
      await write(`${separator}${JSON.stringify(key)}:`);
      separator = ",";
      if (Array.isArray(value)) {
        await write("[");
        for (let i = 0; i < value.length; i++) {
          if (i) await write(",");
          await write(JSON.stringify(value[i]) ?? "null");
        }
        await write("]");
      } else if (value && typeof value === "object") {
        // Aggregate namespaces (notably workflow timelines) can also contain large arrays.
        await object(value);
      } else await write(JSON.stringify(value));
    }
    await write("}");
  };
  await object(snapshot);
}
