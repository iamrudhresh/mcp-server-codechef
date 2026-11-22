/**
 * Offline tests for the solving workflow (judge client, sandbox flags, store,
 * contest progress, retry analysis, confidence). The CodeChef API is replaced
 * by an in-memory fake that mimics the real endpoints' shapes.
 *
 * Run with: npm run test:workflow
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codechef-mcp-test-"));
process.env.CODECHEF_MCP_HOME = home;
process.env.CODECHEF_USERNAME = "alice";
process.env.CODECHEF_PASSWORD = "s3cret";

const judge = await import("../src/judge.js");
const sandbox = await import("../src/sandbox.js");
const solver = await import("../src/solver.js");
const store = await import("../src/store.js");
const workflow = await import("../src/workflow.js");

let pass = 0;
let fail = 0;
const eq = (label, actual, expected) => {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? pass++ : fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : `  (got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)})`}`);
};
const ok = (label, value) => eq(label, Boolean(value), true);
const rejects = async (label, fn, code) => {
  try {
    await fn();
    eq(label, "resolved", code);
  } catch (err) {
    eq(label, err.code, code);
  }
};

/* ── Fake codechef.com ── */

const LANGS = [
  { id: 42, short_name: "C++" },
  { id: 116, short_name: "PYTH 3" },
  { id: 10, short_name: "JAVA" },
  { id: 109, short_name: "PYPY3" },
  { id: 93, short_name: "rust" },
];

function fakeCodeChef({ expireAfterSubmits = Infinity } = {}) {
  const calls = [];
  let session = null;
  let submits = 0;
  let polls = 0;
  const json = (body, status = 200, cookies = []) => {
    const headers = new Headers({ "content-type": "application/json" });
    for (const c of cookies) headers.append("set-cookie", c);
    return new Response(JSON.stringify(body), { status, headers });
  };
  const fn = async (url, init = {}) => {
    const u = new URL(url);
    const cookie = init.headers?.Cookie ?? "";
    const authed = session && cookie.includes(`SESS=${session}`);
    calls.push({ path: u.pathname + u.search, method: init.method ?? "GET", csrf: init.headers?.["x-csrf-token"], authed, body: init.body });

    if (u.pathname === "/login") {
      const token = authed ? "tokenAfterLogin1234567890" : "tokenBeforeLogin123456789";
      return new Response(`<script>window.csrfToken = '${token}';</script>`, {
        status: 200,
        headers: { "set-cookie": "cf=1; Path=/" },
      });
    }
    if (u.pathname === "/api/login") {
      const body = JSON.parse(init.body);
      if (body.name === "alice" && body.pass === "s3cret" && body.csrfToken === "tokenBeforeLogin123456789") {
        session = `s${calls.length}`;
        return json({ status: "success" }, 200, [`SESS=${session}; Path=/; HttpOnly`]);
      }
      return json({ status: "error", errors: { pass: "Wrong username or password <a href='x'>Reset</a>" } });
    }
    if (u.pathname === "/api/ide/all/languages/all") return json({ languages: LANGS });
    if (u.pathname === "/api/ide/submit" && init.method === "POST") {
      if (!authed || init.headers["x-csrf-token"] !== "tokenAfterLogin1234567890") {
        return new Response("<html>Please login</html>", { status: 403 });
      }
      submits++;
      if (submits >= expireAfterSubmits) session = null; // session expires server-side
      const form = new URLSearchParams(init.body);
      if (form.get("problemCode") === "BADPROB") return json({ status: "error", errors: ["Problem not found"] });
      return json({ status: "OK", upid: 1234567 });
    }
    if (u.pathname === "/api/ide/submit") {
      if (!authed) return new Response("<html>login</html>", { status: 403 });
      polls++;
      return json(polls < 2 ? { result_code: "wait" } : { result_code: "wrong", time: "0.01", memory: "5M", score: 0 });
    }
    return new Response("not found", { status: 404 });
  };
  return { fn, calls, expire: () => (session = null) };
}

/* ── Pure helpers ── */

