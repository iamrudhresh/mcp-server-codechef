import path from "node:path";
import { config } from "./config.js";
import { CodeChefError } from "./errors.js";
import { readJsonFile, writeJsonFile } from "./store.js";

/**
 * CodeChef judge client: login, submit and verdict polling.
 *
 * Uses the same JSON endpoints the codechef.com web app calls, verified against
 * the site's own JavaScript bundle:
 *   POST /api/login            {name, pass, csrfToken}        -> {status: "success"|"error"}
 *   POST /api/ide/submit       sourceCode, language(id), problemCode, contestCode -> {upid}
 *   GET  /api/ide/submit?solution_id=<upid>                    -> {result_code, ...}
 *   GET  /api/ide/all/languages/all                            -> {languages: [{id, short_name}]}
 * Requests carry the session cookies plus `x-csrf-token` (from window.csrfToken)
 * and `X-Requested-With: XMLHttpRequest`, exactly like the browser.
 *
 * No headless browser is needed. The original Python implementation drove the
 * page with Playwright using selectors that no longer exist on the React site,
 * and polled verdicts without the login session, so it could never succeed.
 */
const ORIGIN = "https://www.codechef.com";
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) " +
  "Chrome/124.0 Safari/537.36 mcp-server-codechef";
const TIMEOUT_MS = 25_000;
const SESSION_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const MAX_SOURCE_BYTES = 64 * 1024;

let fetchImpl = (...args) => fetch(...args);
/** Test hook: replace the network layer. */
export function setFetch(fn) {
  fetchImpl = fn;
  resetSession();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ── Cookie jar ─────────────────────────────────────────────────── */

const state = { cookies: new Map(), csrf: "", loggedIn: false, loadedFromDisk: false };

export function resetSession() {
  state.cookies = new Map();
  state.csrf = "";
  state.loggedIn = false;
  state.loadedFromDisk = false;
}

const sessionFile = () => path.join(config.home, "session.json");

function storeCookies(res) {
  const list = typeof res.headers.getSetCookie === "function" ? res.headers.getSetCookie() : [];
  for (const raw of list) {
    const [pair, ...attrs] = raw.split(";");
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const name = pair.slice(0, eq).trim();
    const value = pair.slice(eq + 1).trim();
    const expired =
      value === "deleted" ||
      attrs.some((a) => /^\s*max-age\s*=\s*(0|-\d+)\s*$/i.test(a)) ||
      attrs.some((a) => {
        const m = /^\s*expires\s*=\s*(.+)$/i.exec(a);
        return m && Date.parse(m[1]) < Date.now();
      });
    if (expired) state.cookies.delete(name);
    else state.cookies.set(name, value);
  }
}

const cookieHeader = () => [...state.cookies].map(([k, v]) => `${k}=${v}`).join("; ");

/** Extract `window.csrfToken = '...'` from a CodeChef HTML page. */
export function extractCsrf(html) {
  const m = /csrfToken\s*=\s*['"]([A-Za-z0-9_-]{16,})['"]/.exec(html ?? "");
  return m ? m[1] : "";
}

/** Strip HTML tags/entities from CodeChef error strings. */
export function cleanMessage(value) {
  const flat = Array.isArray(value)
    ? value.join("; ")
    : value && typeof value === "object"
      ? Object.values(value).join("; ")
      : String(value ?? "");
  return flat
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function request(pathname, { method = "GET", body, headers = {}, maxRedirects = 5 } = {}) {
  let url = `${ORIGIN}${pathname}`;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await fetchImpl(url, {
      method,
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        "User-Agent": USER_AGENT,
        "X-Requested-With": "XMLHttpRequest",
        Origin: ORIGIN,
        Referer: `${ORIGIN}/`,
        ...(state.csrf ? { "x-csrf-token": state.csrf } : {}),
        ...(state.cookies.size ? { Cookie: cookieHeader() } : {}),
        ...headers,
      },
    });
    storeCookies(res);
    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      const next = new URL(location, url);
      if (next.hostname !== new URL(ORIGIN).hostname) {
        throw new CodeChefError(`Refusing redirect to ${next.hostname}`, { code: "UNEXPECTED_REDIRECT" });
      }
      url = next.toString();
      method = "GET";
      body = undefined;
      continue;
    }
    return res;
  }
  throw new CodeChefError("Too many redirects from CodeChef.", { code: "UPSTREAM" });
}

async function readJson(res, what) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    if (res.status === 401 || res.status === 403 || /login/i.test(text.slice(0, 4000))) {
      throw new CodeChefError(`${what}: CodeChef session is not authenticated.`, {
        code: "AUTH_REQUIRED",
        status: res.status,
      });
    }
    throw new CodeChefError(`${what}: CodeChef returned a non-JSON response (HTTP ${res.status}).`, {
      code: "UPSTREAM",
      status: res.status,
    });
  }
}

