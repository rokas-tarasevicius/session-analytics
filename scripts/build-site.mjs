#!/usr/bin/env node
/** Static public website. Never imports the analytics runtime or reads session data. */
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const repository = "rokas-tarasevicius/session-analytics";
const repoUrl = `https://github.com/${repository}`;
const siteUrl = "https://rokas-tarasevicius.github.io/session-analytics/";
const providers = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  ["copilot", "Copilot CLI"],
  ["opencode", "OpenCode"],
  ["gemini", "Gemini CLI"],
  ["antigravity", "Antigravity"],
];

export function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ],
  );
}

function inline(text, base) {
  // Deliberately small Markdown subset: escape raw HTML and only allow HTTP(S) links.
  const token =
    /(`+)([\s\S]*?)\1|\[([^\]\n]+)\]\(([^\s)]+)\)|\*\*([^*\n]+)\*\*/g;
  let html = "",
    end = 0;
  for (const match of text.matchAll(token)) {
    html += escapeHtml(text.slice(end, match.index));
    if (match[1]) html += `<code>${escapeHtml(match[2])}</code>`;
    else if (match[3]) {
      let url;
      try {
        url = new URL(match[4], base);
      } catch {
        /* Render malformed links as text. */
      }
      html +=
        url && ["https:", "http:"].includes(url.protocol)
          ? `<a href="${escapeHtml(url.href)}">${escapeHtml(match[3])}</a>`
          : escapeHtml(match[3]);
    } else html += `<strong>${escapeHtml(match[5])}</strong>`;
    end = match.index + match[0].length;
  }
  return html + escapeHtml(text.slice(end));
}

export function markdown(text, tag) {
  const base = `${repoUrl}/blob/${encodeURIComponent(tag)}/`;
  const result = [];
  let list = false,
    paragraph = [],
    code = null;
  const flush = () => {
    if (paragraph.length)
      result.push(`<p>${inline(paragraph.join(" "), base)}</p>`);
    paragraph = [];
    if (list) result.push("</ul>");
    list = false;
  };
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^```/.test(line)) {
      if (code !== null) {
        result.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = null;
      } else {
        flush();
        code = [];
      }
    } else if (code !== null) code.push(line);
    else if (/^#{1,6}\s+/.test(line)) {
      flush();
      result.push(`<h3>${inline(line.replace(/^#+\s+/, ""), base)}</h3>`);
    } else if (/^\s*[-*] /.test(line)) {
      if (paragraph.length) {
        result.push(`<p>${inline(paragraph.join(" "), base)}</p>`);
        paragraph = [];
      }
      if (!list) {
        result.push("<ul>");
        list = true;
      }
      result.push(`<li>${inline(line.replace(/^\s*[-*] /, ""), base)}</li>`);
    } else if (!line.trim()) flush();
    else {
      if (list) flush();
      paragraph.push(line);
    }
  }
  flush();
  if (code !== null)
    result.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
  return result.join("\n");
}

export function normalizeReleases(releases, latestTag) {
  if (!Array.isArray(releases))
    throw new Error("GitHub returned an invalid release list.");
  const published = releases
    .filter((release) => release && !release.draft && !release.prerelease)
    .map((release) => {
      if (
        !/^v\d+\.\d+\.\d+$/.test(release.tag_name) ||
        !Number.isFinite(Date.parse(release.published_at)) ||
        typeof release.body !== "string"
      ) {
        throw new Error(
          "A published release has invalid metadata. Refusing to deploy incomplete notes.",
        );
      }
      return {
        tag_name: release.tag_name,
        published_at: new Date(release.published_at).toISOString(),
        body: release.body,
      };
    });
  if (
    !published.length ||
    !published.some((release) => release.tag_name === latestTag)
  ) {
    throw new Error(
      "The latest stable release is missing. Refusing to deploy stale or incomplete notes.",
    );
  }
  const unique = [
    ...new Map(
      published.map((release) => [release.tag_name, release]),
    ).values(),
  ];
  unique.sort((a, b) =>
    a.tag_name === latestTag
      ? -1
      : b.tag_name === latestTag
        ? 1
        : Date.parse(b.published_at) - Date.parse(a.published_at),
  );
  return { latestTag, releases: unique };
}

