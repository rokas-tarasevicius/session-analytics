const views = {
  summary: [
    "All your agents. All your repositories. One place to understand the work.",
    "Summary dashboard showing usage value, sessions, and token totals from synthetic demo data",
  ],
  velocity: [
    "See how usage changes over time, grouped by model or provider.",
    "Velocity dashboard showing model usage over time with synthetic demo data",
  ],
  costs: [
    "Inspect the API-equivalent value of your usage and its pricing coverage.",
    "Costs dashboard showing API-equivalent usage value and coverage with synthetic demo data",
  ],
  tools: [
    "Understand the tools your agents reach for, across sessions and repositories.",
    "Tools dashboard showing tool-call patterns with synthetic demo data",
  ],
};
const commands = {
  npm: [
    "npm install -g session-analytics\nsession-analytics",
    "Opens your dashboard at http://127.0.0.1:4174.",
    "INSTALL & LAUNCH",
  ],
  homebrew: [
    "brew install rokas-tarasevicius/tap/session-analytics\nsession-analytics",
    "Homebrew installs the same compiled package as the GitHub Release.",
    "INSTALL & LAUNCH",
  ],
  source: [
    "git clone https://github.com/rokas-tarasevicius/session-analytics.git\ncd session-analytics\nnpm run demo",
    "Try synthetic history only. No install step and no access to your sessions.",
    "CLONE & TRY THE DEMO",
  ],
};

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

setupTabs(".preview-tabs", (tab) => {
  const view = tab.dataset.view;
  const img = document.getElementById("dashboard-image");
  const mobileView = view === "summary" ? "mobile" : view;
  for (const [id, asset] of [
    ["preview-mobile-dark", `${mobileView}-dark`],
    ["preview-mobile", mobileView],
    ["preview-dark", `${view}-dark`],
  ]) {
    const source = document.getElementById(id);
    source.srcset = `./assets/screenshot-${asset}.webp`;
    source.width = view === "summary" && id !== "preview-dark" ? 750 : 1718;
    source.height = view === "summary" && id !== "preview-dark" ? 1624 : 1472;
  }
  img.src = `./assets/screenshot-${view}.webp`;
  img.alt = views[view][1];
  const panel = document.getElementById("dashboard-panel");
  panel.dataset.view = view;
  panel.scrollTo(0, 0);
  document.getElementById("view-caption").textContent = views[view][0];
});

const dashboardImage = document.getElementById("dashboard-image");
if (dashboardImage) {
  const updatePreviewLink = () => {
    document.getElementById("full-preview").href =
      dashboardImage.currentSrc || dashboardImage.src;
  };
  dashboardImage.addEventListener("load", updatePreviewLink);
  updatePreviewLink();
}

let commandRevision = 0;
setupTabs(".install-tabs", (tab) => {
  commandRevision++;
  const [command, note, label] = commands[tab.dataset.install];
  document.getElementById("install-command").textContent = command;
  document.getElementById("install-note").textContent = note;
  document.getElementById("install-label").textContent = label;
  document.getElementById("copy-status").textContent = "";
});

const copy = document.getElementById("copy-command");
if (copy) {
  copy.hidden = false;
  copy.addEventListener("click", async () => {
    const code = document.getElementById("install-command");
    const revision = commandRevision;
    try {
      await navigator.clipboard.writeText(code.textContent);
      if (revision === commandRevision)
        document.getElementById("copy-status").textContent = "Commands copied.";
    } catch {
      if (revision !== commandRevision) return;
      const range = document.createRange();
      range.selectNodeContents(code);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      document.getElementById("copy-status").textContent =
        "Commands selected. Press Ctrl+C or ⌘C to copy.";
    }
  });
}