eq("extractCsrf reads window.csrfToken", judge.extractCsrf("x window.csrfToken = 'abcdef0123456789abcd'; y"), "abcdef0123456789abcd");
eq("extractCsrf tolerates missing token", judge.extractCsrf("<html></html>"), "");
eq("cleanMessage strips tags and joins objects", judge.cleanMessage({ pass: "Wrong <a href='x'>Reset</a>" }), "Wrong Reset");
eq("resolveLanguage maps cpp to C++", judge.resolveLanguage("cpp", LANGS)?.id, 42);
eq("resolveLanguage maps python3 to PYTH 3", judge.resolveLanguage("python3", LANGS)?.id, 116);
eq("resolveLanguage accepts a numeric id", judge.resolveLanguage("109", LANGS)?.short_name, "PYPY3");
eq("resolveLanguage accepts an exact short name", judge.resolveLanguage("pyth 3", LANGS)?.id, 116);
eq("resolveLanguage rejects unknown", judge.resolveLanguage("cobol", LANGS), null);

eq("verdict: accepted -> AC", judge.normalizeVerdict(1, { result_code: "accepted" }).verdict_code, "AC");
eq("verdict: wrong -> WA", judge.normalizeVerdict(1, { result_code: "wrong" }).verdict, "Wrong Answer");
eq("verdict: time -> TLE", judge.normalizeVerdict(1, { result_code: "time" }).verdict_code, "TLE");
eq("verdict: partial_accepted -> PAC", judge.normalizeVerdict(1, { result_code: "partial_accepted" }).verdict_code, "PAC");
eq("verdict: wait is pending", judge.normalizeVerdict(1, { result_code: "wait" }).pending, true);
eq("verdict: compile info kept", judge.normalizeVerdict(1, { result_code: "compile", cmpinfo: "err" }).cmpinfo, "err");

/* ── Judge flow against the fake ── */

{
  const fake = fakeCodeChef();
  judge.setFetch(fake.fn);
  const res = await workflow.submit({ contestCode: "start99", problemCode: "flow001", language: "cpp", code: "int main(){}" });
  eq("submit returns the upid as submission_id", res.submission_id, "1234567");
  eq("submit uppercases codes", [res.contest_code, res.problem_code], ["START99", "FLOW001"]);
  eq("submit resolved the language id", res.language_id, 42);
  const post = fake.calls.find((c) => c.path === "/api/ide/submit" && c.method === "POST");
  const form = new URLSearchParams(post.body);
  eq("submit form carries sourceCode/language/problemCode/contestCode", [form.get("sourceCode"), form.get("language"), form.get("problemCode"), form.get("contestCode")], ["int main(){}", "42", "FLOW001", "START99"]);
  eq("submit used the post-login csrf token", post.csrf, "tokenAfterLogin1234567890");
  ok("login session was persisted with private permissions", fs.existsSync(path.join(home, "session.json")));
  eq("submission recorded as pending", store.getSubmission("1234567").verdict_code, "wait");

  const verdict = await workflow.submissionStatus("1234567", { waitSeconds: 10 });
  eq("status polls through 'wait' to the final verdict", verdict.verdict_code, "WA");
  eq("status carries time and memory", [verdict.execution_time, verdict.memory], ["0.01", "5M"]);
  eq("store updated with the verdict", store.getSubmission("1234567").verdict, "Wrong Answer");

  const retry = workflow.retrySolution("START99", "FLOW001");
  eq("retry diagnoses the WA", retry.status, "retry_needed");
  ok("retry suggests boundary tests", retry.analysis.suggested_approach.includes("boundary"));
  eq("retry counts the attempt", retry.retry_state.retry_count, 1);

  const history = workflow.submissionHistory("START99", "FLOW001");
  eq("history lists the submission", history.map((h) => [h.submission_id, h.verdict_code]), [["1234567", "WA"]]);

  await rejects("rejected submission surfaces SUBMIT_REJECTED", () =>
    workflow.submit({ contestCode: "START99", problemCode: "BADPROB", language: "cpp", code: "x" }), "SUBMIT_REJECTED");
  await rejects("unknown language is INVALID_INPUT", () =>
    workflow.submit({ contestCode: "START99", problemCode: "FLOW001", language: "cobol", code: "x" }), "INVALID_INPUT");
  await rejects("bad submission id is INVALID_INPUT", () => workflow.submissionStatus("12; rm -rf"), "INVALID_INPUT");
}

