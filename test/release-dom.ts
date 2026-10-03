// Dependency-free DOM contract for exercising real renderers. No layout/CSS claims.
const dataKey = (name: string) => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
export class Element {
  tagName: string; children: Element[] = []; parentElement: Element | null = null;
  attributes: Record<string, string> = {}; dataset: Record<string, string> = {};
  style: Record<string, any> = { setProperty(name: string, value: string) { this[name] = value; } };
  id = ""; className = ""; value = ""; min = ""; max = ""; hidden = false; checked = true;
  disabled = false; type = ""; open = false; ownText = ""; isConnected = true;
  listeners = new Map<string, (...args: any[]) => unknown>();
  constructor(tag = "div") { this.tagName = tag; }
  get textContent(): string { return [this.ownText, ...this.children.map((c) => c.textContent)].join(" "); }
  set textContent(value: unknown) { this.ownText = value == null ? "" : String(value); this.children = []; }
  get viewBox() { const [x = 0, y = 0, width = 900, height = 300] = (this.attributes.viewBox ?? "0 0 900 300").split(" ").map(Number); return { baseVal: { x, y, width, height } }; }
  get childNodes() { return this.children; }
  prepend(...items: Element[]) { this.children.unshift(...items); }
  get childElementCount() { return this.children.length; }
  get selectedOptions() { return this.options.filter((e) => e.value === this.value); }
  get options() { return this.children.filter((c) => c.tagName === "option"); }
  classList = { add: (...names: string[]) => { this.className += " " + names.join(" "); },
    remove: (...names: string[]) => { this.className = this.className.split(" ").filter((x) => !names.includes(x)).join(" "); },
    contains: (name: string) => this.className.split(" ").includes(name),
    toggle: (name: string, on?: boolean) => { const enabled = on ?? !this.classList.contains(name); if (enabled) this.classList.add(name); else this.classList.remove(name); return enabled; } };
  append(...items: Element[]) { for (const item of items) { item.parentElement = this; this.children.push(item); } if (this.tagName === "select" && !this.value) this.value = this.options[0]?.value ?? ""; }
  replaceChildren(...items: Element[]) { this.ownText = ""; this.children = []; this.append(...items); }
  setAttribute(name: string, value: unknown) { this.attributes[name] = String(value); if (name === "id") this.id = String(value); if (name === "class") this.className = String(value); if (name.startsWith("data-")) this.dataset[dataKey(name.slice(5))] = String(value); }
  getAttribute(name: string) { return this.attributes[name] ?? null; }
  removeAttribute(name: string) { delete this.attributes[name]; }
  addEventListener(name: string, listener: (...args: any[]) => unknown) { this.listeners.set(name, listener); }
  removeEventListener() {} focus() {} scrollIntoView() {} showModal() { this.open = true; } close() { this.open = false; }
  getBoundingClientRect() { return { x: 0, y: 0, left: 0, top: 0, width: 900, height: 300 }; }
  all(): Element[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  matches(selector: string) {
    const last = selector.trim().split(/\s+/).at(-1)!;
    const id = last.match(/#([\w-]+)/)?.[1]; if (id && this.id !== id) return false;
    const tag = last.match(/^[a-z][\w-]*/i)?.[0]; if (tag && this.tagName !== tag) return false;
    for (const [, name] of last.matchAll(/\.([\w-]+)/g)) if (!this.classList.contains(name!)) return false;
    for (const [, name, value] of last.matchAll(/\[([\w-]+)(?:=["']?([^"'\]]+)["']?)?\]/g)) {
      const actual = name!.startsWith("data-") ? this.dataset[dataKey(name!.slice(5))] : this.getAttribute(name!) ?? (this as any)[name!];
      if (actual == null || value !== undefined && actual !== value) return false;
    }
    return true;
  }
  querySelectorAll(selector: string): Element[] { return this.all().filter((c) => selector.split(",").some((s) => c.matches(s))); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector: string): Element | null { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
}
export class Option extends Element { constructor(label: string, value: string) { super("option"); this.textContent = label; this.value = value; } }
export function documentFromHtml(html: string) {
  const body = new Element("body"), stack = [body];
  for (const match of html.matchAll(/<\/?([a-z][\w-]*)([^>]*)>/gi)) {
    const [source, tag, attrs] = match;
    if (source!.startsWith("</")) { const index = stack.findLastIndex((e) => e.tagName === tag); if (index > 0) stack.length = index; continue; }
    const element = new Element(tag);
    for (const [, key, value] of attrs!.matchAll(/([\w-]+)="([^"]*)"/g)) element.setAttribute(key!, value!);
    if (element.attributes.value) element.value = element.attributes.value;
    stack.at(-1)!.append(element);
    if (!/^(input|img|link|meta|br|hr)$/.test(tag!)) stack.push(element);
  }
  const query = (selector: string) => body.querySelector(selector);
  return { body, documentElement: new Element("html"), activeElement: body, title: "", addEventListener() {},
    querySelector: query, querySelectorAll: (selector: string) => body.querySelectorAll(selector), getElementById: (id: string) => query(`#${id}`),
    createElement: (tag: string) => new Element(tag), createElementNS: (_ns: string, tag: string) => new Element(tag),
    createTextNode: (text: string) => { const e = new Element("text"); e.textContent = text; return e; } };
}
