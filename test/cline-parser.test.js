/**
 * Cline parser unit test (Cline CLI v3 / desktop app — ~/.cline).
 *
 * Cline keeps its own data dir instead of the VS Code globalStorage layout the
 * Roo Code / Kilo Code forks still use:
 *   <clineDir>/data/sessions/<session_id>/<session_id>.messages.json
 *
 * Each assistant turn carries `metrics` = a per-call delta of AI SDK
 * LanguageModelUsage totals, where `inputTokens` ALREADY CONTAINS
 * cacheRead + cacheWrite and `outputTokens` ALREADY CONTAINS reasoning. The
 * assertions below pin that subtraction — copying inputTokens straight into
 * input_tokens would bill the cached prefix twice.
 */
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const {
  resolveClineSessionsDir,
  resolveClineSessionsDirs,
  listClineSessionFiles,
  resolveClineSessionFiles,
  normalizeClineModel,
  parseClineIncremental,
} = require("../src/lib/rollout");

function setupFixture({ sessions, extraFiles = {} }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fix-"));
  const sessionsDir = path.join(home, "data", "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const session of sessions) {
    const sessionDir = path.join(sessionsDir, session.id);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, `${session.id}.messages.json`),
      JSON.stringify({ version: 1, sessionId: session.id, messages: session.messages }),
    );
    if (session.model !== undefined) {
      fs.writeFileSync(
        path.join(sessionDir, `${session.id}.json`),
        JSON.stringify({ session_id: session.id, provider: "cline", model: session.model }),
      );
    }
  }
  for (const [relative, contents] of Object.entries(extraFiles)) {
    const target = path.join(sessionsDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }
  return home;
}

function fakeEnv(home, extra = {}) {
  return { HOME: home, TOKENTRACKER_CLINE_HOME: home, ...extra };
}

function queueRows(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  return fs
    .readFileSync(queuePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

test("parseClineIncremental reads the anonymized real-session fixture", async () => {
  const fixturePath = path.join(__dirname, "fixtures", "cline", "session.messages.json");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cline-fixture-"));
  try {
    const queuePath = path.join(tmp, "queue.jsonl");
    const cursors = {};
    const result = await parseClineIncremental({
      sessionFiles: [{ filePath: fixturePath, sessionId: "fixture-cline-session" }],
      cursors,
      queuePath,
    });
    assert.equal(result.recordsProcessed, 3);
    assert.equal(result.eventsAggregated, 3);
    const [row] = queueRows(queuePath);
    assert.equal(row.source, "cline");
    assert.equal(row.model, "cline-free/deepseek-v4.1-flash");
    assert.equal(row.input_tokens, 21_535);
    assert.equal(row.cached_input_tokens, 10_922);
    assert.equal(row.output_tokens, 1_090);
    assert.equal(row.total_tokens, 33_547);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The local queue is append-only per bucket: a bucket whose totals grew gets a
// new row, and readers keep the last one. Assertions therefore look at the last
// row for a (source, model, hour_start) key, which is also what the dashboard
// and the cloud upsert treat as current.
function lastRowForKey(rows, { model, hourStart }) {
  const matching = rows.filter(
    (row) => row.source === "cline" && row.model === model && row.hour_start === hourStart,
  );
  return matching[matching.length - 1] || null;
}

function writeMessages(home, sessionId, messages, model) {
  const sessionDir = path.join(home, "data", "sessions", sessionId);
  fs.mkdirSync(sessionDir, { recursive: true });
  fs.writeFileSync(
    path.join(sessionDir, `${sessionId}.messages.json`),
    JSON.stringify({ version: 1, sessionId, messages }),
  );
  if (model !== undefined) {
    fs.writeFileSync(
      path.join(sessionDir, `${sessionId}.json`),
      JSON.stringify({ session_id: sessionId, provider: "cline", model }),
    );
  }
}

test("resolveClineSessionsDir honors Cline's own env chain and our override", () => {
  const home = "/tmp/cline-home";
  // Cline resolves CLINE_DIR -> <dir>/data -> <dir>/data/sessions.
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_DIR: "/opt/cline" }),
    path.join("/opt/cline", "data", "sessions"),
  );
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_DATA_DIR: "/opt/data" }),
    path.join("/opt/data", "sessions"),
  );
  assert.equal(
    resolveClineSessionsDir({ HOME: home, CLINE_SESSION_DATA_DIR: "/opt/sessions" }),
    "/opt/sessions",
  );
  // TokenTracker's own override wins over Cline's.
  assert.equal(
    resolveClineSessionsDir({ HOME: home, TOKENTRACKER_CLINE_HOME: "/tt", CLINE_DIR: "/opt/cline" }),
    path.join("/tt", "data", "sessions"),
  );
  // Default: ~/.cline/data/sessions.
  assert.equal(
    resolveClineSessionsDir({ HOME: home }),
    path.join(home, ".cline", "data", "sessions"),
  );
});

