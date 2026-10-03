import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { launchProjectDirectory, readInventory, tomlServerNames } from "../src/mcp/inventory.ts";

test("names-only TOML scanner recognizes quoted keys without interpreting commands or multiline content", () => {
  const text = [
    "[mcp_servers.fixture]", 'command = "SECRET_COMMAND"', "[mcp_servers.fixture.env]", 'SECRET_ENV = "SECRET_VALUE"',
    '[mcp_servers."quoted.server"] # harmless comment', "[mcp_servers.'single-server']", 'command = "SECRET_COMMAND"',
    'description = """', "[mcp_servers.SECRET_MULTILINE]", '"""',
    "description = '''", "[mcp_servers.SECRET_LITERAL]", "'''", "# [mcp_servers.SECRET_COMMENT]",
    '[mcp_servers."/SECRET_PATH"]', '[mcp_servers."bad name"]', '["mcp_servers"."escaped\\u002dserver"]',
  ].join("\n");
  const names = tomlServerNames(text);
  assert.deepEqual(names, ["escaped-server", "fixture", "quoted.server", "single-server"]);
  assert.doesNotMatch(JSON.stringify(names), /SECRET_|command/);
});

test("TOML escaped multiline delimiters and quote runs keep content out of inventory", () => {
  for (const quoteRun of ['\\"""', '"\\""', '""\\"', '\\\\\\"""']) {
    const text = ['description = """', quoteRun, '[mcp_servers.SECRET_CONTENT]', '"""', '[mcp_servers.real]'].join("\n");
    assert.deepEqual(tomlServerNames(text), ["real"]);
  }
  for (const quotes of ['"', "'"]) for (const run of [3, 4, 5]) {
    const text = `description = ${quotes.repeat(3)}\n[mcp_servers.SECRET_CONTENT]\n${quotes.repeat(run)}\n[mcp_servers.real]`;
    assert.deepEqual(tomlServerNames(text), ["real"]);
  }
  for (const text of ['[mcp_servers.before]\ndescription = "unterminated\n[mcp_servers.SECRET_CONTENT]',
    '[mcp_servers.before]\ndescription = """unterminated',
    '[mcp_servers.before]\ndescription = """bad\\q\n"""\n[mcp_servers.SECRET_CONTENT]',
    '[mcp_servers.before]\ndescription = """bad""""""\n[mcp_servers.SECRET_CONTENT]']) {
    assert.throws(() => tomlServerNames(text), /Inventory source unavailable/);
  }
});