async function refreshCsrf() {
  const res = await request("/login", { headers: { Accept: "text/html" } });
  const token = extractCsrf(await res.text());
  if (!token) {
    throw new CodeChefError("Could not obtain a CSRF token from codechef.com (site change or bot check).", {
      code: "UPSTREAM",
    });
  }
  state.csrf = token;
}

function persistSession() {
  writeJsonFile(sessionFile(), { savedAt: Date.now(), cookies: [...state.cookies] }, { secret: true });
}

function restoreSession() {
  if (state.loadedFromDisk) return;
  state.loadedFromDisk = true;
  const saved = readJsonFile(sessionFile(), null);
  if (saved?.cookies && Date.now() - (saved.savedAt ?? 0) < SESSION_MAX_AGE_MS) {
    state.cookies = new Map(saved.cookies);
    state.loggedIn = true; // verified lazily: an auth failure triggers a fresh login
  }
}

export async function login() {
  if (!config.username || !config.password) {
    throw new CodeChefError(
      "CODECHEF_USERNAME and CODECHEF_PASSWORD are not set. Add them to the \"env\" block of this " +
        "server in your MCP client config. Accounts created with Google sign-in must first set a " +
        "password at https://www.codechef.com/user/password.",
      { code: "CREDENTIALS_MISSING" },
    );
  }
  state.cookies = new Map();
  state.loggedIn = false;
  await refreshCsrf();
  const res = await request("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ name: config.username, pass: config.password, csrfToken: state.csrf }),
  });
  const data = await readJson(res, "Login");
  if (data?.status !== "success") {
    throw new CodeChefError(`CodeChef login failed: ${cleanMessage(data?.errors) || "unknown reason"}`, {
      code: "LOGIN_FAILED",
    });
  }
  state.loggedIn = true;
  await refreshCsrf(); // the token is bound to the new session
  persistSession();
}

async function ensureSession() {
  restoreSession();
  if (!state.loggedIn) await login();
  else if (!state.csrf) await refreshCsrf();
}

/** Run an authenticated call; on an auth failure, log in again once and retry. */
async function withAuth(fn) {
  await ensureSession();
  try {
    return await fn();
  } catch (err) {
    if (err instanceof CodeChefError && err.code === "AUTH_REQUIRED") {
      await login();
      return fn();
    }
    throw err;
  }
}

/* ── Languages ──────────────────────────────────────────────────── */

/** User-facing names mapped to CodeChef `short_name`s, in preference order. */
const LANGUAGE_PREFERENCES = {
  cpp: ["C++", "CPP20", "CPP17", "CPP14"],
  "c++": ["C++", "CPP20", "CPP17", "CPP14"],
  cpp17: ["C++", "CPP17", "CPP20"],
  cpp20: ["CPP20", "C++"],
  cpp14: ["CPP14", "C++"],
  c: ["C"],
  python: ["PYTH 3", "PYTH3"],
  python3: ["PYTH 3", "PYTH3"],
  py: ["PYTH 3", "PYTH3"],
  pypy: ["PYPY3", "PYP3"],
  pypy3: ["PYPY3", "PYP3"],
  java: ["JAVA"],
  go: ["GO"],
  golang: ["GO"],
  rust: ["rust", "RUST"],
  javascript: ["NODEJS"],
  js: ["NODEJS"],
  node: ["NODEJS"],
  nodejs: ["NODEJS"],
  kotlin: ["kotlin", "KOTLIN"],
  csharp: ["CS2", "C#"],
};

/** Pick the CodeChef language entry for a user-supplied name, short name or id. */
export function resolveLanguage(language, languages) {
  const wanted = String(language ?? "").trim();
  const byShort = new Map(languages.map((l) => [String(l.short_name).toLowerCase(), l]));
  const direct =
    languages.find((l) => String(l.id) === wanted) ?? byShort.get(wanted.toLowerCase());
  if (direct) return direct;
  for (const candidate of LANGUAGE_PREFERENCES[wanted.toLowerCase()] ?? []) {
    const hit = byShort.get(candidate.toLowerCase());
    if (hit) return hit;
  }
  return null;
}

let languageCache = null;

export async function getLanguages() {
  if (languageCache && Date.now() - languageCache.at < 24 * 3600 * 1000) return languageCache.list;
  const res = await request("/api/ide/all/languages/all", { headers: { Accept: "application/json" } });
  const data = await readJson(res, "Language list");
  const list = Array.isArray(data?.languages) ? data.languages : [];
  if (!list.length) throw new CodeChefError("CodeChef returned an empty language list.", { code: "UPSTREAM" });
  languageCache = { list, at: Date.now() };
  return list;
}

/* ── Submit & verdict ───────────────────────────────────────────── */

