# Public-history privacy review — 2026-10-13

**Result: no supported privacy or credential findings in the declared scope. No history-review release blocker remains.** This is a completed manual source/history assessment with the limits below, not a certification that arbitrary secrets cannot exist.

Reviewed candidate: `6273823ac8c7c9e2539338ee489506a8472c0e48` on `release/open-source-readiness`, plus the current tracked working tree at review time. The candidate may acquire new commits; changes after this snapshot need a delta review.

## Scope and exact coverage

The inventory used `git rev-list --objects --all`, so this review covers every locally fetched origin branch and tag, rather than only the candidate's ancestors. Individual commit trees were also enumerated with `git ls-tree -r -z` to identify reused blobs at additional paths.

| Evidence surface | Reviewed | Excluded within that surface |
| --- | ---: | ---: |
| Origin refs, including the symbolic HEAD alias | 25 | 0 |
| Tags (`v0.7.0`, `v0.8.0`) | 2 | 0 |
| Commits reachable from origin refs or tags | 96 | 0 |
| Commits reachable from all 34 local refs, including three local heads and four local checkpoint refs | 103 | 0 |
| Unique reachable file blobs | 2,372 | 0 |
| Unique historical text blobs | 2,111 | 0 |
| Unique historical PNG blobs | 231 | 0 |
| Unique historical WebP blobs | 24 | 0 |
| Unique historical WOFF2 blobs | 6 | 0 |
| Current tracked text files checked independently | 547 | 0 |
| Current tracked binary files, already included above | 28 | 0 |

The former scan covered 2,074 text blobs and excluded 259 binary blobs. This pass rescanned the entire reachable text inventory and assessed all 261 current historical binary blobs, including the two newer mobile screenshots. No archive, executable, database, PDF, audio, or video blobs were present in the binary inventory.

The SHA-256 of the sorted full binary object IDs, each followed by a newline, is `edff574bc4f183637b9d9c44070bffdea5f6c5189b0b898512c07a4b72f3a499`. The captured ref-name/object-ID inventory digest is `a5bc60a6a89ef18aed354ad72fd2e657ad1edd04bbb347186b0a69b422495b07`. Local checkpoint ref names are intentionally omitted from this public report; their objects were still reviewed.

## Methods and findings

**Text and commit messages.** Read each unique text blob through Git's object reader without running repository content or external Git filters. Scanned recognizable AWS, GitHub, model-provider, Slack, Stripe, Google, private-key, credential-URL, JWT, and quoted literal credential patterns. The 103 commit objects were scanned separately. Pattern candidates occurred only in eight synthetic security-test files: `test/insights-cli.test.ts`, `test/interop.test.ts`, `test/mcp-inventory.test.ts`, `test/mcp.test.ts`, `test/outcomes.test.ts`, `test/pricing-review.test.ts`, `test/pricing.test.ts`, and `verify/repos/git-oracle.test.ts`. Their fixture contexts use explicit sentinels and example targets. No candidate occurred in commit objects or encoded binary bytes. Current tracked-tree candidates were the same fixture classes.

**Personal paths and private records.** Checked historical personal-home/agent paths, then reviewed redacted context. Matches were synthetic adapter expectations, rejected-command fixtures, and an audit-instruction pattern, rather than private working-directory values. The tracked local-audit evidence is aggregate counts and distributions, not raw message/response records. Public Git author identity, public project identity, provider/model/tool labels, license authorship, and deliberate examples were not treated as credential leaks.

**Every image.** All 255 unique images decoded successfully with ImageMagick. Visually reviewed every image using 17 indexed contact sheets, including deleted preview/design branches and prior versions of current screenshots. Tesseract 5.5.0 English sparse-text OCR completed for 255/255 images and extracted 567,494 characters. The logo was the only image with no OCR text. OCR credential, personal-machine-path, email, and URL candidate checks returned zero matches. Visible dashboard labels and values are consistent with the fictional six-repository demo; no raw prompts, responses, secrets, personal contact details, or machine paths were observed. `scripts/demo.ts` supplies the synthetic repository data; `scripts/screenshots.ts` documents screenshot generation against that demo. This conclusion comes from inspecting the images as well as those source claims.

**Image metadata.** Parsed PNG chunks and WebP containers. No EXIF, XMP, GPS, personal author, or private-path metadata was present. Four PNG blobs contain twelve text metadata entries in total, all timestamp-only `date:create`, `date:modify`, or `date:timestamp` fields. Remaining ancillary metadata consists of color/background/profile, density, and timestamp information. The two mobile WebP color profiles contain no observed personal identifiers.

**Every font.** All six WOFF2 files decoded successfully with fontconfig. Family/style/foundry metadata identifies Geist, Geist Mono, Space Grotesk, Inter, Newsreader, and Newsreader Italic. These are public font assets with expected family metadata. Reused font blobs inside historical bundled skill paths are included in the inventory below.

No raw credential candidates, OCR transcripts, or private temporary artifacts are included in this report. Nothing was sent to provider credential-validation APIs. No history rewrite or remote mutation was performed.

## Limits and exclusions

- Coverage is the fetched refs captured above and the tracked tree at review time. Reflogs, dangling/unreachable objects, untracked local files, unavailable server-side pull-request refs, GitHub discussion/issue/Actions artifacts, and future refs or changes were outside this source-history review.
- OCR and visual inspection can miss very small, blurred, cropped, or stylized text. Pattern scans do not identify every possible unstructured or encrypted credential. Font inspection covers format decoding and metadata; this review does not claim steganographic or malicious-font exploit analysis.
- No reachable text or binary blob was skipped because of format, size, timeout, or decode failure. All scanner candidates were challenged against fixture/source context; no independent third-party scanner or external review is claimed.
- The earlier CSO helper's formal `history-inputs` gap remains part of that earlier report. This separate completed manual inventory and review supersedes its history/binary exclusions for this declared scope; it does not alter or upgrade the helper's proof labels.

