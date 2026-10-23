const themeKey = "session-analytics-site-theme";
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const commands = {
  npm: [
    "npm install -g session-analytics\nsession-analytics",
    "Opens your dashboard at http://127.0.0.1:4174.",
    "Install and launch",
  ],
  homebrew: [
    "brew install rokas-tarasevicius/tap/session-analytics\nsession-analytics",
    "Homebrew installs the same compiled package as the GitHub Release.",
    "Install and launch",
  ],
  source: [
    "git clone https://github.com/rokas-tarasevicius/session-analytics.git\ncd session-analytics\nnpm run demo",
    "Synthetic history only. No install step and no access to your sessions.",
    "Clone and try the demo",
  ],
};

// Screenshots switch with prefers-color-scheme; a pinned theme rewrites each dark <source>,
// keeping any width condition (data-media) such as the phone hero.
function applyTheme() {
  const pinned = document.documentElement.dataset.theme;
  const dark = pinned ? pinned === "dark" : systemDark.matches;
  for (const source of document.querySelectorAll("source[data-dark]")) {
    const width = source.dataset.media;
    source.media = pinned
      ? dark
        ? width || "all"
        : "not all"
      : [width, "(prefers-color-scheme: dark)"].filter(Boolean).join(" and ");
  }
  for (const meta of themeColors)
    meta.content = pinned ? (dark ? "#141413" : "#fbfbfa") : meta.dataset.content;
  themeSwitch.dataset.dark = String(dark);
  themeSwitch.setAttribute("aria-label", dark ? "Use light theme" : "Use dark theme");
}
const themeSwitch = document.getElementById("theme-switch");
const themeColors = document.querySelectorAll('meta[name="theme-color"]');
for (const meta of themeColors) meta.dataset.content = meta.content;
// Without light-dark() the stylesheet only has the light theme, so there is nothing to switch.
themeSwitch.hidden = !CSS.supports("color", "light-dark(#000, #fff)");
themeSwitch.addEventListener("click", () => {
  const next = themeSwitch.dataset.dark === "true" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try {
    localStorage.setItem(themeKey, next);
  } catch {}
  applyTheme();
});
systemDark.addEventListener("change", applyTheme);
applyTheme();

function setupTabs(selector, activate) {
  const list = document.querySelector(selector);
  if (!list) return;
  list.hidden = false;
  const tabs = [...list.querySelectorAll('[role="tab"]')];
  function select(tab) {
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    document
      .getElementById(tab.getAttribute("aria-controls"))
      .setAttribute("aria-labelledby", tab.id);
    activate(tab);
  }
  for (const tab of tabs) {
    tab.addEventListener("click", () => select(tab));
    tab.addEventListener("keydown", (event) => {
      const index = tabs.indexOf(tab);
      const next = {
        ArrowRight: (index + 1) % tabs.length,
        ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        Home: 0,
        End: tabs.length - 1,
      }[event.key];
      if (next === undefined) return;
      event.preventDefault();
      tabs[next].focus();
      select(tabs[next]);
    });
  }
}

let commandRevision = 0;
const status = document.getElementById("copy-status");
setupTabs(".install-tabs", (tab) => {
  commandRevision++;
  const [command, note, label] = commands[tab.dataset.install];
  document.getElementById("install-command").textContent = command;
  document.getElementById("install-note").textContent = note;
  document.getElementById("install-label").textContent = label;
  if (status) status.textContent = "";
});

for (const button of document.querySelectorAll("[data-copy]")) {
  button.hidden = false;
  button.addEventListener("click", async () => {
    const code = document.getElementById(button.dataset.copy);
    const revision = commandRevision;
    try {
      await navigator.clipboard.writeText(code.textContent);
      if (revision !== commandRevision) return;
      button.textContent = "Copied";
      setTimeout(() => (button.textContent = "Copy"), 1400);
      if (button.closest("#install-panel") && status)
        status.textContent = "Commands copied.";
    } catch {
      if (revision !== commandRevision) return;
      const range = document.createRange();
      range.selectNodeContents(code);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      if (button.closest("#install-panel") && status)
        status.textContent = "Commands selected. Press Ctrl+C or ⌘C to copy.";
      else {
        button.textContent = "Selected";
        setTimeout(() => (button.textContent = "Copy"), 2400);
      }
    }
  });
}
