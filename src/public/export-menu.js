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
  menu.addEventListener("toggle", () => {
    const selection = getSelection();
    if (!selection) {
      document.querySelector("#export-description").textContent = "The snapshot is still loading.";
      for (const button of menu.querySelectorAll("[data-export]")) button.disabled = true;
      return;
    }
    const shared = selection.kind === "shared";
    document.querySelector("#export-description").textContent = shared
      ? `Shared aggregates only · ${selection.summary.sessions} sessions · minimum ${selection.minimumSessions} per repository. No upload.`
      : `${selection.sessions.length} sessions in the current repository, date, and view filters. Downloads include repository names and session keys. For sharing, use report --share.`;
    for (const button of menu.querySelectorAll("[data-export]")) {
      button.disabled = shared && !["json", "shared"].includes(button.dataset.export);
      button.hidden = !shared && button.dataset.export === "shared";
    }
  });
  for (const button of menu.querySelectorAll("[data-export]")) button.addEventListener("click", () => {
    const selection = getSelection();
    if (!selection) return;
    const kind = button.dataset.export;
    if (kind === "json") downloadFile(selection.kind === "shared" ? "shared.json" : "snapshot.json", `${JSON.stringify(selection, null, 2)}\n`, "application/json");
    else if (kind === "shared") {
      const columns = ["schemaVersion", "repository", ...Object.keys(selection.summary)];
      downloadFile("shared.csv", csv(selection.repositories.map((row) => ({ schemaVersion: selection.schemaVersion, ...row })), columns), "text/csv;charset=utf-8");
    } else downloadFile(`${kind}.csv`, csvTables(selection)[`${kind}.csv`], "text/csv;charset=utf-8");
    status.textContent = "Download prepared locally. No data was uploaded.";
    menu.open = false;
  });
  document.addEventListener("keydown", (event) => { if (event.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); } });
}