export async function submitSolution({ contestCode, problemCode, language, code }) {
  const contest = String(contestCode).trim().toUpperCase();
  const problem = String(problemCode).trim().toUpperCase();
  if (!/^[A-Z0-9_]{1,40}$/.test(contest) || !/^[A-Z0-9_]{1,40}$/.test(problem)) {
    throw new CodeChefError("contestCode and problemCode must be CodeChef codes like START123 / FLOW001.", {
      code: "INVALID_INPUT",
    });
  }
  if (!code || Buffer.byteLength(code, "utf8") > MAX_SOURCE_BYTES) {
    throw new CodeChefError(`Source code must be 1-${MAX_SOURCE_BYTES} bytes.`, { code: "INVALID_INPUT" });
  }

  const languages = await getLanguages();
  const lang = resolveLanguage(language, languages);
  if (!lang) {
    throw new CodeChefError(
      `Unsupported language "${language}". CodeChef accepts: ${languages.map((l) => l.short_name).join(", ")}`,
      { code: "INVALID_INPUT" },
    );
  }

  const data = await withAuth(async () => {
    const res = await request("/api/ide/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
        Accept: "application/json",
        Referer: `${ORIGIN}/${contest === "PRACTICE" ? "problems" : `${contest}/problems`}/${problem}`,
      },
      body: new URLSearchParams({
        sourceCode: code,
        language: String(lang.id),
        problemCode: problem,
        contestCode: contest,
      }).toString(),
    });
    const json = await readJson(res, "Submit");
    const message = cleanMessage(json?.errors ?? json?.message);
    if (json?.status === "error" && /log\s*in|session|sign\s*in/i.test(message)) {
      throw new CodeChefError(message, { code: "AUTH_REQUIRED" });
    }
    return json;
  });

  if (data?.status === "error" || !data?.upid) {
    throw new CodeChefError(
      `CodeChef rejected the submission: ${cleanMessage(data?.errors ?? data?.message) || "no submission id returned"}`,
      { code: "SUBMIT_REJECTED" },
    );
  }

  return {
    submission_id: String(data.upid),
    status: "submitted",
    contest_code: contest,
    problem_code: problem,
    language: lang.short_name,
    language_id: lang.id,
    url: `${ORIGIN}/viewsolution/${data.upid}`,
  };
}

/** CodeChef `result_code` values (from the web app) mapped to verdicts. */
export const VERDICTS = {
  accepted: { code: "AC", verdict: "Accepted" },
  partial_accepted: { code: "PAC", verdict: "Partially Accepted" },
  wrong: { code: "WA", verdict: "Wrong Answer" },
  time: { code: "TLE", verdict: "Time Limit Exceeded" },
  runtime: { code: "RE", verdict: "Runtime Error" },
  compile: { code: "CE", verdict: "Compilation Error" },
  memory: { code: "MLE", verdict: "Memory Limit Exceeded" },
  wait: { code: "wait", verdict: "Judging" },
};

/** Normalize a raw /api/ide/submit?solution_id= payload. */
export function normalizeVerdict(submissionId, raw) {
  const resultCode = String(raw?.result_code ?? "").toLowerCase();
  const known = VERDICTS[resultCode];
  const out = {
    submission_id: String(submissionId),
    verdict: known?.verdict ?? (resultCode || "Unknown"),
    verdict_code: known?.code ?? (resultCode || "UNKNOWN"),
    result_code: resultCode || null,
    pending: resultCode === "wait",
    execution_time: raw?.time ?? "N/A",
    memory: raw?.memory ?? "N/A",
  };
  if (raw?.score !== undefined) out.score = raw.score;
  for (const key of ["cmpinfo", "compile_info", "error_msg", "signal"]) {
    if (typeof raw?.[key] === "string" && raw[key].trim()) out[key] = raw[key].slice(0, 2000);
  }
  return out;
}

/**
 * Poll the verdict until judging finishes or `waitSeconds` elapse.
 * Returns a pending result (verdict "Judging") rather than failing on timeout.
 */
export async function getVerdict(submissionId, { waitSeconds = 60, intervalMs = 2000 } = {}) {
  const id = String(submissionId).trim();
  if (!/^\d{1,15}$/.test(id)) {
    throw new CodeChefError("submissionId must be the numeric id returned by submit_solution.", {
      code: "INVALID_INPUT",
    });
  }
  const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
  for (;;) {
    const raw = await withAuth(async () => {
      const res = await request(`/api/ide/submit?solution_id=${id}`, { headers: { Accept: "application/json" } });
      return readJson(res, "Verdict");
    });
    if (raw?.status === "error") {
      throw new CodeChefError(`CodeChef could not return this submission: ${cleanMessage(raw.errors ?? raw.message)}`, {
        code: "NOT_FOUND",
      });
    }
    const verdict = normalizeVerdict(id, raw);
    if (!verdict.pending || Date.now() + intervalMs > deadline) return verdict;
    await sleep(intervalMs);
  }
}
