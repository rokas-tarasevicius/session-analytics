import type { MachineAnalytics, SharedSnapshot } from "../types.ts";
export function downloadFile(filename: string, text: string, type: string): void;
export function installExportMenu(getSelection: () => MachineAnalytics | SharedSnapshot | null): () => void;
