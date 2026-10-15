// Shared by test/machines.test.ts and the installed-package smoke (scripts/smoke-installed.ts).
/**
 * A stand-in for `ssh` that runs the remote words on this machine the way sshd does: through pipes
 * it owns, so killing it closes the "channel". Each destination and account gets its own HOME,
 * machine ID and account list; `sudo -n -iu NAME` switches HOME, and the named failures mimic real ones.
 * It needs FAKE_SSH_LOG (one JSON line per call), FAKE_SSH_HOMES and FAKE_SSH_ENVS (extra environment by destination).
 */
export const fakeSsh = `#!/usr/bin/env node
const { spawn } = require("node:child_process");
const { appendFileSync, mkdirSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2), at = args.indexOf("--");
let [destination, ...words] = args.slice(at + 1);
appendFileSync(process.env.FAKE_SSH_LOG, JSON.stringify({ destination, words: words.filter((word) => word.length < 80).slice(0, 12) }) + "\\n");
const fail = (code, text) => { if (text) process.stderr.write(text + "\\n"); process.exit(code); };
const listed = (name) => (process.env[name] || "").split(",").includes(destination);
if (destination === "down" || listed("FAKE_SSH_DOWN")) fail(255, "ssh: connect to host " + destination + " port 22: Connection refused");
if (destination === "dropped") fail(255);
// "shared" logs in only through a ControlMaster someone else opened.
if (args.includes("-O")) process.exit(destination === "shared" ? 0 : 255);
if (destination === "shared" && args.includes("ControlPath=none")) fail(255, "fake@shared: Permission denied (publickey).");
// "helper" leaves a process holding ssh's stdout and stderr, as a ProxyCommand that backgrounds can.
if (destination === "helper") spawn(process.execPath, ["-e", "setTimeout(() => {}, 20000)", "fake-ssh-helper"], { stdio: ["ignore", "inherit", "inherit"], detached: true }).unref();
const machine = join(process.env.FAKE_SSH_HOMES, destination);
let account = "ssh-user", login = true;
if (words[0] === "sudo") {
  const flag = words.findIndex((word) => word === "-iu" || word === "-u");
  login = words[flag] === "-iu"; account = words[flag + 1]; words = words.slice(flag + 2);
  if (account === "locked") fail(1, "sudo: a password is required");
  if (account === "ghost") fail(1, "sudo: unknown user ghost");
  // A service account: its login shell is nologin.
  if (account === "svc" && login) { process.stdout.write("This account is currently not available.\\n"); process.exit(1); }
}
const home = join(machine, account);
mkdirSync(home, { recursive: true });
writeFileSync(join(machine, "machine-id"), "id-" + destination.replace(/-again$/, "") + "\\n");
writeFileSync(join(machine, "passwd"), ["root:x:0:0::" + join(machine, "root") + ":/bin/bash", "daemon:x:1:1::/usr/sbin:/usr/sbin/nologin", "agents:x:995:995::" + join(machine, "agents") + ":/bin/bash", "svc:x:990:990::" + join(machine, "svc") + ":/usr/sbin/nologin", "ssh-user:x:1000:1000::" + join(machine, "ssh-user") + ":/bin/bash"].join("\\n") + "\\n");
mkdirSync(join(machine, "agents", ".claude"), { recursive: true });
mkdirSync(join(machine, "svc", ".codex"), { recursive: true });
const env = { ...process.env, HOME: home, SESSION_ANALYTICS_MACHINE_ID: "id-" + destination.replace(/-again$/, ""), ...(JSON.parse(process.env.FAKE_SSH_ENVS)[destination] || {}) };
delete env.XDG_CACHE_HOME;
// "hostonly-*" machines have no machine ID, and clones share one host name.
const hostOnly = destination.startsWith("hostonly");
if (hostOnly) delete env.SESSION_ANALYTICS_MACHINE_ID;
if (listed("FAKE_SSH_HANG")) env.NODE_OPTIONS = "--require " + process.env.FAKE_SSH_HANG_SCRIPT;
if (words[0] === "true") process.exit(0);
// A login profile that prints, as some do.
if (destination === "chatty") process.stdout.write("Welcome to chatty!\\n");
let program = words[0], programArgs = words.slice(1);
if (program === "node") {
  if (destination === "nonode") fail(127, "-bash: line 1: node: command not found");
  program = process.execPath;
  if (destination === "oldnode") programArgs = ["--require", process.env.FAKE_SSH_OLD_NODE, ...programArgs];
} else if (program === "session-analytics") { program = process.execPath; programArgs = [process.env.FAKE_SSH_BIN, ...programArgs]; }
else if (program !== "sh") fail(127, "-bash: line 1: " + program + ": command not found");
const child = spawn(program, programArgs, { env, stdio: ["pipe", "pipe", "pipe"] });
child.stdin.on("error", () => {});
if (program === "sh") {
  let script = "";
  process.stdin.on("data", (chunk) => { script += chunk; }).on("end", () => child.stdin.end(script
    .replaceAll("/etc/machine-id", hostOnly ? join(machine, "no-machine-id") : join(machine, "machine-id"))
    .replaceAll("/var/lib/dbus/machine-id", join(machine, "no-machine-id"))
    .replaceAll("/usr/sbin/ioreg", "false")
    .replaceAll("$(hostname)", hostOnly ? "clone" : "$(hostname)")
    .replace("\\nid -un\\n", "\\necho " + account + "\\n")
    .replace("\\nid -u\\n", "\\necho " + [...account].reduce((sum, letter) => sum + letter.charCodeAt(0), 1000) + "\\n")
    .replaceAll("command -v node", destination === "nonode" ? "command -v sa-no-such-node" : "command -v node")
    .replace("getent passwd", "cat " + join(machine, "passwd"))
    .replace("sudo -n true", "true")
    .replaceAll("sudo -n test -d", "test -d")));
} else process.stdin.pipe(child.stdin);
child.stdout.pipe(process.stdout);
child.stderr.pipe(process.stderr);
child.on("close", (code) => process.exit(code === null ? 255 : code));
`;
