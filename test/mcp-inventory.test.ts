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
    assert.deepEqual(inventory[1]!.skills, ["linked-skill", "system-skill"]);
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
