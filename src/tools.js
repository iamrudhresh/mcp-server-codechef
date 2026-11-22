import { z } from "zod";
import {
  compareUsers,
  getActivity,
  getContests,
  getProfile,
  getRatingHistory,
  getSolvedProblems,
  listProblems,
  getProblem,
  validateComplexity,
  generateTests,
} from "./api.js";
import { SUPPORTED_LANGUAGES } from "./sandbox.js";
import {
  contestProgress,
  evaluateConfidence,
  openContestTracked,
  retrySolution,
  runCodeLogged,
  submissionHistory,
  submissionStatus,
  submit,
} from "./workflow.js";

const contestCodeSchema = z.string().min(1).max(40).describe("Contest code, e.g. 'START123' (use 'PRACTICE' for practice problems)");
const problemCodeSchema = z.string().min(1).max(40).describe("Problem code, e.g. 'FLOW001'");
const testResultSchema = z
  .object({ success: z.boolean() })
  .passthrough()
  .describe("A test run result; only 'success' is required (run_code returns it).");

const handleSchema = z
  .string()
  .min(1)
  .max(64)
  .describe("CodeChef username/handle, e.g. 'gennady.korotkevich'");

const json = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const fail = (err) => ({
  isError: true,
  content: [
    {
      type: "text",
      text: `CodeChef MCP error (${err.code ?? "ERROR"}): ${err.message}`,
    },
  ],
});

const wrap = (fn) => async (args) => {
  try {
    return json(await fn(args));
  } catch (err) {
    return fail(err);
  }
};