export async function fetchReleases(
  fetcher = fetch,
  token = process.env.GH_TOKEN,
) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "session-analytics-pages",
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const get = async (path) => {
    const response = await fetcher(
      `https://api.github.com/repos/${repository}${path}`,
      { headers, signal: AbortSignal.timeout(30_000) },
    );
    if (!response.ok)
      throw new Error(
        `GitHub releases request failed (HTTP ${response.status}). The existing site is left unchanged.`,
      );
    return response.json();
  };
  const latest = await get("/releases/latest");
  const releases = [];
  for (let page = 1; page <= 100; page++) {
    const batch = await get(`/releases?per_page=100&page=${page}`);
    if (!Array.isArray(batch))
      throw new Error("GitHub returned an invalid release list.");
    releases.push(...batch);
    if (batch.length < 100) return normalizeReleases(releases, latest.tag_name);
  }
  throw new Error(
    "Release pagination exceeded its limit. Refusing to truncate the archive.",
  );
}

const releaseUrl = (release) =>
  `${repoUrl}/releases/tag/${encodeURIComponent(release.tag_name)}`;
const releaseId = (release) => `release-${release.tag_name}`;
const date = (release) =>
  new Intl.DateTimeFormat("en", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(release.published_at));
const latestBadge = '<span class="latest-label">LATEST</span>';

