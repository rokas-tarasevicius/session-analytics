# Documentation diagrams

These diagrams use the `fluxary-diagram` skill and renderer from
`rokas-tarasevicius/fluxary-os`, revision
`d96e453ffb9ae8bd300e926db8fc61ec9c185e95`.

| Document | Used in |
| --- | --- |
| [Overview](overview.diagram.json) | [Project README](../../README.md#how-it-works) |
| [Process model](process-model.diagram.json) | [Architecture](../architecture.md#process-model) |
| [Proposed execution links](proposed-execution-links.diagram.json) | [Event-model proposal](../proposals/schema-v2.md) |
| [Proposed session evidence](proposed-session-evidence.diagram.json) | [Event-model proposal](../proposals/schema-v2.md) |
| [Dashboard and docs changes](changes/fluxary-dashboard.diagram.json) | Pull request change diagram |

Edit the `.diagram.json` documents, then regenerate both SVGs. The proposal diagrams describe future work, not the shipped schema.

From this repository, with Bun and a checkout of the Fluxary revision above:

```bash
FLUXARY_OS=/path/to/fluxary-os
cat "$FLUXARY_OS/.claude/skills/fluxary-diagram/SKILL.md"
bun "$FLUXARY_OS/diagrams/render.ts" docs/diagrams/*.diagram.json
bun "$FLUXARY_OS/diagrams/render.ts" check docs/diagrams/*.diagram.json
bun "$FLUXARY_OS/diagrams/render.ts" docs/diagrams/changes/*.diagram.json
bun "$FLUXARY_OS/diagrams/render.ts" check docs/diagrams/changes/*.diagram.json
```

The check validates layout and compares both SVGs with a fresh render. Keep the JSON and light/dark SVGs together; do not edit generated SVGs. Rendering requires the other checkout; viewing the committed images requires no tooling.

The SVGs embed Geist and Geist Mono, copyright 2024 The Geist Project Authors, under the [SIL Open Font License 1.1](../../src/public/fonts/OFL-1.1.txt). Generic icons come from Fluxary's diagram catalogue. The Cursor logo comes from Simple Icons 16.35.0 (CC0 1.0); it identifies the Cursor parser and remains a trademark of its owner.
