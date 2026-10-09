import { csv, csvTables } from "./export-data.js";

export function downloadFile(filename, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const link = document.createElement("a");
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let openMenu = () => {};

/** Opens the export menu and moves focus to its first available download (the command palette's Export entry). */
export function openExportMenu() { openMenu(); }

/**
 * Wires the export menu. `getSelection` returns the snapshot to export, or null when none is available;
 * `unavailableMessage` explains a null selection (still loading, or no snapshot because the analysis failed).
 */
export function installExportMenu(getSelection, { unavailableMessage = () => "The snapshot is still loading." } = {}) {
  const menu = document.querySelector("#export-menu");
  const status = document.querySelector("#export-status");
  const description = document.querySelector("#export-description");
  const summary = menu.querySelector("summary");
  const buttons = [...menu.querySelectorAll("[data-export]")];
  let preview = null;
  let focusFirst = false;
  const reset = () => {
    preview = null; menu.open = false; description.textContent = ""; status.textContent = "";
    for (const button of buttons) button.disabled = true;
  };
  const close = ({ restoreFocus = false } = {}) => {
    if (!menu.open) return;
    reset();
    if (restoreFocus) summary.focus();
  };
  openMenu = () => {
    if (menu.open) { buttons.find((button) => !button.disabled && !button.hidden)?.focus(); return; }
    focusFirst = true; menu.open = true;
  };
  menu.addEventListener("toggle", () => {
    if (!menu.open) {
      preview = null; description.textContent = ""; focusFirst = false;
      for (const button of buttons) button.disabled = true;
      return;
    }
    const selection = getSelection(); preview = selection;
    if (!selection) {
      description.textContent = unavailableMessage();
      for (const button of buttons) button.disabled = true;
      if (focusFirst) summary.focus();
      focusFirst = false;
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
    if (focusFirst) (buttons.find((button) => !button.disabled && !button.hidden) ?? summary).focus();
    focusFirst = false;
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
  // Escape closes the menu and stops there: the capture phase runs before the dashboard's own Escape shortcut
  // (clear repository focus), which skips events that are already handled.
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !menu.open) return;
    event.preventDefault();
    close({ restoreFocus: true });
  }, true);
  // A press anywhere outside closes it, as does moving keyboard focus to another control.
  document.addEventListener("pointerdown", (event) => {
    if (menu.open && !menu.contains(event.target)) close();
  }, true);
  menu.addEventListener("focusout", (event) => {
    const next = event.relatedTarget;
    if (menu.open && next && !menu.contains(next)) close();
  });
  reset();
  return reset;
}