export function registerTools(server) {
  server.registerTool(
    "get_profile",
    {
      title: "Get CodeChef profile",
      description:
        "Fetch a CodeChef user's profile as compact structured JSON: name, star rating, " +
        "current and highest rating, division, global rank, country rank, problems solved, " +
        "contests participated, latest contest and recent form. Prefer this over downloading " +
        "and parsing the profile HTML page.",
      inputSchema: { handle: handleSchema },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handle }) => getProfile(handle)),
  );

  server.registerTool(
    "get_rating_history",
    {
      title: "Get CodeChef rating history",
      description:
        "Return a user's contest rating history (newest first) with rating after each contest, " +
        "rating change (delta) and rank. Useful for trends, streaks and 'how has X improved' questions.",
      inputSchema: {
        handle: handleSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe("How many recent contests to return (default 20)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handle, limit }) => getRatingHistory(handle, { limit: limit ?? 20 })),
  );

  server.registerTool(
    "get_activity",
    {
      title: "Get CodeChef submission activity",
      description:
        "Summarize a user's submission heat map over a time window: total submissions, active days, " +
        "average per active day, busiest day and monthly totals. Answers 'how active is X' without " +
        "loading the heat map image or HTML.",
      inputSchema: {
        handle: handleSchema,
        days: z
          .number()
          .int()
          .min(7)
          .max(3650)
          .optional()
          .describe("Look-back window in days (default 90). Daily breakdown included only when <= 60."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handle, days }) => getActivity(handle, { days: days ?? 90 })),
  );

  server.registerTool(
    "get_contests",
    {
      title: "Get CodeChef contest results",
      description:
        "List a user's contests (newest first) with the problems solved in each, plus rank and rating change " +
        "where available. Use this for 'what has X solved recently' or per-contest performance.",
      inputSchema: {
        handle: handleSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("How many recent contests to return (default 10)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handle, limit }) => getContests(handle, { limit: limit ?? 10 })),
  );

  server.registerTool(
    "get_solved_problems",
    {
      title: "Get CodeChef solved problems",
      description:
        "Return the unique problem names a user has solved (as listed on their profile), with the contest " +
        "each came from, plus their reported total solved count. Capped by 'limit' to protect context size.",
      inputSchema: {
        handle: handleSchema,
        limit: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Maximum number of problem names to return (default 200)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handle, limit }) => getSolvedProblems(handle, { limit: limit ?? 200 })),
  );

  server.registerTool(
    "compare_users",
    {
      title: "Compare CodeChef users",
      description:
        "Fetch compact side-by-side profiles for 2-5 CodeChef handles: rating, stars, ranks, problems solved " +
        "and contest count. Handy for 'who is better' or team-selection questions.",
      inputSchema: {
        handles: z
          .array(z.string().min(1).max(64))
          .min(2)
          .max(5)
          .describe("Two to five CodeChef handles to compare."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ handles }) => compareUsers(handles)),
  );

  server.registerTool(
    "open_contest",
    {
      title: "Open CodeChef contest",
      description:
        "Open a CodeChef contest, fetch problem list, start/end dates, and contest metadata. " +
        "Also starts a progress tracker for get_contest_progress.",
      inputSchema: {
        contestCode: z.string().min(1).describe("Contest code, e.g. 'START123'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ contestCode }) => openContestTracked(contestCode)),
  );

  server.registerTool(
    "list_problems",
    {
      title: "List CodeChef contest problems",
      description: "List all problems in a CodeChef contest with codes, names, and submission counts.",
      inputSchema: {
        contestCode: z.string().min(1).describe("Contest code, e.g. 'START123'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ contestCode }) => listProblems(contestCode)),
  );

  server.registerTool(
    "get_problem",
    {
      title: "Get CodeChef problem details",
      description:
        "Fetch full problem statement, constraints, time/memory limits, and sample test cases.",
      inputSchema: {
        contestCode: z.string().min(1).describe("Contest code, e.g. 'START123'"),
        problemCode: z.string().min(1).describe("Problem code, e.g. 'PROB1'"),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ contestCode, problemCode }) => getProblem(contestCode, problemCode)),
  );

  server.registerTool(
    "validate_complexity",
    {
      title: "Validate algorithmic complexity",
      description:
        "Estimate time and space complexity of code through static loop analysis and comment annotations.",
      inputSchema: {
        code: z.string().min(1).describe("Source code to analyze"),
        language: z.string().optional().describe("Language (cpp, python, java, etc.)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ code, language }) => validateComplexity(code, language ?? "")),
  );

  server.registerTool(
    "generate_tests",
    {
      title: "Generate test cases",
      description:
        "Generate adversarial and edge-case test inputs (minimums, maximums, duplicates, sorted, random) for a problem.",
      inputSchema: {
        problemCode: z.string().min(1).describe("Problem code"),
        constraints: z
          .record(z.string(), z.any())
          .optional()
          .describe("Constraint parameters (n_min, n_max, val_min, val_max, problem_type)"),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ problemCode, constraints }) => generateTests(problemCode, constraints ?? {})),
  );

  /* ── Solving workflow (previously Python-only) ─────────────────── */

  server.registerTool(
    "get_contest_progress",
    {
      title: "Get contest progress",
      description:
        "Track solved, attempted, skipped and remaining problems for a contest opened with open_contest " +
        "in this session, plus the recommended next problem.",
      inputSchema: { contestCode: contestCodeSchema },
      annotations: { readOnlyHint: true },
    },
    wrap(({ contestCode }) => contestProgress(contestCode)),
  );

  server.registerTool(
    "run_code",
    {
      title: "Run code in a sandbox",
      description:
        "Compile and run code in an isolated Docker container (no network, read-only filesystem, " +
        "memory/CPU/process limits) and return stdout, stderr, exit code, timing and any compile error. " +
        `Languages: ${SUPPORTED_LANGUAGES.join(", ")}. Requires Docker to be installed and running.`,
      inputSchema: {
        language: z.string().min(1).describe(`One of: ${SUPPORTED_LANGUAGES.join(", ")} (aliases: c++, python3, golang).`),
        code: z.string().min(1).max(200_000).describe("Complete source code. Java must use class Main."),
        stdin: z.string().max(5_000_000).optional().describe("Input fed to standard input."),
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    wrap(({ language, code, stdin }) => runCodeLogged(language, code, stdin ?? "")),
  );

  server.registerTool(
    "evaluate_confidence",
    {
      title: "Score submission confidence",
      description:
        "Score a solution out of 100 before submitting: sample tests (30), generated tests (40), " +
        "complexity (15) and runtime vs time limit (15). Returns should_submit against the threshold.",
      inputSchema: {
        problemCode: problemCodeSchema,
        sampleResults: z.array(testResultSchema).max(200).describe("Results of running the sample tests."),
        generatedResults: z.array(testResultSchema).max(1000).describe("Results of running generated edge cases."),
        complexityEstimate: z.string().max(100).optional().describe("Estimated complexity, e.g. 'O(n log n)'."),
        timeLimit: z.number().positive().max(60).optional().describe("Problem time limit in seconds (default 1)."),
        avgExecutionTime: z.number().min(0).max(600).optional().describe("Average run time in seconds."),
      },
      annotations: { readOnlyHint: true },
    },
    wrap(({ problemCode, sampleResults, generatedResults, complexityEstimate, timeLimit, avgExecutionTime }) => ({
      problem_code: problemCode.toUpperCase(),
      ...evaluateConfidence({
        sampleResults,
        generatedResults,
        complexityEstimate: complexityEstimate ?? "",
        timeLimit: timeLimit ?? 1,
        avgExecutionTime: avgExecutionTime ?? 0,
      }),
    })),
  );

  server.registerTool(
    "submit_solution",
    {
      title: "Submit a solution to CodeChef",
      description:
        "Submit source code to CodeChef for judging on your account and return the submission id. " +
        "Requires CODECHEF_USERNAME and CODECHEF_PASSWORD in this server's env config. " +
        "Languages: cpp, c, python, pypy, java, go, rust, javascript (or any CodeChef language name). " +
        "Follow up with get_submission_status.",
      inputSchema: {
        contestCode: contestCodeSchema,
        problemCode: problemCodeSchema,
        language: z.string().min(1).max(40).describe("Language, e.g. 'cpp', 'python', 'java'."),
        code: z.string().min(1).max(65_536).describe("Complete source code to submit."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    wrap(({ contestCode, problemCode, language, code }) => submit({ contestCode, problemCode, language, code })),
  );

  server.registerTool(
    "get_submission_status",
    {
      title: "Get CodeChef submission verdict",
      description:
        "Wait for and return the verdict of a submission (Accepted, Wrong Answer, Time Limit Exceeded, " +
        "Runtime Error, Compilation Error, Partially Accepted) with time, memory and compile output. " +
        "Requires the same credentials as submit_solution.",
      inputSchema: {
        submissionId: z.string().min(1).max(20).describe("The submission_id returned by submit_solution."),
        waitSeconds: z.number().int().min(0).max(180).optional().describe("How long to wait for judging (default 60)."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    wrap(({ submissionId, waitSeconds }) => submissionStatus(submissionId, { waitSeconds: waitSeconds ?? 60 })),
  );

  server.registerTool(
    "retry_solution",
    {
      title: "Diagnose a failed submission",
      description:
        "Look up the latest recorded submission for a problem and, if it failed, diagnose the verdict " +
        "(WA/TLE/RE/MLE/CE) with concrete fix strategies and the code that failed. Tracks attempt count.",
      inputSchema: { contestCode: contestCodeSchema, problemCode: problemCodeSchema },
      annotations: { readOnlyHint: true },
    },
    wrap(({ contestCode, problemCode }) => retrySolution(contestCode, problemCode)),
  );

  server.registerTool(
    "get_submission_history",
    {
      title: "Get submission history",
      description:
        "List submissions made through this server for a problem (newest first) with verdicts, time and memory.",
      inputSchema: { contestCode: contestCodeSchema, problemCode: problemCodeSchema },
      annotations: { readOnlyHint: true },
    },
    wrap(({ contestCode, problemCode }) => submissionHistory(contestCode, problemCode)),
  );
}