## Origin and tag refs captured

- `refs/remotes/origin/HEAD`
- `refs/remotes/origin/ci/agentbox-runners`
- `refs/remotes/origin/design/refine-control-room`
- `refs/remotes/origin/docs/ideation-product`
- `refs/remotes/origin/docs/ideation-research`
- `refs/remotes/origin/feat/behavior`
- `refs/remotes/origin/feat/index-store`
- `refs/remotes/origin/feat/insights`
- `refs/remotes/origin/feat/interop`
- `refs/remotes/origin/feat/limits-cache`
- `refs/remotes/origin/feat/mcp-agent`
- `refs/remotes/origin/feat/outcomes`
- `refs/remotes/origin/feat/pricing-api`
- `refs/remotes/origin/feat/providers`
- `refs/remotes/origin/feat/reliability`
- `refs/remotes/origin/feat/velocity`
- `refs/remotes/origin/fix/v0.6.1-correctness`
- `refs/remotes/origin/fix/v0.6.2-recovery-calibration`
- `refs/remotes/origin/fix/velocity-costs-charts`
- `refs/remotes/origin/integration/v0.6`
- `refs/remotes/origin/master`
- `refs/remotes/origin/previews`
- `refs/remotes/origin/theme/control`
- `refs/remotes/origin/theme/ink`
- `refs/remotes/origin/theme/paper`
- `refs/tags/v0.7.0`
- `refs/tags/v0.8.0`

## Exact binary inventory

Each full object ID below was decoded and inspected. Image rows received visual, OCR, metadata, and encoded-byte checks; font rows received decoding, family metadata, and encoded-byte checks. Every historical path alias identified across the 103 commit trees is listed.

<details>
<summary>261 reviewed binary blobs</summary>