{
  // Session expires on the server: the client must log in again and retry once.
  const fake = fakeCodeChef();
  judge.setFetch(fake.fn);
  await workflow.submit({ contestCode: "START99", problemCode: "FLOW002", language: "python", code: "print(1)" });
  fake.expire();
  const again = await workflow.submit({ contestCode: "START99", problemCode: "FLOW002", language: "python", code: "print(2)" });
  eq("expired session triggers a transparent re-login", again.submission_id, "1234567");
  eq("re-login happened exactly twice in total", fake.calls.filter((c) => c.path === "/api/login").length, 2);
}

{
  const fake = fakeCodeChef();
  judge.setFetch(fake.fn);
  fs.rmSync(path.join(home, "session.json"), { force: true });
  process.env.CODECHEF_PASSWORD = "wrong";
  await rejects("wrong password is LOGIN_FAILED", () =>
    workflow.submit({ contestCode: "START99", problemCode: "FLOW001", language: "cpp", code: "x" }), "LOGIN_FAILED");
  delete process.env.CODECHEF_PASSWORD;
  judge.resetSession();
  await rejects("missing credentials is CREDENTIALS_MISSING", () =>
    workflow.submit({ contestCode: "START99", problemCode: "FLOW001", language: "cpp", code: "x" }), "CREDENTIALS_MISSING");
  process.env.CODECHEF_PASSWORD = "s3cret";
}

/* ── Sandbox command construction ── */

{
  const lang = sandbox.getLanguage("C++");
  const args = sandbox.buildDockerArgs({
    lang,
    hostDir: "/tmp/x",
    name: "n1",
    limits: { memory: "512m", cpus: 1, pids: 64, compileTimeout: 20, executionTimeout: 5 },
  });
  for (const flag of ["--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m"]) {
    ok(`docker args include ${flag}`, args.includes(flag));
  }
  ok("tmpfs allows exec (Docker's default noexec breaks compiled binaries)", args.some((a) => a.startsWith("--tmpfs=/tmp:rw,exec")));
  ok("code is mounted read-only", args.includes("/tmp/x:/code:ro"));
  const script = args.at(-1);
  ok("script compiles once then runs under timeout", (script.match(/g\+\+/g) ?? []).length === 1 && script.includes("timeout 5 /tmp/solution"));
  eq("aliases resolve", [sandbox.getLanguage("python3")?.name, sandbox.getLanguage("golang")?.name, sandbox.getLanguage("cobol")], ["Python 3", "Go", null]);
  eq("timing marker is stripped from stderr", sandbox.extractTiming("warn\n__MCP_RUN_NS__ 1000000000 1250000000"), { stderr: "warn", seconds: 0.25 });
  const unsupported = await sandbox.runCode("cobol", "x");
  eq("unsupported language fails cleanly", [unsupported.success, unsupported.stderr.startsWith("Unsupported language")], [false, true]);
}

/* ── Contest progress, confidence ── */

{
  solver.resetContestStates();
  eq("progress before open_contest is an error", workflow.contestProgress("START1").status, "error");
  const state = solver.createContestState("START1", [{ code: "A" }, { code: "B" }, { code: "C" }]);
  state.markAttempted("A");
  state.markSolved("A");
  state.markSkipped("B");
  const p = workflow.contestProgress("start1");
  eq("progress counts solved", [p.solved, p.total_problems, p.completion_rate], [1, 3, "33%"]);
  eq("next problem skips skipped ones first", p.next_problem, "C");

  const full = solver.evaluateConfidence({
    sampleResults: [{ success: true }, { success: true }],
    generatedResults: Array(10).fill({ success: true }),
    complexityEstimate: "O(n log n)",
    timeLimit: 1,
    avgExecutionTime: 0.2,
  });
  eq("perfect run scores 100 and should submit", [full.score, full.should_submit], [100, true]);
  const weak = solver.evaluateConfidence({
    sampleResults: [{ success: true }, { success: false }],
    generatedResults: [{ success: true }, { success: false }],
    complexityEstimate: "O(2^n)",
    avgExecutionTime: 0.95,
  });
  eq("weak run scores 20 and should not submit", [weak.score, weak.should_submit], [20, false]);
  eq("complexity matching ignores spacing", solver.evaluateConfidence({ complexityEstimate: "O(nlogn)" }).breakdown.complexity.valid, true);
  eq("analyzeFailure handles TLE as critical", solver.analyzeFailure("TLE").priority, "critical");
}

fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