test("skill inventory resolves frontmatter and canonical aliases without reading names from prose", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-skill-identity-"));
  try {
    const skills = join(root, ".claude/skills");
    await mkdir(join(skills, "release-review"), { recursive: true });
    await writeFile(join(skills, "release-review/SKILL.md"), '---\nname: review\ndescription: |\n  name: SECRET_DESCRIPTION\n---\nname: SECRET_BODY\n');
    await symlink(join(skills, "release-review"), join(skills, "alias-review"));
    await mkdir(join(skills, "ambiguous"));
    await writeFile(join(skills, "ambiguous/SKILL.md"), '---\nname: |\n  SECRET_NAME_CONTENT\n---\nSECRET_BODY');
    const unsupported = [
      '---\ndescription: "unterminated\nname: SECRET_DESCRIPTION\n"\n---\nSECRET_BODY',
      '---\nname: review\n  SECRET_CONTINUATION\n---',
      '---\n  name: SECRET_INDENTED_ROOT\n---',
      '---\nname: first\nname: SECRET_DUPLICATE\n---',
      '---\ndescription: ' + 'x'.repeat(16_384) + '\nname: SECRET_OVERSIZE\n---',
    ];
    for (const [index, content] of unsupported.entries()) {
      await mkdir(join(skills, `unsupported-${index}`));
      await writeFile(join(skills, `unsupported-${index}/SKILL.md`), content);
    }
    const inventory = await readInventory({ mcpCwd: root }, {}, root);
    const claude = inventory[0]!;
    assert.deepEqual(claude.skills, ["review"]);
    assert.deepEqual(claude.skillIdentities, [{ name: "review", aliases: ["alias-review", "release-review", "review"] }]);
    assert.equal(claude.unresolvedSkills, 1 + unsupported.length);
    assert.doesNotMatch(JSON.stringify(inventory), /SECRET_|SKILL\.md/);
    assert.ok(!JSON.stringify(inventory).includes(root));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("inventory handles profiles, project scope, symlinked skills, malformed sources and bounded names", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inventory-"));
  try {
    const fakeHome = join(root, "home"), project = join(root, "project"), nested = join(project, "src");
    await mkdir(join(project, ".git"), { recursive: true }); await mkdir(nested);
    assert.equal(await launchProjectDirectory(nested), project);
    await mkdir(join(fakeHome, ".claude/skills/fixture-skill"), { recursive: true });
    await writeFile(join(fakeHome, ".claude/skills/fixture-skill/SKILL.md"), "SECRET_SKILL_BODY");
    await mkdir(join(fakeHome, ".codex/skills/.system/system-skill"), { recursive: true });
    await writeFile(join(fakeHome, ".codex/skills/.system/system-skill/SKILL.md"), "SECRET_SYSTEM_BODY");
    await mkdir(join(fakeHome, ".agents/skills"), { recursive: true });
    await symlink(join(fakeHome, ".claude/skills/fixture-skill"), join(fakeHome, ".agents/skills/linked-skill"));
    await symlink(join(fakeHome, ".codex"), join(fakeHome, ".codex-alias"));
    await writeFile(join(fakeHome, ".codex/config.toml"), '[mcp_servers.fixture-codex]\ncommand = "SECRET_COMMAND"\n');
    await writeFile(join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { "global-server": { command: "SECRET_COMMAND" } },
      projects: { [project]: { mcpServers: { "project-server": { env: { API_KEY: "SECRET_CREDENTIAL" } } } }, "/SECRET_OTHER_PROJECT": { mcpServers: { "unrelated-server": { command: "hidden" } } } } }));
    await writeFile(join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "local-server": { url: "https://SECRET_REMOTE.invalid" }, "/SECRET_PATH": { command: "never" } } }));
    await mkdir(join(fakeHome, ".cursor"), { recursive: true });
    await writeFile(join(fakeHome, ".cursor/mcp.json"), "SECRET_MALFORMED_JSON");
    await mkdir(join(project, ".cursor"), { recursive: true });
    await writeFile(join(project, ".cursor/mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(Array.from({ length: 520 }, (_, i) => [`server-${i}`, { command: "SECRET_COMMAND" }])) }));
    const inventory = await readInventory({ mcpCwd: nested }, {}, fakeHome);
    assert.deepEqual(inventory[0]!.skills, ["fixture-skill"]);
    assert.deepEqual(inventory[0]!.mcpServers, ["global-server", "local-server", "project-server"]);
    assert.deepEqual(inventory[1]!.skills, ["fixture-skill", "system-skill"]);
    assert.deepEqual(inventory[1]!.mcpServers, ["fixture-codex"]);
    assert.equal(inventory[1]!.sourcesRead, 4); // shared skills, profile skills, system skills, config; alias deduplicates.
    assert.equal(inventory[2]!.unreadableSources, 1);
    assert.equal(inventory[2]!.mcpServers.length, 512); assert.equal(inventory[2]!.truncated, true);
    assert.doesNotMatch(JSON.stringify(inventory), /SECRET_|unrelated-server/);
    assert.ok(!JSON.stringify(inventory).includes(root));
  } finally { await rm(root, { force: true, recursive: true }); }
});

test("explicit provider roots isolate inventory and oversized configuration is rejected safely", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-inventory-isolated-"));
  try {
    const fakeHome = join(root, "home"), project = join(root, "project"), profile = join(root, "isolated");
    await mkdir(project); await mkdir(profile); await mkdir(fakeHome);
    await mkdir(join(fakeHome, ".claude/skills/should-not-be-read"), { recursive: true });
    await writeFile(join(fakeHome, ".claude/skills/should-not-be-read/SKILL.md"), "SECRET_BODY");
    await writeFile(join(fakeHome, ".claude.json"), JSON.stringify({ mcpServers: { "should-not-be-read": {} } }));
    await writeFile(join(profile, "config.toml"), "SECRET_OVERSIZE".repeat(100_000));
    const inventory = await readInventory({ mcpCwd: project, claudeRoot: join(profile, "projects"), codexRoot: join(profile, "sessions"), cursorDatabasePath: join(profile, "cursor.db") }, {}, fakeHome);
    assert.deepEqual(inventory[0]!.skills, []); assert.deepEqual(inventory[0]!.mcpServers, []);
    assert.equal(inventory[1]!.unreadableSources, 1);
    assert.doesNotMatch(JSON.stringify(inventory), /SECRET_|should-not-be-read/);
  } finally { await rm(root, { force: true, recursive: true }); }
});
