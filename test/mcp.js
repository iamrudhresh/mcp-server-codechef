/**
 * End-to-end MCP test: boots the stdio server, checks every tool is exposed,
 * and calls tools over the protocol. Live CodeChef calls can be skipped with
 * SKIP_LIVE=1. Credentials are deliberately removed so the submit path is
 * checked for a clean, actionable error.
 *
 * Run with: npm run test:mcp
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let pass = 0;
let fail = 0;
const check = (label, condition, detail = "") => {
  condition ? pass++ : fail++;
  console.log(`${condition ? "PASS" : "FAIL"}  ${label}${condition ? "" : `  ${String(detail).slice(0, 300)}`}`);
};

const EXPECTED = [
  "get_profile", "get_rating_history", "get_activity", "get_contests", "get_solved_problems", "compare_users",
  "open_contest", "list_problems", "get_problem", "validate_complexity", "generate_tests",
  "get_contest_progress", "run_code", "evaluate_confidence", "submit_solution", "get_submission_status",
  "retry_solution", "get_submission_history",
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), "codechef-mcp-e2e-"));
const env = { ...process.env, CODECHEF_MCP_HOME: home };
delete env.CODECHEF_USERNAME;
delete env.CODECHEF_PASSWORD;

const client = new Client({ name: "codechef-mcp-test", version: "1.0.0" });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL("../src/server.js", import.meta.url))],
    env,
    stderr: "ignore",
  }),
);

const text = (res) => res.content?.find((c) => c.type === "text")?.text ?? "";

const { tools } = await client.listTools();
check(`exposes all ${EXPECTED.length} tools`, tools.length === EXPECTED.length, tools.map((t) => t.name).join(","));
for (const name of EXPECTED) check(`tool '${name}' is registered`, tools.some((t) => t.name === name));
for (const t of tools) check(`tool '${t.name}' has an object schema`, t.inputSchema?.type === "object");
check("submit_solution is not marked read-only", tools.find((t) => t.name === "submit_solution")?.annotations?.readOnlyHint === false);

const conf = await client.callTool({
  name: "evaluate_confidence",
  arguments: {
    problemCode: "flow001",
    sampleResults: [{ success: true }],
    generatedResults: [{ success: true }, { success: true }],
    complexityEstimate: "O(n)",
    avgExecutionTime: 0.1,
  },
});
const confJson = JSON.parse(text(conf));
check("evaluate_confidence scores over MCP", confJson.score === 100 && confJson.problem_code === "FLOW001", text(conf));

const progress = await client.callTool({ name: "get_contest_progress", arguments: { contestCode: "NOPE1" } });
check("get_contest_progress explains open_contest is needed", text(progress).includes("open_contest"), text(progress));

const submit = await client.callTool({
  name: "submit_solution",
  arguments: { contestCode: "PRACTICE", problemCode: "FLOW001", language: "cpp", code: "int main(){}" },
});
check(
  "submit_solution without credentials returns CREDENTIALS_MISSING",
  submit.isError === true && text(submit).includes("CREDENTIALS_MISSING"),
  text(submit),
);

const history = await client.callTool({ name: "get_submission_history", arguments: { contestCode: "PRACTICE", problemCode: "FLOW001" } });
check("get_submission_history returns an empty list", JSON.parse(text(history)).length === 0, text(history));

const run = await client.callTool({ name: "run_code", arguments: { language: "python", code: "print(6*7)" } });
const runJson = JSON.parse(text(run));
check(
  "run_code returns a result (output, or a clear Docker message)",
  runJson.stdout === "42" || /Docker is not installed/.test(runJson.stderr),
  text(run),
);

if (process.env.SKIP_LIVE !== "1") {
  const profile = await client.callTool({ name: "get_profile", arguments: { handle: "aryanc403" } });
  check("get_profile returns a live profile", !profile.isError && JSON.parse(text(profile)).username === "aryanc403", text(profile));

  const parent = await client.callTool({ name: "open_contest", arguments: { contestCode: "START100" } });
  const parentJson = JSON.parse(text(parent));
  check(
    "parent contest lists its divisions",
    parentJson.divisions?.some((d) => d.contest_code === "START100A") && /division/i.test(parentJson.message ?? ""),
    text(parent),
  );

  const opened = await client.callTool({ name: "open_contest", arguments: { contestCode: "START100A" } });
  check("open_contest loads a real division contest", !opened.isError && JSON.parse(text(opened)).problem_count > 0, text(opened));
  const tracked = await client.callTool({ name: "get_contest_progress", arguments: { contestCode: "START100A" } });
  check("open_contest starts progress tracking", JSON.parse(text(tracked)).total_problems > 0, text(tracked));

  const bad = await client.callTool({ name: "get_profile", arguments: { handle: "this_user_definitely_does_not_exist_9f3a" } });
  check("unknown user is an error result", bad.isError === true, text(bad));
}

await client.close();
fs.rmSync(home, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
