// Shared dashboard components: filter bar, KPI card, table, evidence disclosure and coverage badge.
// DOM-only helpers; no analytics semantics live here.
// Harness note: only append/replaceChildren/textContent/setAttribute/dataset/classList are used so the
// dependency-free DOM stubs in test/ can execute every renderer.

export const DASH = "—";

/** Adds a class by rewriting className (some test DOM stubs do not model the class list API). */
export function addClass(element, name) {
  element.className = element.className ? `${element.className} ${name}` : name;
  return element;
}

export function el(tag, text, className) {
  const element = document.createElement(tag);
  if (text !== undefined && text !== null) element.textContent = text;
  if (className) element.className = className;
  return element;
}

export const note = (text, className = "chart-note") => el("p", text, className);

/** "87/116" badge with the full sentence for screen readers and in the tooltip; null when every selected session is covered. */
export function coverageBadge(coverage, what = "evidence") {
  if (!coverage || !coverage.selected || coverage.eligible >= coverage.selected) return null;
  const badge = el("small", null, "coverage");
  const description = `${coverage.eligible} of ${coverage.selected} selected sessions provide ${what}`;
  badge.setAttribute("title", description);
  const fraction = el("span", `${coverage.eligible}/${coverage.selected}`); fraction.setAttribute("aria-hidden", "true");
  badge.append(fraction, el("span", description, "sr-only"));
  return badge;
}

/** Writes a value into `target`: the number alone, or an em dash with the reason as its tooltip. */
export function setValue(target, value, coverage, format, { what = "evidence", reason = null, slot = null } = {}) {
  const eligible = !coverage || coverage.eligible > 0;
  target.textContent = eligible ? format(value) : DASH;
  const unavailable = reason ?? (coverage ? `Not available: 0 of ${coverage.selected} selected sessions provide ${what}` : null);
  if (eligible) { target.removeAttribute?.("title"); target.removeAttribute?.("aria-label"); }
  else { target.title = unavailable; target.setAttribute("aria-label", unavailable); }
  if (slot) {
    slot.replaceChildren();
    if (!eligible) { const selected = coverage?.selected ?? 0; slot.textContent = `No ${what} in ${selected} selected ${selected === 1 ? "session" : "sessions"}`; slot.className = "kpi-coverage kpi-reason"; }
    else { slot.className = "kpi-coverage"; const badge = coverageBadge(coverage, what); if (badge) slot.append(badge); }
  }
  return eligible;
}

/** A value plus its coverage badge in one inline element (bar rows, table cells, model rows). */
export function valueWithCoverage(value, coverage, format, what = "evidence", tag = "strong") {
  const holder = el(tag);
  const eligible = !coverage || coverage.eligible > 0;
  holder.append(el("span", eligible ? format(value) : DASH));
  if (!eligible) { holder.title = `Not available: 0 of ${coverage.selected} selected sessions provide ${what}`; addClass(holder, "unavailable"); }
  const badge = coverageBadge(coverage, what);
  if (badge) holder.append(badge);
  return holder;
}

/**
 * KPI card. `value` is a preformatted string or null (renders an em dash). `reason` explains an unavailable value in a
 * short line; `coverage` adds the eligible/selected badge; `note` is the one-line caption.
 */
export function kpi({ label, value, note: caption = null, coverage = null, reason = null, accent = false, what = "evidence", id = null }) {
  const card = el("article", null, `kpi${accent ? " accent" : ""}`);
  card.append(el("span", label, "kpi-label"));
  const strong = el("strong", value ?? DASH);
  if (id) strong.id = id;
  if (value === null || value === undefined) { strong.title = reason ?? "Not available in this selection"; strong.setAttribute("aria-label", strong.title); }
  card.append(strong);
  const slot = el("small", null, "kpi-coverage");
  if (value === null || value === undefined) { slot.textContent = reason ?? "Not available"; addClass(slot, "kpi-reason"); }
  else { const badge = coverageBadge(coverage, what); if (badge) slot.append(badge); }
  if (slot.textContent || slot.childElementCount) card.append(slot);
  if (caption) card.append(el("small", caption, "kpi-note"));
  return card;
}

export function field(label, control, { inline = false } = {}) {
  const wrapper = el("label", null, `field${inline ? " field-inline" : ""}`);
  wrapper.append(el("span", label, "field-label"), control);
  return wrapper;
}

export function selectField(id, label, choices, value, onChange) {
  const select = el("select");
  if (id) select.id = id;
  select.setAttribute("aria-label", label);
  for (const [optionValue, text] of choices) { const option = el("option", text); option.value = optionValue; select.append(option); }
  if (value !== undefined && value !== null) select.value = value;
  if (onChange) select.addEventListener("change", () => onChange(select.value));
  return { select, wrapper: field(label, select) };
}

export function filterBar(...children) {
  const bar = el("div", null, "filter-bar");
  bar.setAttribute("role", "group");
  bar.append(...children.filter(Boolean));
  return bar;
}

/** Collapsed "Evidence & limits" block for guardrail copy, denominators, and method notes. */
export function evidence(items, { title = "Evidence & limits", open = false, className = "" } = {}) {
  const details = el("details", null, `evidence${className ? ` ${className}` : ""}`);
  if (open) details.open = true;
  details.append(el("summary", title));
  const body = el("div", null, "evidence-body");
  for (const item of items.filter((entry) => entry !== null && entry !== undefined && entry !== "")) body.append(typeof item === "string" ? el("p", item) : item);
  details.append(body);
  return details;
}

/** Table with the dashboard's standard chrome. Cells: string | { text, detail } | Element. First column may be a row header. */
export function dataTable(headers, rows, { empty = "No observations in this scope.", rowHeader = false, className = "", caption = null, minWidth = null } = {}) {
  if (!rows.length) return note(empty, "empty-line");
  const wrap = el("div", null, `table-wrap${className ? ` ${className}` : ""}`);
  const table = el("table", null, "data-table");
  if (minWidth) table.style.setProperty("min-width", minWidth);
  if (caption) table.append(el("caption", caption, "sr-only"));
  const head = el("thead"), headRow = el("tr");
  for (const header of headers) {
    const th = el("th", typeof header === "string" ? header : header.text);
    th.scope = "col";
    if (typeof header !== "string" && header.align === "left") addClass(th, "align-left");
    headRow.append(th);
  }
  head.append(headRow);
  const body = el("tbody");
  for (const cells of rows) {
    const tr = el("tr");
    cells.forEach((cell, index) => {
      const header = headers[index];
      const td = el(rowHeader && index === 0 ? "th" : "td", null, header && typeof header !== "string" && header.align === "left" ? "align-left" : "");
      if (rowHeader && index === 0) td.scope = "row";
      if (cell && typeof cell === "object" && !("tagName" in cell) && !("tag" in cell)) {
        td.append(el("span", cell.text));
        if (cell.detail) td.append(el("small", cell.detail));
      } else if (cell && typeof cell === "object") td.append(cell);
      else td.textContent = cell == null ? DASH : String(cell);
      tr.append(td);
    });
    body.append(tr);
  }
  table.append(head, body); wrap.append(table);
  return wrap;
}
