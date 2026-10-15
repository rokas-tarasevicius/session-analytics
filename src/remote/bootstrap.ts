/**
 * The remote bootstrap, protocol sa1: plain old JavaScript sent on ssh stdin to the remote node, never run here.
 * It is a string in a module, not a file read from disk, so every install carries it, compiled or not.
 */
export const bootstrap = String.raw`// session-analytics remote bootstrap, protocol sa1. Sent on ssh stdin to node -; never imported.
// Old syntax on purpose: any Node must parse this far enough to say it is too old.
// argv: sa1 run|install VERSION DIGEST [report arguments...]. Exit codes: 75 need-runtime,
// 78 node-too-old, 79 bad-request, 80 cache-unwritable, 81 digest-mismatch; otherwise the runtime's own.
(function () {
  var fs = require("fs"), path = require("path"), os = require("os"), crypto = require("crypto"), zlib = require("zlib"), childProcess = require("child_process");

  function fail(code, text) {
    try { fs.writeSync(2, "sa1: " + text + "\n"); } catch (error) { /* stderr is gone too */ }
    process.exit(code);
  }

  if (parseInt(process.version.slice(1), 10) < 24) fail(78, "node-too-old " + process.version);

  var args = process.argv.slice(2), mode = args[1], version = args[2], digest = args[3], rest = args.slice(4);
  if (args[0] !== "sa1" || (mode !== "run" && mode !== "install") || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version || "") || !/^[0-9a-f]{64}$/.test(digest || "")) fail(79, "bad-request");

  var cache = process.env.XDG_CACHE_HOME && path.isAbsolute(process.env.XDG_CACHE_HOME) ? process.env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
  var root = path.join(cache, "session-analytics", "runtime");
  var name = version + "-" + digest.slice(0, 16);
  var directory = path.join(root, name);
  var allowed = /^(?:package\.json|(?:bin|src|data|schemas)(?:\/[A-Za-z0-9_@+-][A-Za-z0-9._@+-]*)+)$/;
  var uid = process.getuid ? process.getuid() : -1;

  function unsafe(target) {
    var error = new Error("unsafe");
    error.code = "not-private " + target;
    return error;
  }

  // Group write is private too when the group is this account's own and no one else's, as with a user private group.
  function ownGroup(stats) {
    if (!process.getgid || stats.uid !== uid || stats.gid !== process.getgid()) return false;
    try {
      var user = os.userInfo().username;
      return fs.readFileSync("/etc/group", "utf8").split("\n").some(function (line) {
        var fields = line.split(":");
        return fields[0] === user && fields[2] === String(stats.gid) && (fields[3] || "").split(",").every(function (member) { return !member || member === user; });
      });
    } catch (error) { return false; }
  }

  // Only this account may change what runs between verification and start, as with OpenSSH's StrictModes: every
  // directory above the runtime belongs to it or root and is writable by no one else unless sticky, and the
  // runtime directories are its own and not links. One that others could write to is emptied, never trusted.
  function secure() {
    fs.mkdirSync(root, { recursive: true, mode: 448 });
    for (var current = fs.realpathSync(cache); ; current = path.dirname(current)) {
      var stats = fs.statSync(current);
      if ((uid >= 0 && stats.uid !== uid && stats.uid !== 0) || (!(stats.mode & 512) && ((stats.mode & 2) || ((stats.mode & 16) && !ownGroup(stats))))) throw unsafe(current);
      if (path.dirname(current) === current) break;
    }
    [path.dirname(root), root, directory].forEach(function (target) {
      var stats;
      try { stats = fs.lstatSync(target); } catch (error) { if (target === directory && error.code === "ENOENT") return; throw error; }
      var own = stats.isDirectory() && (uid < 0 || stats.uid === uid);
      if (!own && target !== directory) throw unsafe(target);
      if (!own || (stats.mode & 18)) {
        fs.rmSync(target, { recursive: true, force: true });
        if (target !== directory) fs.mkdirSync(root, { recursive: true, mode: 448 });
      } else if (stats.mode & 63) fs.chmodSync(target, 448);
    });
  }

  // The digest covers every file in path order as path NUL size NUL bytes, like the sender's.
  function manifestDigest(entries, read) {
    var hash = crypto.createHash("sha256");
    for (var index = 0; index < entries.length; index++) {
      hash.update(entries[index][0] + "\0" + entries[index][1] + "\0");
      hash.update(read(index));
    }
    return hash.digest("hex");
  }

  // The manifest of a complete runtime that matches the digest, or null.
  function verified(target) {
    try {
      if (fs.readFileSync(path.join(target, ".complete"), "utf8") !== digest) return null;
      var entries = JSON.parse(fs.readFileSync(path.join(target, ".manifest"), "utf8"));
      return manifestDigest(entries, function (index) {
        var bytes = fs.readFileSync(path.join(target, entries[index][0]));
        if (bytes.length !== entries[index][1]) throw new Error("size");
        return bytes;
      }) === digest ? entries : null;
    } catch (error) { return null; }
  }

  function install() {
    var payload;
    if (typeof globalThis.SA_RUNTIME !== "string") fail(79, "bad-request");
    try { payload = zlib.gunzipSync(Buffer.from(globalThis.SA_RUNTIME, "base64")); } catch (error) { fail(81, "digest-mismatch"); }
    var newline = payload.indexOf(10), entries, offsets = [], offset = newline + 1;
    try { entries = JSON.parse(payload.subarray(0, newline).toString("utf8")); } catch (error) { fail(81, "digest-mismatch"); }
    for (var index = 0; index < entries.length; index++) {
      if (!allowed.test(entries[index][0]) || /(?:^|\/)\.\.?(?:\/|$)/.test(entries[index][0]) || !(entries[index][1] >= 0)) fail(79, "bad-request");
      offsets.push(offset);
      offset += entries[index][1];
    }
    if (offset !== payload.length || manifestDigest(entries, function (item) { return payload.subarray(offsets[item], offsets[item] + entries[item][1]); }) !== digest) fail(81, "digest-mismatch");
    var temporary;
    try {
      secure();
      if (verified(directory)) return entries;
      temporary = fs.mkdtempSync(path.join(root, ".tmp-"));
      for (var file = 0; file < entries.length; file++) {
        var target = path.join(temporary, entries[file][0]);
        fs.mkdirSync(path.dirname(target), { recursive: true, mode: 448 });
        fs.writeFileSync(target, payload.subarray(offsets[file], offsets[file] + entries[file][1]), { mode: 384 });
      }
      fs.writeFileSync(path.join(temporary, ".manifest"), JSON.stringify(entries), { mode: 384 });
      fs.writeFileSync(path.join(temporary, ".complete"), digest, { mode: 384 });
      try { fs.renameSync(temporary, directory); } catch (error) {
        // Another read installed it first, or a damaged copy is in the way.
        if (verified(directory)) fs.rmSync(temporary, { recursive: true, force: true });
        else { fs.rmSync(directory, { recursive: true, force: true }); fs.renameSync(temporary, directory); }
      }
    } catch (error) {
      if (temporary) try { fs.rmSync(temporary, { recursive: true, force: true }); } catch (ignored) { /* best effort */ }
      fail(80, "cache-unwritable " + (error && error.code ? error.code : "error"));
    }
    prune();
    return entries;
  }

  // Keep the newest three runtimes and anything used in the last 14 days.
  function prune() {
    try {
      var now = Date.now(), siblings = [];
      fs.readdirSync(root).forEach(function (entry) {
        var stats = fs.statSync(path.join(root, entry));
        if (entry.indexOf(".tmp-") === 0 && now - stats.mtimeMs > 86400000) fs.rmSync(path.join(root, entry), { recursive: true, force: true });
        else if (entry !== name && /-[0-9a-f]{16}$/.test(entry)) siblings.push({ entry: entry, time: stats.mtimeMs });
      });
      siblings.sort(function (left, right) { return right.time - left.time; }).slice(2).forEach(function (sibling) {
        if (now - sibling.time > 14 * 86400000) fs.rmSync(path.join(root, sibling.entry), { recursive: true, force: true });
      });
    } catch (error) { /* Pruning never fails a read. */ }
  }

  var manifest;
  if (mode === "install") manifest = install();
  else {
    try { secure(); } catch (error) { fail(80, "cache-unwritable " + (error && error.code ? error.code : "error")); }
    manifest = verified(directory);
    if (!manifest) fail(75, "need-runtime");
  }
  try { var now = new Date(); fs.utimesSync(directory, now, now); } catch (error) { /* Recency only guides pruning. */ }

  // Only a file the verified manifest lists runs: a compiled install's .js, else the source's .ts.
  var entry = manifest.some(function (item) { return item[0] === "bin/session-analytics.js"; }) ? "session-analytics.js" : "session-analytics.ts";
  var child = childProcess.spawn(process.execPath, [path.join(directory, "bin", entry)].concat(rest), { stdio: ["ignore", "pipe", "inherit"], detached: true });
  var lineEnd = true, stopped = false;

  // Output is relayed so a closed channel shows up as EPIPE. Newlines between lines are JSON-safe heartbeats.
  function write(bytes) {
    for (var offset = 0; offset < bytes.length;) {
      try { offset += fs.writeSync(1, bytes, offset, bytes.length - offset); } catch (error) {
        if (error.code !== "EAGAIN") { stop(); return false; }
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
      }
    }
    return true;
  }
  function stop() {
    if (stopped) return;
    stopped = true;
    try { process.kill(-child.pid, "SIGTERM"); } catch (error) { /* already gone */ }
    setTimeout(function () { try { process.kill(-child.pid, "SIGKILL"); } catch (error) { /* gone */ } process.exit(1); }, 2000).unref();
  }
  var heartbeat = setInterval(function () { if (lineEnd) write(Buffer.from("\n")); }, 1000);
  child.stdout.on("data", function (chunk) {
    if (!stopped && write(chunk)) lineEnd = chunk[chunk.length - 1] === 10;
  });
  ["SIGHUP", "SIGINT", "SIGTERM"].forEach(function (signal) { process.on(signal, stop); });
  child.on("error", function () { fail(1, "runtime-unavailable"); });
  child.on("close", function (code, signal) {
    clearInterval(heartbeat);
    if (signal && !stopped) fail(1, "stopped by " + signal);
    process.exit(code === null ? 1 : code);
  });
})();
`;