| Object ID | Format | Historical paths |
| --- | --- | --- |
| `722e8069556d8692e2b035433bccd5ea1681008c` | image/png | `assets/logo.png` |
| `3fa3b81fa08516c2e8da304aec213f367094c137` | image/webp | `assets/screenshot-activity-dark.webp` |
| `210bd7e32ea2b9bf806dc21e29ff9a1bf58b05e1` | image/png | `assets/screenshot-activity.png` |
| `a49bb9008aa71d98ea54b91a7edb3fb9b94b6e48` | image/webp | `assets/screenshot-activity.webp` |
| `90fd335bc47ba210477b714c1b9158ded4c381a8` | image/webp | `assets/screenshot-costs-dark.webp` |
| `f39a135d51eda139554d978963713384dd8b759e` | image/png | `assets/screenshot-costs.png` |
| `7a8634ca6661d488392c81892df38dcf12cdae29` | image/webp | `assets/screenshot-costs.webp` |
| `1a396217caddf3c9266218bc95dd73d4c4c842c0` | image/webp | `assets/screenshot-coverage-dark.webp` |
| `a191dd91fe69955e17e6d273e17564683882634d` | image/webp | `assets/screenshot-coverage.webp` |
| `07d3a94d4d4ba0e6552542da34f7afb8e33d45d9` | image/png | `assets/screenshot-dashboard.png` |
| `40a7675443b32fac1f8aab68cb13609673092e26` | image/png | `assets/screenshot-dashboard.png` |
| `5463abd66302ba0480703e5d22e3bc277d069d29` | image/png | `assets/screenshot-dashboard.png` |
| `8f80974ef80690ae281e9dcc9722ade6e58cd6e6` | image/png | `assets/screenshot-dashboard.png` |
| `f3804944b125bd10d6aed260ac4270308249625a` | image/png | `assets/screenshot-insights.png` |
| `8a529b52c11555522c70514209c98c0c3d137260` | image/webp | `assets/screenshot-mobile-dark.webp` |
| `8a893ed3efb28ebcb2d626e826fee9c1a664e9c4` | image/webp | `assets/screenshot-mobile.webp` |
| `fc7191377594830518c2ed9112291f344c54b86b` | image/webp | `assets/screenshot-palette-dark.webp` |
| `db6e7680371220367ed6db8b3cefa95bc7ef15a6` | image/webp | `assets/screenshot-palette.webp` |
| `a7bcc92e0dc87928dd42e0967441176aeefccffc` | image/webp | `assets/screenshot-pricing-dark.webp` |
| `ebfde7cfe15109acedb195f8cbf7f2e4c8400ac1` | image/webp | `assets/screenshot-pricing.webp` |
| `262ca5b3b47522030055f483ffc5aa024ace2b9b` | image/png | `assets/screenshot-reliability.png` |
| `88ec902210ace41370bad652402d9ddc6a59962e` | image/png | `assets/screenshot-repositories.png` |
| `8f50e571249797eeae997e1373d4a396cd7021eb` | image/webp | `assets/screenshot-repository-dark.webp` |
| `fb84edaff997d2f86764a039e07de0035acab34c` | image/webp | `assets/screenshot-repository.webp` |
| `1b99de5326bcca61364502986a31302033f616c6` | image/webp | `assets/screenshot-summary-breakdowns-dark.webp` |
| `7929891affb905b82dc1de9b408fc063b336ae88` | image/webp | `assets/screenshot-summary-breakdowns.webp` |
| `8f1b018e4ee576c60cc8e92b566eaa1186d7073d` | image/webp | `assets/screenshot-summary-dark.webp` |
| `85d86ed9292e8f2ef2f382740da110bd00c78635` | image/webp | `assets/screenshot-summary.webp` |
| `3416d1517c81095aafe569048392328709cfeae1` | image/webp | `assets/screenshot-tools-dark.webp` |
| `33cc9d70a9aadc4e01e69b7b2cb53c74b0d5f450` | image/webp | `assets/screenshot-tools.webp` |
| `c529522d30e3e646281784fbe91e644685e94f93` | image/webp | `assets/screenshot-velocity-dark.webp` |
| `9d99b6918967b8e017bb5b63eacc478d19999029` | image/webp | `assets/screenshot-velocity-movers-dark.webp` |
| `a60971a65ced2d7f1f7b86da3ea606f2044a2731` | image/webp | `assets/screenshot-velocity-movers.webp` |
| `055c81c8ff8d6dd42ebc93528d69500f1c8041c6` | image/png | `assets/screenshot-velocity.png` |
| `ec4d3db6de0e7a94d9632a6d35b2edfe549abde8` | image/png | `assets/screenshot-velocity.png` |
| `97670857ae17ca34c07d29afeca1bf2426d1974c` | image/webp | `assets/screenshot-velocity.webp` |
| `165fa3cd0924521442443895ecc1367a65f38438` | image/png | `assets/social-preview.png` |
| `c6a2d463ea5add6f45968036d37a205c7aa54e18` | image/png | `behavior/workflow-dark.png` |
| `9f6a0f7d9748436173e2f5cf12a859a7bb96d7b3` | image/png | `behavior/workflow-light.png` |
| `c76f724e8a6d3557108f884591fa25cb82e165e5` | image/png | `design-refine/after-activity-dark.png` |
| `bd899be3c6bdc9e2d84f1437ff57f33335541114` | image/png | `design-refine/after-activity-light.png` |
| `c2cd3a880723a689186243add042e584f5c445ac` | image/png | `design-refine/after-costs-dark.png` |
| `3d527ea4641229e37614e6e8491bac041a55795b` | image/png | `design-refine/after-costs-light.png` |
| `35a4dadb7b79b9483e5a79763816b7f8564b9e9b` | image/png | `design-refine/after-distributions-dark.png` |
| `b4d1f77ea0b60dc9bef2acc8d7d8d0453f0365de` | image/png | `design-refine/after-distributions-light.png` |
| `9f706cde3adb3c49b8d1c6bf1a09a0882e59ee3e` | image/png | `design-refine/after-insights-dark.png` |
| `41100c08541c677b12798787c82f8a82808d9647` | image/png | `design-refine/after-insights-light.png` |
| `0059f411e0d073e0c2ca80925d32398449017fba` | image/png | `design-refine/after-limits-cache-dark.png` |
| `7706cea25a04b3bf551de77fa6a75a79ae3215df` | image/png | `design-refine/after-limits-cache-light.png` |
| `fab5a5a3fae745007c247eaffb75a7d68781f28b` | image/png | `design-refine/after-models-dark.png` |
| `fbe94c1f456ff9a56e90ad2a54d1d96e342193cb` | image/png | `design-refine/after-models-light.png` |
| `9692789198ecb8208634b22c3b3fc9a3e678543f` | image/png | `design-refine/after-outcomes-dark.png` |
| `0642d60e454cec52000120989da31ac228d835f8` | image/png | `design-refine/after-outcomes-light.png` |
| `903bf0d30641b8e919be794d60f5ffca7f2a68fa` | image/png | `design-refine/after-pricing-dark.png` |
| `8b1485a4ef35245561311c509f32424b4fa63f8d` | image/png | `design-refine/after-pricing-light.png` |
| `53f4f129e1100f6a43ed4df3e6a426337faea5ce` | image/png | `design-refine/after-reliability-dark.png` |
| `48fe2a8cbc193758c8102967e1f5dcd07ba8ded0` | image/png | `design-refine/after-reliability-light.png` |
| `29211f89337d58c986d7590ff8e4864ba072175d` | image/png | `design-refine/after-skills-dark.png` |
| `9b3e3019fa25833c6071fb4963cecf9aa6d79a2a` | image/png | `design-refine/after-skills-light.png` |
| `a0caa4cd747eee93c87cc4c36a8a35f11bd65786` | image/png | `design-refine/after-summary-dark.png` |
| `10f06c7e221049848ac8b18db98172a51a218713` | image/png | `design-refine/after-summary-light.png` |
| `313baefd39b034197ea03715fa557109359eee46` | image/png | `design-refine/after-tools-dark.png` |
| `0211ba84abe7388c15f659a793828c7bf95a1fee` | image/png | `design-refine/after-tools-light.png` |
| `dfc847aacc3a8d42a55f74ac45a3908c8725f89c` | image/png | `design-refine/after-velocity-dark.png` |
| `cd8a59f8e5f08c2af57dea79de39300b46639ea7` | image/png | `design-refine/after-velocity-light.png` |
| `c8821da9c642eca72ea2646233f6e358fa31e755` | image/png | `design-refine/after-workflow-dark.png` |
| `be86cc7c7f9be33ae8a6318ce9389e29ff8f2b86` | image/png | `design-refine/after-workflow-light.png` |
| `8c29dc13bcfcb6ea54917e31d3855cb78ec3be9a` | image/png | `insights/insights-dark.png` |
| `82b9c6a146214960be19f0939a9196ecedb21982` | image/png | `insights/insights-light.png` |
| `45f9f3fec8e7891efa88e9f28eca17f79b30a1d0` | image/png | `insights/insights-round3-dark.png` |
| `7fa59b20e7189a955ec86c0995a2b30f14cf48d6` | image/png | `insights/insights-round3-light.png` |
| `ae63ddcb75b7031ada8e38bd34fa1b6679d0a45d` | image/png | `limits-cache/limits-cache-dark.png` |
| `239f7c01a191cbf2cea35cd8e6eb7f68ac1df819` | image/png | `limits-cache/limits-cache-light.png` |
| `7043b9edd322819e70a3213b833149ee98eedfb5` | image/png | `outcomes/outcomes-dark.png` |
| `71b1d3e1d83ff61c56e4510dca0a4e6b2a26fd4c` | image/png | `outcomes/outcomes-light.png` |
| `5f2669d56da3fb04a75d62fd0dc66b28c5d3ff30` | image/png | `pricing-api/costs-dark.png` |
| `4f42bbf2ccdb7b7d4da095602097ddecb09232f4` | image/png | `pricing-api/costs-light.png` |
| `d673698c9af25e6366f4102bffd6a0810cb5e431` | image/png | `pricing-api/pricing-dark.png` |
| `8758d5a5d0e28dfdd56175e2b1f653c21c8e6af7` | image/png | `pricing-api/pricing-light.png` |
| `ed8fce12e28e0845acc6ebb23bcfb69c3a16ade9` | image/png | `pricing-tools-activity-b3/after-activity-1440-dark.png` |
| `06f6126db276809e2d661c5b9ce0f5d26f3a2330` | image/png | `pricing-tools-activity-b3/after-activity-390-light.png` |
| `8c95da26695cd4428f22c80426d3a3a8c2d512f6` | image/png | `pricing-tools-activity-b3/after-activity-noproviders-1440-dark.png` |
| `580f5903551215c6b145d31ac70f9ce2cfc48528` | image/png | `pricing-tools-activity-b3/after-pricing-1440-light.png` |
| `60161b8f447d3017d72b1b5de1cfd0ad1e60d1af` | image/png | `pricing-tools-activity-b3/after-tools-1440-light.png` |
| `859b337a2290e00f8b4faa8ce68fbe6a09623428` | image/png | `pricing-tools-activity-b3/after-tools-390-light-ranking.png` |
| `b092cdbe4594a5f541e4876679530e412b64dd83` | image/png | `pricing-tools-activity-b3/after-tools-390-light.png` |
| `39a6a7cdc9ad5aae52b687b70cf1b5ab3da9529a` | image/png | `pricing-tools-activity-b3/before-activity-1440-dark.png` |
| `a6a43f5e642bcbe3cfd444fca69434877d250261` | image/png | `pricing-tools-activity-b3/before-activity-390-light.png` |
| `9113033dc2853af5667d437daab77fc2afdc7479` | image/png | `pricing-tools-activity-b3/before-activity-noproviders-1440-dark.png` |
| `96b8379db241fcd3b8f3b9c6382ba4f316c8ca9e` | image/png | `pricing-tools-activity-b3/before-pricing-1440-light.png` |
| `34e27fd6d2af58869f018630ad45da152a0e7739` | image/png | `pricing-tools-activity-b3/before-tools-1440-light.png` |
| `71f5031fbc028281a7d19b96829555481848f7c8` | image/png | `pricing-tools-activity-b3/before-tools-390-light-ranking.png` |
| `e926a14cd9cd21cfb6048e01087ff5d9c0d93910` | image/png | `pricing-tools-activity-b3/before-tools-390-light.png` |
| `b82794eb9a2f2b90ef7bfb4950e29df1b529ebd0` | image/png | `reliability/reliability-dark.png` |
| `25af6f590987b726c90e3cb9290c3e33d7751219` | image/png | `reliability/reliability-light.png` |
| `0f330ad4212563bc5c16e3a7660f93564b14f2cf` | image/png | `reliability/reliability-round2-dark.png` |
| `2a6f3d841d53690ea1c9b01aeb245d8972be1101` | image/png | `reliability/reliability-round2-light.png` |
| `8f01e7630ba2f88ffa1acd90d69f67efb5bd3092` | font/woff2 | `src/public/fonts/geist-latin.woff2` |
| `0750682c8dd850428e3394807cf40113e94f46ca` | font/woff2 | `skills/conductor-session-analytics/scripts/public/fonts/geist-mono-latin.woff2`<br>`skills/machine-session-analytics/scripts/public/fonts/geist-mono-latin.woff2`<br>`src/public/fonts/geist-mono-latin.woff2` |
| `937631c04e13b553685e00a617b8ea5bf61406f0` | font/woff2 | `src/public/fonts/inter-latin.woff2` |
| `5276eb7c153d64f1666b0173762a37c70bdd6351` | font/woff2 | `src/public/fonts/newsreader-italic-latin.woff2` |
| `8cd8effc477a72510cf1e0f8099a425dc87213cd` | font/woff2 | `src/public/fonts/newsreader-latin.woff2` |
| `0f3474ee8af2f8253225f3b41bf79be986a1ae13` | font/woff2 | `skills/conductor-session-analytics/scripts/public/fonts/space-grotesk-latin.woff2`<br>`skills/machine-session-analytics/scripts/public/fonts/space-grotesk-latin.woff2`<br>`src/public/fonts/space-grotesk-latin.woff2` |
| `1895829e8ea1d202d0de94a5600e5873a9a93776` | image/png | `theme-control/activity-900-light.png` |
| `b30f7e343c287a191c7d700e3906ef7753c612f2` | image/png | `theme-control/activity-dark.png` |
| `e50d9538152d396d9cbdff926a9f99c0e94a31d6` | image/png | `theme-control/activity-light.png` |
| `c7a8c6a1b9b6c567934df812778c191486e70714` | image/png | `theme-control/before/summary-light.png` |
| `5fc121055642055f358dd7d0064acb08f899c086` | image/png | `theme-control/costs-dark.png` |
| `5607915996041d691d2c8be5b168a6e601b8d4e1` | image/png | `theme-control/costs-light.png` |
| `239e006b5c853dc9b127b8fa7c2747dec52cb9f8` | image/png | `theme-control/distributions-dark.png` |
| `0faf871698b14d51911bf414e13ccc5940d701e1` | image/png | `theme-control/distributions-light.png` |
| `2a01d772b5c62dacb8f356e4bda3b8c8bbda22df` | image/png | `theme-control/help-dark.png` |
| `9d157eb95ef3258f0fd6079407fc95a868c4abaf` | image/png | `theme-control/models-dark.png` |
| `43dcae9666f39cdd76a587e07eebe0620bba5954` | image/png | `theme-control/models-light.png` |
| `945c186697d2769673be355ad70c7f831e34f5bb` | image/png | `theme-control/palette-dark.png` |
| `6754a1aadcb1d2ec070c1c3350797029b168721d` | image/png | `theme-control/palette-light.png` |
| `84d39b583dde4df150bebfa925626297017e5669` | image/png | `theme-control/skills-dark.png` |
| `dc6866327a384626100d726e6f5d18696067d2cb` | image/png | `theme-control/skills-light.png` |
| `01450ab75bb1838e7d3afa974bec5e7f76881724` | image/png | `theme-control/summary-30d-dark.png` |
| `ff776f1b409a4f60973ba4c46afdf95471ec4d2f` | image/png | `theme-control/summary-900-dark.png` |
| `48dc21830bbb326d608e8712e34164a2ca5dbcf0` | image/png | `theme-control/summary-comfortable-dark.png` |
| `ef7f5843f0ac53481c14f80dc497349e3a38fc6f` | image/png | `theme-control/summary-dark.png` |
| `419663cf01c337b0a403a0446394769dbb7c7f4e` | image/png | `theme-control/summary-empty-7d-dark.png` |
| `8d611f48dfec8f9e192db24577b87ceacfa20048` | image/png | `theme-control/summary-focus-light.png` |
| `f8b17947995167660d77346ba972ea64ea3fbc36` | image/png | `theme-control/summary-light.png` |
| `3292e635fe484363f2d39c9668257ae4bfafb2e7` | image/png | `theme-control/tools-dark.png` |
| `2c44fefc2dcd66be2e537efc5ec970d82f383ba2` | image/png | `theme-control/tools-light.png` |
| `a51218d1e21c1839a54debb8addea67bcfd13739` | image/png | `theme-ink/activity-dark.png` |
| `a1cd524ec0050cdebd5551366e0d9502ba166881` | image/png | `theme-ink/activity-light.png` |
| `866c411bded5b729f1372a08cea493d6562bc914` | image/png | `theme-ink/before/summary-light.png` |
| `332225c52e00a0cd9e11fdebff1f1a8b79f122d2` | image/png | `theme-ink/costs-dark.png` |
| `72e0cb91b6b09daff5c12c3fd92f5f7c2de2ab4b` | image/png | `theme-ink/costs-light.png` |
| `bb361bf84a8c10f20a23e604a41cd2137c059ad1` | image/png | `theme-ink/distributions-dark.png` |
| `8861f63935a683f7593882cd87d859e6492fd423` | image/png | `theme-ink/distributions-light.png` |
| `e24b1374d1488a4a20c237a077b82d74d5be9e88` | image/png | `theme-ink/hover-activity-dark.png` |
| `d2010eb592deb3cec15bbd24c3109cfe1b7f9087` | image/png | `theme-ink/hover-summary-dark.png` |
| `1ddb1eb252e7dc90ace4f679b14fba94e809c9f3` | image/png | `theme-ink/models-dark.png` |
| `dffa098348a825fb139df52d3c80ab2775f6ac06` | image/png | `theme-ink/models-light.png` |
| `743e1af1263bbe0819941e1c19ebed9cbad68267` | image/png | `theme-ink/narrow-activity-light.png` |
| `e9f89c72848d4c55460ecdb6983154ad785fd8e7` | image/png | `theme-ink/narrow-costs-dark.png` |
| `4249b3979a05202dbaded2a841f5e4dbb8a23a85` | image/png | `theme-ink/narrow-summary-dark.png` |
| `66a0b328414b93f7fed963f633d167b990396b17` | image/png | `theme-ink/narrow-tools-dark.png` |
| `89be20a540e7ebd2a0091ff93745d36b6d8268c4` | image/png | `theme-ink/repository-summary-dark.png` |
| `4127b1101ed35fecbda2fabb7e796976f9670ce5` | image/png | `theme-ink/repository-summary-light.png` |
| `0d2069691994d3bb294291790c8bf494f323015e` | image/png | `theme-ink/skills-dark.png` |
| `ad16bf6e961c7f53318f60a3b7f1637c40defae4` | image/png | `theme-ink/skills-light.png` |
| `ff8d99ac0c46985ea2830a6f237a0b7e15d897b3` | image/png | `theme-ink/state-empty-summary-light.png` |
| `64d9896d5f7cac76368c646ec298e96cc2c5cf8d` | image/png | `theme-ink/state-loading-summary-dark.png` |
| `f7698abfc41a9e20870b85b9126568ce6f6d0d2d` | image/png | `theme-ink/summary-dark.png` |
| `5e83aaeb644e1a319ea8f5b8db7c2e7599d38ffa` | image/png | `theme-ink/summary-light.png` |
| `ace86454a470b852f2f46cdb2e04ee9857cdbe69` | image/png | `theme-ink/tools-dark.png` |
| `cf6f50d0edcb8629804daab07e2edb761496e441` | image/png | `theme-ink/tools-light.png` |
| `f4a38f837f8943aa0cf01f729accfab0395b40ae` | image/png | `theme-paper/activity-dark.png` |
| `75a5780b0d093670f604f925a670769ca365cb4d` | image/png | `theme-paper/activity-light.png` |
| `62af609cbc96139b62745d7da3eafebdc7818e40` | image/png | `theme-paper/before/summary-light.png` |
| `12c37c05f6afc23ea5ed0d2c8828e0b6d5475bd4` | image/png | `theme-paper/costs-900-dark.png` |
| `7e15f47b92b2266578e8701705ad96f1d1b3c0fe` | image/png | `theme-paper/costs-dark.png` |
| `59be835e165dcc815b2cd0008788338f3184cef6` | image/png | `theme-paper/costs-light.png` |
| `21953ba79c5a7cf13902ba5cefe2fffb66799c35` | image/png | `theme-paper/distributions-dark.png` |
| `80585c316dfff5aa7b3a73ef5a2c211d6415cc11` | image/png | `theme-paper/distributions-light.png` |
| `e4e36389687bc16836cddd89f61be28d429a4ad2` | image/png | `theme-paper/models-dark.png` |
| `081c9809f026b8a63372857f3b8a1b097767b6b3` | image/png | `theme-paper/models-light.png` |
| `4440fb686e659ebd3a11246040f8b57d7bbef885` | image/png | `theme-paper/repository-dark.png` |
| `c4a0c92ecc3c6efce007da0e322f0c975b8d2dc2` | image/png | `theme-paper/repository-light.png` |
| `a45fc2ece745beb34869f234c15e5c8b612e8500` | image/png | `theme-paper/skills-dark.png` |
| `231baecebef84136be16bea5c7715d74ffad5e25` | image/png | `theme-paper/skills-light.png` |
| `5aeaa0c29ddb3fc8841576fd448b69016bd4b797` | image/png | `theme-paper/summary-900-light.png` |
| `82c4b5c6d2669601905576ba3474d30125f53eca` | image/png | `theme-paper/summary-dark.png` |
| `5a8531bf4b5bdcc288d888146ae516eebe9d7ab5` | image/png | `theme-paper/summary-light.png` |
| `63e3a77ab6587979d29ea073d1240091eddcf8ff` | image/png | `theme-paper/tools-900-light.png` |
| `9bfd632eb3e750da49f6d004a27e16bf3ceae4fd` | image/png | `theme-paper/tools-dark.png` |
| `903f9133968e0dcd04e379b4510837df54613314` | image/png | `theme-paper/tools-light.png` |
| `55ade5a87fa2156335eda634c61f54e40878987b` | image/png | `velocity-costs-b2/after-1-velocity-1440-light.png` |
| `381ba279aa9f945b26dfc30bec2fd6422173c34d` | image/png | `velocity-costs-b2/after-2-velocity-model-lines-light.png` |
| `2b4f409c4302cec4c774ebdb4839e7dc27c37df5` | image/png | `velocity-costs-b2/after-3-velocity-agent-stacked-dark.png` |
| `6103007b6155177fd712b0f5be6b5b0a2bb132b8` | image/png | `velocity-costs-b2/after-4-costs-1440-light.png` |
| `682d722c341c670edac3da42e2e2dc6a4c814a49` | image/png | `velocity-costs-b2/after-5-costs-bars-1440-dark.png` |
| `03c85cdd79fff0998a040cb6efe7e9382ed065f6` | image/png | `velocity-costs-b2/after-6-velocity-chart-390-light.png` |
| `7ceb3081b99e1a7e5167a954720dae534094e70a` | image/png | `velocity-costs-b2/after-7-costs-bars-390-dark.png` |
| `787e7a949e414159338d13f598d45237f502d7e3` | image/png | `velocity-costs-b2/after-8-summary-daily-1440-light.png` |
| `a92a64e4d79bfd8a0ac018c951590768d50f8f6c` | image/png | `velocity-costs-b2/after-9-velocity-1024-light.png` |
| `927ac114c3de0ca546cebd844130917d9bdc52a2` | image/png | `velocity-costs-b2/before-1-velocity-1440-light.png` |
| `dabccbc6d3c61224b09055cf1c5e925987297d86` | image/png | `velocity-costs-b2/before-2-velocity-model-lines-light.png` |
| `14b9a3e11497deaba1fc4b2d39a1755e4abbd3bf` | image/png | `velocity-costs-b2/before-3-velocity-agent-stacked-dark.png` |
| `3c483ddb34430535e82073631f695550579e572e` | image/png | `velocity-costs-b2/before-4-costs-1440-light.png` |
| `425a116f0f1f0090d0144b598444d92985f1f245` | image/png | `velocity-costs-b2/before-5-costs-bars-1440-dark.png` |
| `c58aa8a64dcf322cd20da119063f1ac9fee07f9b` | image/png | `velocity-costs-b2/before-6-velocity-chart-390-light.png` |
| `48debc0de7c67fd1fcb99f95ff22596f9808fa33` | image/png | `velocity-costs-b2/before-7-costs-bars-390-dark.png` |
| `3fbb145289a63d42f2900a3f99f85fa2b3ce2c4e` | image/png | `velocity-costs-b2/before-8-summary-daily-1440-light.png` |
| `84bb917e11d9b1976ba48cc97fbced03ad77c04e` | image/png | `velocity-costs-b2/before-9-velocity-1024-light.png` |
| `35bf8c9c200fa3a2f6c14b0e3cf0b2508b17cbbe` | image/png | `velocity/summary-dark.png` |
| `e0bbc1cf556b686031a78840660a5a737c937048` | image/png | `velocity/summary-light.png` |
| `b7bb456b32dbfe54f0f8dddc34258dcabf8c3978` | image/png | `velocity/velocity-dark.png` |
| `33ab175b6e272221e51d9a98bbc4814bcb83b47e` | image/png | `velocity/velocity-light.png` |
| `3327b1c723efbfbcc47678091029141c58849122` | image/png | `velocity/velocity-round2-dark.png` |
| `4b0b6a6d25bb4fb593afa7bd846bef43983a711b` | image/png | `velocity/velocity-round2-light.png` |
| `8bdd824fddc6633442aedcfa74352ccc49757f93` | image/png | `visual-system-a3-v2/after-1-summary-1440-light.png` |
| `91aed9c0e56dc74163607b4980b48045118a0306` | image/png | `visual-system-a3-v2/after-10-pricing-1440-light.png` |
| `42ef612c3349ba0d54715d615cd0d00b3f1ca9ac` | image/png | `visual-system-a3-v2/after-11-initial-load-failed-1440-light.png`<br>`visual-system-a3-v3/after-11-initial-load-failed-1440-light.png` |
| `3e55558be1907680418687d327e45adf5cfe9964` | image/png | `visual-system-a3-v2/after-12-loading-1440-light.png` |
| `811d0621fd508fddcce27bde8b8bf650355d05a8` | image/png | `visual-system-a3-v2/after-13-touch-390-light.png` |
| `ed807205e13ee3f4140fc575468eee0690199f23` | image/png | `visual-system-a3-v2/after-2-summary-1440-dark.png` |
| `d2a3f38e419c468349b4b027e50e6cfa2c2d5984` | image/png | `visual-system-a3-v2/after-3-velocity-390-light.png` |
| `962ce61c6ebe17f36b719c69cb804b7688191f74` | image/png | `visual-system-a3-v2/after-4-summary-chart-390-light.png` |
| `49b0b589d6f89a6e274193c3aa4872e1a42a6a0e` | image/png | `visual-system-a3-v2/after-5-costs-bars-390-light.png` |
| `e22527ccc7eb529393496f1b28643a607cf86a97` | image/png | `visual-system-a3-v2/after-6-coverage-390-dark.png`<br>`visual-system-a3-v3/after-6-coverage-390-dark.png` |
| `035d9806e457481a34395a0612fcc013a8ca5cb9` | image/png | `visual-system-a3-v2/after-7-coverage-1440-light.png` |
| `fb4d0d8fe9dfc12d961be902a323c9670e27a63d` | image/png | `visual-system-a3-v2/after-8-custom-window-1024-light.png` |
| `e67c628cbc9a09b95b4eca5a659c7d33786f96cc` | image/png | `visual-system-a3-v2/after-9-error-1440-dark.png` |
| `43b436fd3eea9b976466283c9420fee69a2d5fd2` | image/png | `visual-system-a3-v2/before-1-summary-1440-light.png` |
| `571cdcaf2b69597f508f2a0c3bd28e75e30ec9ea` | image/png | `visual-system-a3-v2/before-10-pricing-1440-light.png` |
| `79ce57ec27162063924c9b184e3a65c33c9c264f` | image/png | `visual-system-a3-v2/before-2-summary-1440-dark.png` |
| `e765f760c275953e1c5f409d34451ee9b3d5d03d` | image/png | `visual-system-a3-v2/before-3-velocity-390-light.png` |
| `8bf12497c1c697410f3da11af9c22ce5ba909776` | image/png | `visual-system-a3-v2/before-4-summary-chart-390-light.png`<br>`visual-system-a3/before-4-summary-chart-390-light.png` |
| `fcd02eb5bc764c2d19ff2a9034c3b5519dcced63` | image/png | `visual-system-a3-v2/before-5-costs-bars-390-light.png`<br>`visual-system-a3/before-5-costs-bars-390-light.png` |
| `3d6c43aec6fcadb050574e29b43832143b142d30` | image/png | `visual-system-a3-v2/before-6-coverage-390-dark.png` |
| `69dbcb28220ccbacc875d2623f29ffc7139aa032` | image/png | `visual-system-a3-v2/before-7-coverage-1440-light.png`<br>`visual-system-a3/before-7-coverage-1440-light.png` |
| `e81787b9341576d78eae1bf5f697bc9fb6bec55b` | image/png | `visual-system-a3-v2/before-8-custom-window-1024-light.png` |
| `5b3bb903f0c531cb855a7fe5a196de3227830a94` | image/png | `visual-system-a3-v2/before-9-error-1440-dark.png` |
| `0bd18daf3254dd381b8a95a2201620ad983b7829` | image/png | `visual-system-a3-v3/after-1-summary-1440-light.png` |
| `5be197412234fdb95b03b7501df3ee04df31ddc6` | image/png | `visual-system-a3-v3/after-10-pricing-1440-light.png` |
| `a64f3d732996304900d0b622e1e9a4d2770c515d` | image/png | `visual-system-a3-v3/after-12-loading-1440-light.png` |
| `fc6d09ca9b196ca5129a105b8919f762821086e9` | image/png | `visual-system-a3-v3/after-13-touch-390-light.png` |
| `d693907f446f3cb43a1b58404d84d1b8996764c6` | image/png | `visual-system-a3-v3/after-14-costs-total-1440-light.png` |
| `d8b4dd0fffe98083afa38775c8a0d102a4489fa1` | image/png | `visual-system-a3-v3/after-2-summary-1440-dark.png` |
| `bdb22fa6f6790a835764cb796c9fda752d06b5dc` | image/png | `visual-system-a3-v3/after-3-velocity-390-light.png` |
| `3ffc8bc7f84191c9af7d5fef1c0250bad895fa45` | image/png | `visual-system-a3-v3/after-4-summary-chart-390-light.png` |
| `3d421e1b0672fba28174d1e4b2bafa8f5e85dd59` | image/png | `visual-system-a3-v3/after-5-costs-bars-390-light.png` |
| `85df5242efee00ca8cfc25071f533eb3b7b746cd` | image/png | `visual-system-a3-v3/after-7-coverage-1440-light.png` |
| `eff11c1002fb76dae145e6d8a337bfcbbd9168fd` | image/png | `visual-system-a3-v3/after-8-custom-window-1024-light.png` |
| `379cdd3dbd1b2d829b5abc3e50533298b024f39e` | image/png | `visual-system-a3-v3/after-9-error-1440-dark.png` |
| `13d7f251477d6c46a53aa67c199fa47729eb0a83` | image/png | `visual-system-a3-v3/before-1-summary-1440-light.png` |
| `089230912261541a8493c15343159d5d906d1653` | image/png | `visual-system-a3-v3/before-10-pricing-1440-light.png` |
| `16f496d7fc5e60f359356837621e087e0ddd962b` | image/png | `visual-system-a3-v3/before-2-summary-1440-dark.png` |
| `fa3f1e540d0495c974f68ed2d014bfd343c4019f` | image/png | `visual-system-a3-v3/before-3-velocity-390-light.png` |
| `0c5f5aa379141acf2b575e0ac574027d98a6dd1d` | image/png | `visual-system-a3-v3/before-4-summary-chart-390-light.png` |
| `0c332637e98876c583f490ac156413b58f0fb1bd` | image/png | `visual-system-a3-v3/before-5-costs-bars-390-light.png` |
| `bdda1c9776870923631a867d5cf781f531284620` | image/png | `visual-system-a3-v3/before-6-coverage-390-dark.png` |
| `aa0cad215b0906ddeb828ce8220660302db65871` | image/png | `visual-system-a3-v3/before-7-coverage-1440-light.png` |
| `045af0b7e715e958b7bbc219ae58f3fcdc1038be` | image/png | `visual-system-a3-v3/before-8-custom-window-1024-light.png` |
| `f0b91de740a3cc5721d3b92d290a96559e17cc20` | image/png | `visual-system-a3-v3/before-9-error-1440-dark.png` |
| `4cd78a2095d939f3ba09615b0c98efb67fbc6d2d` | image/png | `visual-system-a3/after-1-summary-1440-light.png` |
| `ced05ddc1a4f51c9432353d16e6c14b576017300` | image/png | `visual-system-a3/after-10-pricing-1440-light.png` |
| `3c2b2192afb753fe31cc487d430fedfdc6562d4a` | image/png | `visual-system-a3/after-11-error-retry-slot-1440-light.png` |
| `a1377c4c05e41016016a46764d8fdf3fc411ea7d` | image/png | `visual-system-a3/after-12-loading-1440-light.png` |
| `f05e210b5f73ccf5cc44a0743d647a23dffb2233` | image/png | `visual-system-a3/after-13-touch-390-light.png` |
| `122abf9cd3bcfca15e9a97a000cbb3d4a6ecc57e` | image/png | `visual-system-a3/after-2-summary-1440-dark.png` |
| `67b46a50f514b361b83943fdf7a6a2b2a5cd004d` | image/png | `visual-system-a3/after-3-velocity-390-light.png` |
| `3fca8b62932b3167f4c580b1d1a95f7ce9b777cf` | image/png | `visual-system-a3/after-4-summary-chart-390-light.png` |
| `b65a3753d13f2a873700aafc76d5a7bd496193fb` | image/png | `visual-system-a3/after-5-costs-bars-390-light.png` |
| `54b680bece37412c9f2641a0c7e42f3c7409d44c` | image/png | `visual-system-a3/after-6-coverage-390-dark.png` |
| `0dc97f503221075c087138c1ed8b1e53e2b49335` | image/png | `visual-system-a3/after-7-coverage-1440-light.png` |
| `c82e519669d0d20702c0ccef6dbafdb4ee035955` | image/png | `visual-system-a3/after-8-custom-window-1024-light.png` |
| `0ede2918a8834666d6281983d5bc72ba7f94c4f7` | image/png | `visual-system-a3/after-9-error-1440-dark.png` |
| `fafb88a71837ef88a73048754262013b144e186d` | image/png | `visual-system-a3/before-1-summary-1440-light.png` |
| `4c263a477065497234dabb5e8f60560527eccecc` | image/png | `visual-system-a3/before-10-pricing-1440-light.png` |
| `cb20ff7e7ae02aa2e3d33928aba09cd48c01d09f` | image/png | `visual-system-a3/before-2-summary-1440-dark.png` |
| `c515ab2c4562dc952c71988bf356e3146242f6d4` | image/png | `visual-system-a3/before-3-velocity-390-light.png` |
| `5b2beb8ce4559b9545b0e382d1df1881f2d2197c` | image/png | `visual-system-a3/before-6-coverage-390-dark.png` |
| `695c208de286b58936ca1f3f0272ec973f5be2c3` | image/png | `visual-system-a3/before-8-custom-window-1024-light.png` |
| `d099dfcca3f4c15ed8550bc0217a56ed6af7ddd2` | image/png | `visual-system-a3/before-9-error-1440-dark.png` |

</details>
