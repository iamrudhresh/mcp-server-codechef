import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";

/**
 * Tiny JSON-file persistence for submission history and sandbox logs.
 *
 * The Python runtime uses SQLite via SQLAlchemy; Node 20 has no stable built-in
 * SQLite, and a native module would make `npx` installs fragile, so a capped
 * JSON document is used instead. Writes go to a temp file and are renamed into
 * place so a crash can never leave a half-written file behind.
 */
const MAX_SUBMISSIONS = 1000;
const MAX_EXECUTION_LOGS = 200;

const empty = () => ({ submissions: {}, executionLogs: [] });

function dataFile() {
  return path.join(config.home, "data.json");
}

export function readJsonFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJsonFile(file, value, { secret = false } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: secret ? 0o600 : 0o644 });
  fs.renameSync(tmp, file);
}

function load() {
  const data = readJsonFile(dataFile(), empty());
  if (!data || typeof data !== "object") return empty();
  data.submissions ??= {};
  data.executionLogs ??= [];
  return data;
}

function save(data) {
  const ids = Object.keys(data.submissions);
  if (ids.length > MAX_SUBMISSIONS) {
    ids
      .sort((a, b) => data.submissions[a].timestamp.localeCompare(data.submissions[b].timestamp))
      .slice(0, ids.length - MAX_SUBMISSIONS)
      .forEach((id) => delete data.submissions[id]);
  }
  data.executionLogs = data.executionLogs.slice(-MAX_EXECUTION_LOGS);
  writeJsonFile(dataFile(), data);
}

/** Insert or update a submission record (keyed by submission id). */
export function saveSubmission(record) {
  const data = load();
  const existing = data.submissions[record.submission_id] ?? {};
  data.submissions[record.submission_id] = {
    verdict: "Pending",
    verdict_code: "wait",
    execution_time: "N/A",
    memory: "N/A",
    timestamp: existing.timestamp ?? new Date().toISOString(),
    ...existing,
    ...record,
  };
  save(data);
  return data.submissions[record.submission_id];
}

export function getSubmission(submissionId) {
  return load().submissions[String(submissionId)] ?? null;
}

/** All stored submissions for a problem, newest first. */
export function getProblemSubmissions(problemCode, contestCode) {
  const problem = String(problemCode).toUpperCase();
  const contest = contestCode ? String(contestCode).toUpperCase() : null;
  return Object.values(load().submissions)
    .filter((s) => s.problem_code === problem && (!contest || s.contest_code === contest))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export function saveExecutionLog(entry) {
  const data = load();
  data.executionLogs.push({ ...entry, timestamp: new Date().toISOString() });
  save(data);
}
