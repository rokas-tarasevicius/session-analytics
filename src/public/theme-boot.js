// Sets the theme and density before the first paint so a dark preference never flashes light. It is a separate
// same-origin classic script, loaded synchronously in <head>, because the Content Security Policy forbids inline
// scripts. app.js applies the same choice again (and owns saving preferences); a URL `?theme=` or `?density=`
// applies to this visit only and is never saved.
(() => {
  const root = document.documentElement;
  const read = (key) => { try { return localStorage.getItem(key); } catch { return null; } };
  const parameters = new URLSearchParams(location.search);
  const urlTheme = parameters.get("theme"), storedTheme = read("session-analytics-theme");
  const systemTheme = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  root.dataset.theme = ["dark", "light"].includes(urlTheme) ? urlTheme : ["dark", "light"].includes(storedTheme) ? storedTheme : systemTheme;
  const urlDensity = parameters.get("density");
  root.dataset.density = ["compact", "comfortable"].includes(urlDensity) ? urlDensity : read("session-analytics-density") === "comfortable" ? "comfortable" : "compact";
})();
