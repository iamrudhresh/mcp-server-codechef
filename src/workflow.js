import { openContest } from "./contest.js";
import { getVerdict, submitSolution } from "./judge.js";
import { runCode as runInSandbox } from "./sandbox.js";
import {
  analyzeFailure,
  createContestState,
  evaluateConfidence,
  getContestState,
  getRetryState,
} from "./solver.js";
import { getProblemSubmissions, getSubmission, saveExecutionLog, saveSubmission } from "./store.js";

/**
 * Tool-level orchestration shared by the MCP layer: each function mirrors one
 * Python tool in app/tools/*.py, including its side effects (history, progress).
 */

const upper = (s) => String(s ?? "").trim().toUpperCase();

/** open_contest also starts a progress tracker for the contest. */
export async function openContestTracked(contestCode) {
  const details = await openContest(contestCode);
  createContestState(details.contest_code, details.problems);
  return details;
}

export function contestProgress(contestCode) {
  const state = getContestState(upper(contestCode));
  if (!state) {
    return {
      status: "error",
      message: `Contest ${upper(contestCode)} is not active. Call 'open_contest' first.`,
    };
  }
  return state.progress;
}

export async function runCodeLogged(language, code, stdin) {
  const result = await runInSandbox(language, code, stdin);
  try {
    saveExecutionLog({
      language,
      exit_code: result.exit_code,
      timed_out: result.timed_out,
      execution_time: result.execution_time,
      compile_error: result.compile_error.slice(0, 2000),
    });
  } catch {
    /* logging must never fail a run */
  }
  return result;
}

export async function submit({ contestCode, problemCode, language, code }) {
  const result = await submitSolution({ contestCode, problemCode, language, code });
  saveSubmission({
    submission_id: result.submission_id,
    contest_code: result.contest_code,
    problem_code: result.problem_code,
    language: result.language,
    code,
  });
  const state = getContestState(result.contest_code);
  if (state) {
    state.markAttempted(result.problem_code);
    state.recordSubmission(result.problem_code, {
      submission_id: result.submission_id,
      language: result.language,
      code_preview: code.slice(0, 200),
      status: "Pending",
    });
  }
  return {
    ...result,
    next_step: "Call get_submission_status with this submission_id to wait for the verdict.",
  };
}

export async function submissionStatus(submissionId, { waitSeconds } = {}) {
  const verdict = await getVerdict(submissionId, { waitSeconds });
  const stored = getSubmission(verdict.submission_id);
  if (stored && !verdict.pending) {
    saveSubmission({
      submission_id: verdict.submission_id,
      verdict: verdict.verdict,
      verdict_code: verdict.verdict_code,
      execution_time: verdict.execution_time,
      memory: verdict.memory,
      compile_info: verdict.cmpinfo ?? verdict.compile_info ?? verdict.error_msg ?? "",
    });
    if (verdict.verdict_code === "AC") getContestState(stored.contest_code)?.markSolved(stored.problem_code);
  }
  return verdict;
}

export function retrySolution(contestCode, problemCode) {
  const contest = upper(contestCode);
  const problem = upper(problemCode);
  const retryState = getRetryState(problem);
  const submissions = getProblemSubmissions(problem, contest);

  if (!submissions.length) {
    return {
      status: "info",
      message: "No submissions recorded for this problem yet. Submit with submit_solution first.",
      retry_state: retryState.toJSON(),
    };
  }

  const latest = submissions[0];
  if (latest.verdict_code === "AC") {
    return { status: "success", message: "Problem is already Accepted! No retry needed.", retry_state: retryState.toJSON() };
  }
  if (latest.verdict_code === "wait") {
    return {
      status: "info",
      message: `Latest submission ${latest.submission_id} has no verdict yet. Call get_submission_status first.`,
      retry_state: retryState.toJSON(),
    };
  }

  const analysis = analyzeFailure(latest.verdict_code, { stderr: latest.compile_info ?? "" });
  retryState.recordAttempt({ verdict: latest.verdict, code: latest.code, analysis: analysis.diagnosis });
  return {
    status: "retry_needed",
    retry_state: retryState.toJSON(),
    analysis,
    latest_submission_id: latest.submission_id,
    latest_code: latest.code,
  };
}

export function submissionHistory(contestCode, problemCode) {
  return getProblemSubmissions(upper(problemCode), upper(contestCode)).map((s) => ({
    submission_id: s.submission_id,
    contest_code: s.contest_code,
    problem_code: s.problem_code,
    language: s.language,
    verdict: s.verdict,
    verdict_code: s.verdict_code,
    execution_time: s.execution_time,
    memory: s.memory,
    timestamp: s.timestamp,
  }));
}

export { evaluateConfidence };
