# Public website

The [landing page](https://rokas-tarasevicius.github.io/session-analytics/) is a static GitHub Pages site. It uses the existing brand assets and synthetic screenshots and adds no runtime or build dependencies. Fonts and provider marks retain their bundled licenses and notices. All browser assets are served from the site itself, with no analytics or third-party scripts.

## Develop

With Node.js 24+, no dependency installation is needed:

```sh
npm run site:build
python3 -m http.server 4175 --directory .site-dist
```

Open `http://localhost:4175`. Re-run the build after edits. `layout.html` supplies the shared head, navigation and footer; `index.html` and `releases.html` are page bodies. `style.css` owns the responsive design and `site.js` enhances screenshot and installation tabs and copy buttons. Content, default installation commands, navigation, FAQ and release notes remain available without JavaScript.

`site/releases.json` is a checked-in snapshot of published stable GitHub Releases for deterministic, offline development and PR builds. It is not the production source of truth. Refresh it deliberately with:

```sh
npm run site:build -- --github --update-cache
```

`--github` fetches all release pages plus GitHub's designated latest release. `GH_TOKEN` is optional locally and provided by Actions. Drafts and prereleases are excluded. API failures stop the build instead of deploying cached notes. No API calls or tokens are sent to visitors' browsers.

## Publish and update

In repository **Settings → Pages**, select **GitHub Actions**. The `Pages` workflow builds `.site-dist` and deploys it using the `github-pages` environment. Website/asset changes on `master` rebuild the site; pull requests only test and build. You can also run **Pages → Run workflow**.

The `github-pages` environment permits the `master` branch and `v*` tags. The tag rule allows manually published or edited release events to deploy; deployment still checks out the current `master` source. Keep both rules if recreating the environment. Atom entries retain their publication date and use GitHub's update timestamp so note edits reach feed readers.

Release notes rebuild on published/edited/deleted release events and after the `Release` workflow completes on `master`. Completion is necessary because releases created with `GITHUB_TOKEN` do not start another workflow through the `release` event. It rebuilds even if npm or Homebrew fails after publication. Dry-run release workflows do not trigger it. Deployment always checks out trusted `master` and fetches published notes anew; it never downloads or executes artifacts from a triggering workflow.

Production generates the landing page, `/releases/` archive, `releases.xml` Atom feed, `releases.json`, sitemap and robots file. Version anchors are stable; the latest badge follows GitHub's designation, so an older backport does not replace it. Only allowlisted public assets are copied, never analytics code or session data. The Markdown renderer supports headings, bullets, paragraphs, fenced code, inline code, bold and HTTP(S)/relative links; raw HTML is escaped. Every release links to its original notes and downloads on GitHub.

## Validate

```sh
node --test test/site.test.mjs
```

These tests also run in `npm test`. They cover pagination, latest/backport ordering, draft/prerelease filtering, API failures, HTML escaping, release anchors, asset completeness and project-subpath links. For visual review, check desktop and phone widths, keyboard navigation in both tab groups, command copying, FAQ, archive, and JavaScript-disabled behavior. Use only synthetic demo assets.
