"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { cmdSync } = require("../src/commands/sync");
const { withHome } = require("./helpers/with-home");

test("Cline discovery failure preserves sync state and deleted files are pruned", async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-sync-"));
  const restoreHome = withHome(home);
  const previousDir = process.env.TOKENTRACKER_CLINE_SESSIONS_DIR;
  const sessionsDir = path.join(home, "sessions");
  process.env.TOKENTRACKER_CLINE_SESSIONS_DIR = sessionsDir;
  try {
    const sessionDir = path.join(sessionsDir, "fixture");
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "fixture.messages.json");
    fs.writeFileSync(filePath, JSON.stringify({ messages: [{
      id: "turn", role: "assistant", ts: Date.now(), metrics: { inputTokens: 100 },
    }] }));
    const args = ["--auto", "--from-notify", "--source=cline"];
    await cmdSync(args);
    const trackerDir = path.join(home, ".tokentracker", "tracker");
    const cursorPath = path.join(trackerDir, "cursors.json");
    const readCursor = () => JSON.parse(fs.readFileSync(cursorPath, "utf8"));
    const before = readCursor();
    const queueBefore = fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8");
    const readDir = fs.readdirSync;
    t.mock.method(fs, "readdirSync", (dir, ...options) => {
      if (dir === sessionsDir) throw Object.assign(new Error("synthetic read failure"), { code: "EACCES" });
      return readDir(dir, ...options);
    });
    await cmdSync(args);
    assert.deepEqual(readCursor().cline, before.cline);
    assert.deepEqual(readCursor().hourly.buckets, before.hourly.buckets);
    assert.deepEqual(readCursor().hourly.groupQueued, before.hourly.groupQueued);
    assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);
    t.mock.restoreAll();
    await cmdSync(args);
    assert.equal(fs.readFileSync(path.join(trackerDir, "queue.jsonl"), "utf8"), queueBefore);
    fs.unlinkSync(filePath);
    await cmdSync(args);
    assert.deepEqual(readCursor().cline.fileOffsets, {});
    assert.deepEqual(readCursor().cline.messageTotalsByFile, {});
  } finally {
    t.mock.restoreAll();
    restoreHome();
    if (previousDir === undefined) delete process.env.TOKENTRACKER_CLINE_SESSIONS_DIR;
    else process.env.TOKENTRACKER_CLINE_SESSIONS_DIR = previousDir;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Cline status exposes present and absent installs in JSON and light output", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-status-"));
  try {
    const sessionsDir = path.join(home, "sessions");
    const sessionDir = path.join(sessionsDir, "fixture");
    fs.mkdirSync(sessionDir, { recursive: true });
    const filePath = path.join(sessionDir, "fixture.messages.json");
    fs.writeFileSync(filePath, "[]");
    const run = (format) => {
      const result = spawnSync(process.execPath, [path.join(__dirname, "../bin/tracker.js"), "status", format], {
        encoding: "utf8",
        timeout: 30_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, TOKENTRACKER_CLINE_SESSIONS_DIR: sessionsDir },
      });
      assert.equal(result.status, 0, result.stderr);
      return result.stdout;
    };
    assert.deepEqual(JSON.parse(run("--json")).providers.cline, { installed: true, files: 1 });
    assert.match(run("--light"), /Provider · cline\s+\| installed, 1 file/);
    fs.unlinkSync(filePath);
    assert.deepEqual(JSON.parse(run("--json")).providers.cline, { installed: false });
    assert.match(run("--light"), /Provider · cline\s+\| not installed/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
