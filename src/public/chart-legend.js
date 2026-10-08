/** @typedef {import("./chart-legend.js").LegendItem} LegendItem */
/** @typedef {import("./chart-legend.js").LegendOptions} LegendOptions */
/** @type {WeakMap<HTMLElement, () => void>} */
const cleanups = new WeakMap();

/** @param {string} tag @param {string} className @param {string} [text] */
function element(tag, className, text) {
  const result = document.createElement(tag); result.className = className;
  if (text !== undefined) result.textContent = text;
  return result;
}

/** A shared, text-safe key with reciprocal pointer and keyboard highlighting.
 * @param {HTMLElement} container @param {LegendItem[]} items @param {LegendOptions} options
 */
export function renderLegend(container, items, { target, layout = "wrap" }) {
  cleanups.get(container)?.();
  container.replaceChildren(); container.classList.add("chart-legend");
  container.dataset.layout = layout;
  target.classList.add("chart-target"); target.removeAttribute("data-highlight");
  const marks = [...target.querySelectorAll("[data-series]")];
  for (const mark of marks) mark.removeAttribute("data-series-active");
  /** @type {HTMLElement[]} */
  const buttons = [];
  /** @type {Array<() => void>} */
  const removals = [];
  /** @type {string | null} */
  let hovered = null;
  /** @type {string | null} */
  let focused = null;
  const highlight = () => {
    const id = hovered ?? focused;
    if (id === null) target.removeAttribute("data-highlight");
    else target.setAttribute("data-highlight", id);
    for (const mark of marks) {
      if (mark.getAttribute("data-series") === id) mark.setAttribute("data-series-active", "true");
      else mark.removeAttribute("data-series-active");
    }
    for (const button of buttons) {
      if (button.getAttribute("data-series") === id) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
  };
  /** @param {import("./chart-legend.js").LegendMark} node @param {string} event @param {() => void} listener */
  const listen = (node, event, listener) => {
    node.addEventListener(event, listener);
    removals.push(() => node.removeEventListener(event, listener));
  };
  for (const item of items.filter((item) => item.value !== 0)) {
    const button = document.createElement("button"); button.type = "button"; button.className = "chart-legend-item";
    button.setAttribute("data-series", item.id);
    const value = item.valueLabel ?? (item.value === undefined ? "" : String(item.value));
    const share = item.share === undefined ? "" : typeof item.share === "number" ? `${(item.share * 100).toFixed(1)}%` : item.share;
    button.setAttribute("aria-label", `${item.label}${value ? `: ${value}` : ""}${share ? ` (${share})` : ""}`);
    const swatch = element("i", "chart-legend-swatch"); swatch.setAttribute("aria-hidden", "true");
    swatch.dataset.mark = item.mark; swatch.dataset.pattern = item.pattern || "solid";
    swatch.style.setProperty("--series-color", item.color);
    button.append(swatch);
    if (item.mark === "logo" && item.icon) {
      const icon = element("span", "chart-legend-icon"); icon.setAttribute("aria-hidden", "true"); icon.append(/** @type {Node} */ (item.icon)); button.append(icon);
    }
    button.append(element("span", "chart-legend-label", item.label));
    if (value) button.append(element("strong", "chart-legend-value", value));
    if (share) button.append(element("small", "chart-legend-share", share));
    listen(button, "pointerenter", () => { hovered = item.id; highlight(); });
    listen(button, "pointerleave", () => { hovered = null; highlight(); });
    listen(button, "focus", () => { focused = item.id; highlight(); });
    listen(button, "blur", () => { focused = null; highlight(); });
    buttons.push(button); container.append(button);
  }
  for (const mark of marks) {
    listen(mark, "pointerenter", () => { hovered = mark.getAttribute("data-series"); highlight(); });
    listen(mark, "pointerleave", () => { hovered = null; highlight(); });
  }
  cleanups.set(container, () => { for (const remove of removals) remove(); });
}
