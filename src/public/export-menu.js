import { csv, csvTables } from "./export-data.js";

export function downloadFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function installExportMenu(getSelection) {
  const menu = document.querySelector("#export-menu");
  const status = document.querySelector("#export-status");
  const description = document.querySelector("#export-description");
  const buttons = [...menu.querySelectorAll("[data-export]")];
  let preview = null;
  const reset = () => {
    preview = null; menu.open = false; description.textContent = ""; status.textContent = "";
    for (const button of buttons) button.disabled = true;
  };
  menu.addEventListener("toggle", () => {
    if (!menu.open) {
      preview = null; description.textContent = "";
      for (const button of buttons) button.disabled = true;
      return;
    }
    const selection = getSelection(); preview = selection;
    if (!selection) {
      description.textContent = "The snapshot is still loading.";
      for (const button of buttons) button.disabled = true;
      return;
    }
    const shared = selection.kind === "shared";
    description.textContent = shared
      ? `Shared aggregates only · ${selection.summary.sessions} sessions · minimum ${selection.minimumSessions} per repository. No upload.`
      : `${selection.sessions.length} sessions in the current repository, date, and view filters. Downloads include repository names and session keys. For sharing, use report --share.`;
    for (const button of buttons) {
      button.disabled = shared ? !["json", "shared"].includes(button.dataset.export) : button.dataset.export === "shared";
      button.hidden = !shared && button.dataset.export === "shared";
    }
  });
  for (const button of buttons) button.addEventListener("click", () => {
    // The object described when the menu opened is the download source. App
    // renders invalidate it before any data/filter change can be downloaded.
    const selection = preview;
    if (!menu.open || !selection) return;
    const kind = button.dataset.export;
    if (!(selection.kind === "shared" ? ["json", "shared"] : ["json", "sessions", "daily", "models", "tools"]).includes(kind)) return;
    if (kind === "json") downloadFile(selection.kind === "shared" ? "shared.json" : "snapshot.json", `${JSON.stringify(selection, null, 2)}\n`, "application/json");
    else if (kind === "shared") {
      const columns = ["schemaVersion", "repository", ...Object.keys(selection.summary)];
      downloadFile("shared.csv", csv(selection.repositories.map((row) => ({ schemaVersion: selection.schemaVersion, ...row })), columns), "text/csv;charset=utf-8");
    } else downloadFile(`${kind}.csv`, csvTables(selection)[`${kind}.csv`], "text/csv;charset=utf-8");
    reset(); status.textContent = "Download prepared locally. No data was uploaded.";
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu.open) { reset(); menu.querySelector("summary").focus(); } });
  reset();
  return reset;
}
