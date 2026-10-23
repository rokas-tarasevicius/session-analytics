import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildSite,
  fetchReleases,
  markdown,
  normalizeReleases,
} from "../scripts/build-site.mjs";

const release = (tag, extra = {}) => ({
  tag_name: tag,
  published_at: "2026-10-23T00:46:59Z",
  body: "### Added\n\n- A **clearer** view with `metrics`.\n\nSee [the docs](docs/metrics.md).",
  ...extra,
});

test("site: release Markdown escapes HTML and unsafe links while preserving code and documentation links", () => {
  const result = markdown(
    "### Fixed\n\n- <img src=x onerror=alert(1)>\n- [unsafe](javascript:alert)\n- [docs](docs/privacy.md)\n- **visible** `a<b`\n\n```sh\n<script>bad</script>\n```",
    "v1.2.3",
  );
  assert.doesNotMatch(result, /<img|<script|href="javascript:/);
  assert.match(result, /&lt;img/);
  assert.match(result, /<h3>Fixed<\/h3>/);
  assert.match(result, /<strong>visible<\/strong> <code>a&lt;b<\/code>/);
  assert.match(
    result,
    /href="https:\/\/github.com\/rokas-tarasevicius\/session-analytics\/blob\/v1.2.3\/docs\/privacy.md"/,
  );
  assert.match(
    result,
    /<pre><code>&lt;script&gt;bad&lt;\/script&gt;<\/code><\/pre>/,
  );
});

test("site: exclude drafts and prereleases, deduplicate tags and honor latest even after a backport", () => {
  const data = normalizeReleases(
    [
      release("v1.0.0", { published_at: "2026-10-24T00:00:00Z" }),
      release("v2.0.0"),
      release("v2.0.0"),
      release("v3.0.0", { draft: true }),
      release("v3.0.0-beta", { prerelease: true }),
    ],
    "v2.0.0",
  );
  assert.deepEqual(
    data.releases.map((item) => item.tag_name),
    ["v2.0.0", "v1.0.0"],
  );
  assert.throws(() => normalizeReleases([], "v1.0.0"), /missing/);
  assert.throws(
    () =>
      normalizeReleases([release("v1.0.0", { published_at: "bad" })], "v1.0.0"),
    /invalid metadata/,
  );
  assert.throws(
    () => normalizeReleases([release('<img src="x">')], "v1.0.0"),
    /invalid metadata/,
  );
});

test("site: paginate GitHub releases and fail closed on API errors", async () => {
  const urls = [];
  const fetcher = async (url) => {
    urls.push(url);
    const body = url.endsWith("/latest")
      ? { tag_name: "v0.99.0" }
      : url.endsWith("page=1")
        ? Array.from({ length: 100 }, (_, i) => release(`v0.${i}.0`))
        : [release("v0.100.0")];
    return { ok: true, json: async () => body };
  };
  const data = await fetchReleases(fetcher, "");
  assert.equal(data.releases.length, 101);
  assert.equal(data.releases[0].tag_name, "v0.99.0");
  assert.equal(urls.length, 3);
  assert.ok(
    urls.every((url) =>
      url.startsWith(
        "https://api.github.com/repos/rokas-tarasevicius/session-analytics/",
      ),
    ),
  );
  await assert.rejects(
    fetchReleases(async () => ({ ok: false, status: 403 }), ""),
    /HTTP 403/,
  );
  await assert.rejects(
    fetchReleases(
      async (url) => ({
        ok: true,
        json: async () =>
          url.endsWith("/latest") ? { tag_name: "v1.0.0" } : {},
      }),
      "",
    ),
    /invalid release list/,
  );
});

test("site: build complete static output with working project-subpath links, anchors and licensed assets", async () => {
  const out = await mkdtemp(join(tmpdir(), "session-analytics-site-"));
  try {
    const result = await buildSite(
      {
        latestTag: "v1.0.0",
        releases: [
          release("v1.0.0", {
            updated_at: "2026-10-24T12:00:00Z",
            body: "### Added\n\n- <script>bad</script> & `tokens`.\n\nLiteral {{ROOT}} remains release content.",
          }),
        ],
      },
      out,
    );
    assert.equal(result.count, 1);
    const homepage = await readFile(join(out, "index.html"), "utf8");
    const archive = await readFile(join(out, "releases/index.html"), "utf8");
    assert.match(homepage, /v1.0.0<\/span><span>is out/);
    assert.match(homepage, /<li class="chip" style="--c: var\(--provider-claude\)">/);
    assert.match(archive, /id="release-v1.0.0"/);
    assert.match(archive, /Literal \{\{ROOT\}\} remains release content/);
    assert.doesNotMatch(homepage + archive, /<script>bad|\{\{TITLE\}\}/);
    for (const [path, html] of [
      ["index.html", homepage],
      ["releases/index.html", archive],
    ]) {
      const base = new URL(path, "https://example.test/session-analytics/");
      for (const [, target] of html.matchAll(/(?:href|src|srcset)="([^"]+)"/g)) {
        const url = new URL(target, base);
        if (url.origin !== base.origin) continue;
        assert.ok(
          url.pathname.startsWith("/session-analytics/"),
          `Project path lost: ${target}`,
        );
        let relative = decodeURIComponent(
          url.pathname.slice("/session-analytics/".length),
        );
        if (relative.endsWith("/") || !relative) relative += "index.html";
        assert.ok(
          (await stat(join(out, relative))).isFile(),
          `Missing file ${relative}`,
        );
        if (url.hash) {
          const document = await readFile(join(out, relative), "utf8");
          assert.ok(
            document.includes(`id="${url.hash.slice(1)}"`),
            `Missing anchor ${target}`,
          );
        }
      }
    }
    const feed = await readFile(join(out, "releases.xml"), "utf8");
    assert.match(feed, /xmlns="http:\/\/www.w3.org\/2005\/Atom"/);
    assert.match(feed, /&lt;script&gt;bad&lt;\/script&gt; &amp;/);
    assert.match(feed, /<published>2026-10-23T00:46:59.000Z<\/published>/);
    assert.equal(
      (feed.match(/<updated>2026-10-24T12:00:00.000Z<\/updated>/g) ?? [])
        .length,
      2,
    );
    assert.equal(
      JSON.parse(await readFile(join(out, "releases.json"), "utf8")).latestTag,
      "v1.0.0",
    );
    assert.ok((await readdir(join(out, "fonts"))).includes("OFL-1.1.txt"));
    assert.ok((await readdir(join(out, "brands"))).includes("NOTICE.md"));
    assert.deepEqual((await readdir(out)).sort(), [
      ".nojekyll",
      "assets",
      "brands",
      "fonts",
      "index.html",
      "releases",
      "releases.json",
      "releases.xml",
      "robots.txt",
      "site.js",
      "sitemap.xml",
      "style.css",
    ]);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