export async function buildSite(data, out = join(root, ".site-dist")) {
  const { releases, latestTag } = normalizeReleases(
    data.releases,
    data.latestTag,
  );
  const latest = releases[0];
  const summary = (release) => {
    const first =
      release.body
        .split("\n")
        .find((line) => /^- /.test(line))
        ?.slice(2) || "See the full release notes for changes and fixes.";
    const plain = first
      .replace(/`+/g, "")
      .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
      .replace(/\*\*/g, "");
    return plain.length > 220
      ? `${plain.slice(0, 217).replace(/\s+\S*$/, "")}…`
      : plain;
  };
  const common = {
    REPO_URL: repoUrl,
    DOCS_URL: `${repoUrl}/blob/master/docs`,
    SITE_URL: siteUrl,
    LATEST_TAG: escapeHtml(latestTag),
    LATEST_ID: releaseId(latest),
    LATEST_URL: releaseUrl(latest),
    PROVIDERS: providers
      .map(
        ([id, name]) =>
          `<span class="provider"><img src="./brands/${id}.svg" width="21" height="21" alt="">${name}</span>`,
      )
      .join(""),
    RECENT_RELEASES: releases
      .slice(0, 3)
      .map(
        (release) =>
          `<a class="release-preview" href="./releases/#${releaseId(release)}"><div><span class="release-version">${release.tag_name}${release.tag_name === latestTag ? latestBadge : ""}</span><time datetime="${release.published_at}">${date(release)}</time></div><p class="release-summary">${escapeHtml(summary(release))}</p><span class="release-arrow" aria-hidden="true">↗</span></a>`,
      )
      .join("\n"),
    RELEASE_INDEX: releases
      .map(
        (release) =>
          `<a href="#${releaseId(release)}">${release.tag_name}${release.tag_name === latestTag ? " ↗" : ""}</a>`,
      )
      .join("\n"),
    ALL_RELEASES: releases
      .map(
        (release) =>
          `<article class="release-entry" id="${releaseId(release)}"><header><h2><a href="#${releaseId(release)}">${release.tag_name}</a>${release.tag_name === latestTag ? latestBadge : ""}</h2><time datetime="${release.published_at}">${date(release)}</time></header><div class="release-body">${markdown(release.body, release.tag_name)}</div><a class="release-source" href="${releaseUrl(release)}">View release &amp; downloads on GitHub ↗</a></article>`,
      )
      .join("\n"),
  };
  const layout = await readFile(join(root, "site/layout.html"), "utf8");
  const render = (template, values) =>
    template.replace(/\{\{([A-Z_]+)\}\}/g, (_, key) => {
      if (!(key in values))
        throw new Error(`Missing site template value: ${key}`);
      return values[key];
    });
  await mkdir(join(out, "releases"), { recursive: true });
  for (const [source, path, title, description, prefix] of [
    [
      "index.html",
      "index.html",
      "Session Analytics — See the whole picture",
      "Local, content-free analytics for your coding agents. Understand usage, models, tools, and activity across repositories. Open source. No telemetry.",
      "./",
    ],
    [
      "releases.html",
      "releases/index.html",
      "Release notes — Session Analytics",
      "Every published Session Analytics release: new capabilities, fixes, and the details behind your coding-agent analytics.",
      "../",
    ],
  ]) {
    const values = {
      ...common,
      ROOT: prefix,
      TITLE: title,
      DESCRIPTION: description,
      CANONICAL: siteUrl + (prefix === "../" ? "releases/" : ""),
      RELEASE_CURRENT: prefix === "../" ? 'aria-current="page"' : "",
    };
    const content = render(
      await readFile(join(root, "site", source), "utf8"),
      values,
    );
    await writeFile(
      join(out, path),
      render(layout, { ...values, CONTENT: content }),
    );
  }
  await mkdir(join(out, "assets"), { recursive: true });
  for (const file of [
    "logo.svg",
    "social-preview.png",
    ...["summary", "velocity", "costs", "tools", "repository"].map(
      (view) => `screenshot-${view}.webp`,
    ),
  ]) {
    await cp(join(root, "assets", file), join(out, "assets", file));
  }
  for (const directory of ["fonts", "brands"])
    await cp(join(root, "src/public", directory), join(out, directory), {
      recursive: true,
    });
  for (const file of ["style.css", "site.js"])
    await cp(join(root, "site", file), join(out, file));
  await writeFile(join(out, ".nojekyll"), "");
  await writeFile(
    join(out, "releases.json"),
    JSON.stringify({ latestTag, releases }, null, 2) + "\n",
  );
  const updated = releases
    .map((release) => release.published_at)
    .sort()
    .at(-1);
  await writeFile(
    join(out, "releases.xml"),
    `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Session Analytics releases</title><id>${siteUrl}releases/</id><link href="${siteUrl}releases.xml" rel="self"/><link href="${siteUrl}releases/"/><updated>${updated}</updated><author><name>Session Analytics</name></author>${releases.map((release) => `<entry><title>${release.tag_name}</title><id>${releaseUrl(release)}</id><link href="${releaseUrl(release)}"/><updated>${release.published_at}</updated><content type="text">${escapeHtml(release.body)}</content></entry>`).join("")}</feed>\n`,
  );
  await writeFile(
    join(out, "robots.txt"),
    `User-agent: *\nAllow: /\nSitemap: ${siteUrl}sitemap.xml\n`,
  );
  await writeFile(
    join(out, "sitemap.xml"),
    `<?xml version="1.0" encoding="utf-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${siteUrl}</loc></url><url><loc>${siteUrl}releases/</loc></url></urlset>\n`,
  );
  return { out, count: releases.length, latestTag };
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    const args = process.argv.slice(2);
    if (
      args.some((arg) => !["--github", "--update-cache"].includes(arg)) ||
      (args.includes("--update-cache") && !args.includes("--github"))
    )
      throw new Error(
        "Usage: node scripts/build-site.mjs [--github [--update-cache]]",
      );
    const cache = join(root, "site/releases.json");
    const data = args.includes("--github")
      ? await fetchReleases()
      : JSON.parse(await readFile(cache, "utf8"));
    const result = await buildSite(data);
    if (args.includes("--update-cache"))
      await writeFile(cache, JSON.stringify(data, null, 2) + "\n");
    console.log(
      `Built ${result.out}: ${result.count} published releases, latest ${result.latestTag}.${args.includes("--github") ? "" : " Offline preview uses the checked-in release snapshot; deployment always fetches GitHub."}`,
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