test("resolveClineSessionsDirs does not probe WSL when a path override is set", () => {
  const overridden = resolveClineSessionsDirs(
    { HOME: "/tmp/home", CLINE_DIR: "/opt/cline", TOKENTRACKER_WSL_MODE: "both" },
    { platform: "win32", discoverWslHome: () => "\\\\wsl$\\Ubuntu\\.cline" },
  );
  assert.deepEqual(overridden, [path.join("/opt/cline", "data", "sessions")]);

  // Without an override on win32 the distro copy is unioned in as well.
  const unioned = resolveClineSessionsDirs(
    { HOME: "C:\\Users\\me", TOKENTRACKER_WSL_MODE: "both" },
    { platform: "win32", existsSync: () => false, discoverWslHome: () => "\\\\wsl$\\Ubuntu\\.cline\\data\\sessions" },
  );
  assert.deepEqual(unioned, ["\\\\wsl$\\Ubuntu\\.cline\\data\\sessions"]);
});

test("resolveClineSessionFiles finds canonical transcripts and never doubles a session", () => {
  const home = setupFixture({
    sessions: [{ id: "session_1_aaa", model: "claude-sonnet-5", messages: [] }],
    // A stray extra transcript in the same session dir (export / copy) must not
    // become a second source for the same session.
    extraFiles: { "session_1_aaa/backup.messages.json": JSON.stringify({ messages: [] }) },
  });
  const files = resolveClineSessionFiles(fakeEnv(home));
  assert.equal(files.length, 1);
  assert.equal(files[0].sessionId, "session_1_aaa");
  assert.match(files[0].filePath, /session_1_aaa\.messages\.json$/);
  assert.match(files[0].sessionMetaPath, /session_1_aaa\.json$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("listClineSessionFiles falls back to the first sorted transcript and skips empty dirs", () => {
  const home = setupFixture({ sessions: [] });
  const sessionsDir = path.join(home, "data", "sessions");
  fs.mkdirSync(path.join(sessionsDir, "session_no_meta"), { recursive: true });
  fs.writeFileSync(
    path.join(sessionsDir, "session_no_meta", "renamed.messages.json"),
    JSON.stringify({ messages: [] }),
  );
  fs.mkdirSync(path.join(sessionsDir, "session_no_transcript"), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session_no_transcript", "notes.txt"), "x");

  const listed = listClineSessionFiles(sessionsDir);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].sessionId, "session_no_meta");
  assert.equal(listed[0].sessionMetaPath, null);
  assert.match(listed[0].filePath, /renamed\.messages\.json$/);
  fs.rmSync(home, { recursive: true, force: true });
});

test("normalizeClineModel falls back: modelInfo.id > session model > provider", () => {
  assert.equal(
    normalizeClineModel({ modelInfo: { id: "cline-free/deepseek-v4.1-flash" }, fallbackModel: "x" }),
    "cline-free/deepseek-v4.1-flash",
  );
  assert.equal(
    normalizeClineModel({ modelInfo: { provider: "cline" }, fallbackModel: "claude-sonnet-5" }),
    "claude-sonnet-5",
  );
  assert.equal(
    normalizeClineModel({ modelInfo: { provider: "Open Router" }, fallbackModel: null }),
    "provider:openrouter",
  );
  assert.equal(normalizeClineModel({ modelInfo: null, fallbackModel: null }), "unknown");
});

test("parseClineIncremental subtracts the cached prefix and folds reasoning into output", async () => {
  const ts = Date.UTC(2026, 8, 19, 16, 30, 0); // 2026-09-19T16:30:00Z
  const home = setupFixture({
    sessions: [
      {
        id: "session_bucket",
        model: "cline-free/deepseek-v4.1-flash",
        messages: [
          { id: "msg_user", role: "user", ts, content: [] },
          {
            id: "msg_a",
            role: "assistant",
            ts,
            modelInfo: { id: "cline-free/deepseek-v4.1-flash", provider: "cline" },
            // AI SDK totals: inputTokens includes both cache buckets, and
            // outputTokens includes the reasoning tokens.
            metrics: {
              inputTokens: 1000,
              outputTokens: 200,
              cacheReadTokens: 400,
              cacheWriteTokens: 100,
              reasoningTokenCount: 50,
            },
          },
        ],
      },
    ],
  });

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const res = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(res.recordsProcessed, 1, "the user turn carries no usage record");
  assert.equal(res.eventsAggregated, 1);
  assert.ok(res.bucketsQueued > 0);

  const row = lastRowForKey(queueRows(queuePath), {
    model: "cline-free/deepseek-v4.1-flash",
    hourStart: "2026-09-19T16:30:00.000Z",
  });
  assert.ok(row, "queue row for the Cline bucket");
  assert.equal(row.input_tokens, 500, "non-cached input only: 1000 - 400 - 100");
  assert.equal(row.cached_input_tokens, 400);
  assert.equal(row.cache_creation_input_tokens, 100);
  assert.equal(row.output_tokens, 200);
  assert.equal(row.reasoning_output_tokens, 50, "reasoning is reported as a subset");
  assert.equal(row.total_tokens, 1200, "inputTokens + outputTokens, reasoning not added twice");
  assert.equal(row.conversation_count, 1);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental counts reported cost and stays idempotent across re-syncs", async () => {
  const ts = Date.UTC(2026, 8, 19, 17, 5, 0);
  const session = {
    id: "session_cost",
    model: "cline-pass/glm-5.3",
    messages: [
      {
        id: "msg_cost",
        role: "assistant",
        ts,
        modelInfo: { id: "cline-pass/glm-5.3", provider: "cline" },
        metrics: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.25 },
      },
    ],
  };
  const home = setupFixture({ sessions: [session] });
  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};

  await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  const first = lastRowForKey(queueRows(queuePath), {
    model: "cline-pass/glm-5.3",
    hourStart: "2026-09-19T17:00:00.000Z",
  });
  assert.equal(first.total_cost_usd, 0.25, "Cline's own per-call cost is carried through");
  assert.equal(first.input_tokens, 100);
  assert.equal(first.output_tokens, 20);

  // Unchanged file: the mtime/size gate skips it entirely.
  const before = queueRows(queuePath).length;
  const second = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(second.recordsProcessed, 0, "unchanged transcript is not re-read");
  assert.equal(queueRows(queuePath).length, before, "nothing re-queued");

  // Same bucket, one more turn appended: the bucket row grows to the new total
  // instead of re-adding the first turn.
  const appended = {
    ...session,
    messages: [
      ...session.messages,
      {
        id: "msg_cost_2",
        role: "assistant",
        ts: ts + 60_000,
        modelInfo: { id: "cline-pass/glm-5.3", provider: "cline" },
        metrics: { inputTokens: 40, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.05 },
      },
    ],
  };
  fs.writeFileSync(
    path.join(home, "data", "sessions", session.id, `${session.id}.messages.json`),
    JSON.stringify({ version: 1, sessionId: session.id, messages: appended.messages }),
  );
  const third = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors,
    queuePath,
  });
  assert.equal(third.eventsAggregated, 1, "only the new turn is counted");
  const grown = lastRowForKey(queueRows(queuePath), {
    model: "cline-pass/glm-5.3",
    hourStart: "2026-09-19T17:00:00.000Z",
  });
  assert.equal(grown.input_tokens, 140);
  assert.equal(grown.output_tokens, 25);
  assert.equal(grown.total_cost_usd, 0.3);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental adds only the increase when Cline back-fills a counted turn", async () => {
  const ts = Date.UTC(2026, 8, 19, 18, 40, 0);
  const home = setupFixture({ sessions: [] });
  const sessionId = "session_backfill";
  const turn = (metrics) => ({
    id: "msg_same",
    role: "assistant",
    ts,
    modelInfo: { id: "claude-sonnet-5", provider: "anthropic" },
    metrics,
  });
  writeMessages(home, sessionId, [turn({ inputTokens: 100, outputTokens: 10 })], "claude-sonnet-5");

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const files = () => resolveClineSessionFiles(fakeEnv(home));
  await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });

  const key = { model: "claude-sonnet-5", hourStart: "2026-09-19T18:30:00.000Z" };
  assert.equal(lastRowForKey(queueRows(queuePath), key).input_tokens, 100);

  // Same message id, larger totals — a streamed turn Cline completed after our
  // first sync saw it. Only the 200/30 increase may be billed.
  writeMessages(
    home,
    sessionId,
    [turn({ inputTokens: 300, outputTokens: 40, cacheReadTokens: 25 })],
    "claude-sonnet-5",
  );
  await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });

  const grown = lastRowForKey(queueRows(queuePath), key);
  // 300 inclusive - 25 cache = 275 non-cached input now; 100 was already
  // counted, so the bucket grows by 175 to 275. The 25 cache-read tokens are
  // billed once, as cached_input_tokens — never subtracted twice.
  assert.equal(grown.input_tokens, 275);
  assert.equal(grown.cached_input_tokens, 25);
  assert.equal(grown.output_tokens, 40);
  assert.equal(grown.total_tokens, 340);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental skips turns without usage and counts them once they arrive", async () => {
  const ts = Date.UTC(2026, 8, 19, 19, 10, 0);
  const home = setupFixture({ sessions: [] });
  const sessionId = "session_pending";
  const metricsless = { id: "msg_pending", role: "assistant", ts, modelInfo: { id: "m" } };
  writeMessages(
    home,
    sessionId,
    [
      { id: "msg_user", role: "user", ts, content: [] },
      metricsless,
      // metrics present but empty — Cline writes the shape before the numbers
      { id: "msg_empty", role: "assistant", ts: ts + 1000, metrics: {} },
      // no timestamp: cannot be bucketed
      { id: "msg_no_ts", role: "assistant", metrics: { inputTokens: 9, outputTokens: 1 } },
      // assistant text with all-zero usage: nothing consumed yet
      {
        id: "msg_zero",
        role: "assistant",
        ts: ts + 2000,
        metrics: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    ],
  );

  const queuePath = path.join(home, "queue.jsonl");
  const cursors = {};
  const files = () => resolveClineSessionFiles(fakeEnv(home));
  const first = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
  assert.equal(first.recordsProcessed, 2, "only turns carrying a metrics object are iterated");
  assert.equal(first.eventsAggregated, 0, "no usage yet");
  assert.equal(queueRows(queuePath).filter((r) => r.source === "cline").length, 0);

  // The pending turn completes: it must be counted in FULL (a placeholder must
  // never latch a partial total).
  writeMessages(
    home,
    sessionId,
    [
      { id: "msg_user", role: "user", ts, content: [] },
      { ...metricsless, metrics: { inputTokens: 700, outputTokens: 80, cacheReadTokens: 0, cacheWriteTokens: 0 } },
    ],
  );
  const second = await parseClineIncremental({ sessionFiles: files(), cursors, queuePath });
  assert.equal(second.eventsAggregated, 1);
  const row = lastRowForKey(queueRows(queuePath), {
    model: "m",
    hourStart: "2026-09-19T19:00:00.000Z",
  });
  assert.equal(row.input_tokens, 700);
  assert.equal(row.output_tokens, 80);
  fs.rmSync(home, { recursive: true, force: true });
});

test("parseClineIncremental reports progress and tolerates unreadable transcripts", async () => {
  const home = setupFixture({ sessions: [{ id: "session_ok", messages: [] }] });
  const sessionsDir = path.join(home, "data", "sessions");
  // A directory whose transcript is not valid JSON must be skipped, not thrown.
  fs.mkdirSync(path.join(sessionsDir, "session_broken"), { recursive: true });
  fs.writeFileSync(path.join(sessionsDir, "session_broken", "session_broken.messages.json"), "{oops");

  const progress = [];
  const res = await parseClineIncremental({
    sessionFiles: resolveClineSessionFiles(fakeEnv(home)),
    cursors: {},
    queuePath: path.join(home, "queue.jsonl"),
    onProgress: (p) => progress.push(p),
  });
  assert.equal(res.recordsProcessed, 0);
  assert.equal(progress.length, 2, "one progress tick per transcript");
  assert.deepEqual(
    progress.map((p) => p.index),
    [1, 2],
  );
  fs.rmSync(home, { recursive: true, force: true });
});
