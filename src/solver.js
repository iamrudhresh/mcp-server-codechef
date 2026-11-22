import { config } from "./config.js";

/**
 * Pure solving helpers: contest progress tracking, failure analysis and the
 * pre-submission confidence score. Ported 1:1 from the Python runtime
 * (app/solver, app/retry_engine, app/validator/confidence.py).
 */

/* ── Contest progress ───────────────────────────────────────────── */

export class ContestState {
  constructor(contestCode, problems) {
    this.contestCode = contestCode;
    this.problems = new Map(problems.map((p) => [p.code, p]));
    this.solved = new Set();
    this.skipped = new Set();
    this.attempted = new Set();
    this.submissionHistory = new Map();
  }

  get unsolved() {
    return [...this.problems.keys()].filter((c) => !this.solved.has(c));
  }

  get progress() {
    const total = this.problems.size;
    return {
      contest_code: this.contestCode,
      total_problems: total,
      solved: this.solved.size,
      solved_codes: [...this.solved].sort(),
      attempted: this.attempted.size,
      skipped: [...this.skipped].sort(),
      remaining: this.unsolved.sort(),
      completion_rate: total ? `${Math.round((this.solved.size / total) * 100)}%` : "0%",
      next_problem: this.nextProblem(),
    };
  }

  markSolved(code) {
    this.solved.add(code);
    this.skipped.delete(code);
  }

  markAttempted(code) {
    this.attempted.add(code);
  }

  markSkipped(code) {
    this.skipped.add(code);
  }

  recordSubmission(code, submission) {
    if (!this.submissionHistory.has(code)) this.submissionHistory.set(code, []);
    this.submissionHistory.get(code).push(submission);
  }

  /** Unsolved, unskipped problems first (in order), then revisit skipped ones. */
  nextProblem() {
    for (const code of this.problems.keys()) {
      if (!this.solved.has(code) && !this.skipped.has(code)) return code;
    }
    for (const code of [...this.skipped].sort()) {
      if (!this.solved.has(code)) return code;
    }
    return null;
  }
}

const activeContests = new Map();

export function createContestState(contestCode, problems) {
  const state = new ContestState(contestCode, problems);
  activeContests.set(contestCode, state);
  return state;
}

export function getContestState(contestCode) {
  return activeContests.get(String(contestCode).toUpperCase()) ?? null;
}

export function resetContestStates() {
  activeContests.clear();
}

/* ── Retry / failure analysis ───────────────────────────────────── */

const retryStates = new Map();

export function getRetryState(problemCode) {
  if (!retryStates.has(problemCode)) {
    const attempts = [];
    retryStates.set(problemCode, {
      problemCode,
      attempts,
      recordAttempt({ verdict, code, analysis = "" }) {
        attempts.push({
          attempt: attempts.length + 1,
          verdict,
          code_snippet: code.length > 200 ? `${code.slice(0, 200)}...` : code,
          analysis,
        });
      },
      toJSON() {
        return {
          problem_code: problemCode,
          retry_count: attempts.length,
          max_retries: config.maxRetries,
          can_retry: attempts.length < config.maxRetries,
          attempts,
        };
      },
    });
  }
  return retryStates.get(problemCode);
}

export function resetRetryStates() {
  retryStates.clear();
}

/** Diagnose a failed verdict and suggest a fix approach. */
export function analyzeFailure(verdict, { stderr = "", failedInput = "" } = {}) {
  const v = String(verdict ?? "");
  const analysis = { verdict: v, diagnosis: "", suggested_approach: "", priority: "high" };

  if (["WA", "Wrong Answer", "PAC", "Partially Accepted"].includes(v)) {
    analysis.diagnosis =
      "Solution produces incorrect output. Possible causes: edge case not handled, off-by-one error, " +
      "integer overflow, incorrect algorithm logic.";
    analysis.suggested_approach = [
      "1. Re-check algorithm correctness",
      "2. Test with boundary values (N=0, N=1, max N)",
      "3. Check for integer overflow (use long long for C++)",
      "4. Compare with brute-force on small inputs",
      "5. Review edge cases in problem statement",
    ].join("\n");
  } else if (["TLE", "Time Limit Exceeded"].includes(v)) {
    analysis.diagnosis =
      "Solution is too slow. The time complexity is likely too high for the given constraints.";
    analysis.suggested_approach = [
      "1. Analyze current complexity — aim for O(n log n) or better",
      "2. Eliminate nested loops where possible",
      "3. Use efficient data structures (sets, maps, priority queues)",
      "4. Consider binary search, two pointers, or divide and conquer",
      "5. Pre-compute values to avoid redundant calculations",
    ].join("\n");
    analysis.priority = "critical";
  } else if (["RE", "Runtime Error", "NZEC"].includes(v)) {
    analysis.diagnosis =
      "Solution crashed during execution. Possible causes: array index out of bounds, null pointer, " +
      "division by zero, stack overflow (deep recursion).";
    analysis.suggested_approach = [
      "1. Check array bounds and validate indices",
      "2. Handle empty input / edge cases",
      "3. Check for division by zero",
      "4. Increase recursion limit or convert to iterative",
      "5. Validate all input assumptions",
    ].join("\n");
    if (stderr) analysis.stderr_clue = stderr.slice(0, 500);
  } else if (["MLE", "Memory Limit Exceeded"].includes(v)) {
    analysis.diagnosis =
      "Solution uses too much memory. Possible causes: large arrays, excessive recursion, unnecessary data storage.";
    analysis.suggested_approach = [
      "1. Reduce space complexity",
      "2. Use in-place algorithms",
      "3. Process input in chunks/streaming",
      "4. Avoid storing all intermediate results",
    ].join("\n");
  } else if (["CE", "CTE", "Compilation Error"].includes(v)) {
    analysis.diagnosis = "Code failed to compile.";
    analysis.suggested_approach = [
      "1. Fix syntax errors",
      "2. Check language version compatibility",
      "3. Verify all imports/includes",
    ].join("\n");
    if (stderr) analysis.compile_error = stderr.slice(0, 500);
  } else {
    analysis.diagnosis = `Unknown verdict: ${v}`;
    analysis.suggested_approach = "Review the submission details and try again.";
  }

  if (failedInput) {
    analysis.failed_input_preview = failedInput.length > 200 ? `${failedInput.slice(0, 200)}...` : failedInput;
  }
  return analysis;
}

/* ── Confidence score ───────────────────────────────────────────── */

const VALID_COMPLEXITIES = ["O(1)", "O(log n)", "O(sqrt(n))", "O(n)", "O(n log n)", "O(n^2)", "O(n^2 log n)"];

/**
 * Score a solution before submitting (out of 100):
 * sample tests 30, generated tests up to 40, complexity 15, runtime 15.
 */
export function evaluateConfidence({
  sampleResults = [],
  generatedResults = [],
  complexityEstimate = "",
  timeLimit = 1.0,
  avgExecutionTime = 0,
} = {}) {
  const passed = (list) => list.filter((r) => r?.success === true).length;

  const samplePass = sampleResults.length > 0 && passed(sampleResults) === sampleResults.length;
  const sampleDetails = sampleResults.length
    ? `${passed(sampleResults)}/${sampleResults.length} sample tests passed`
    : "No sample tests available";

  const generatedRate = generatedResults.length ? passed(generatedResults) / generatedResults.length : 0;
  const generatedDetails = generatedResults.length
    ? `${passed(generatedResults)}/${generatedResults.length} generated tests passed`
    : "No generated tests run";

  // Normalize spacing so "O(n log n)" matches "O(nlogn)" and vice versa.
  const squash = (s) => s.toLowerCase().replace(/\s+/g, "");
  const complexityValid =
    Boolean(complexityEstimate) && VALID_COMPLEXITIES.some((c) => squash(complexityEstimate).includes(squash(c)));

  const runtimeAcceptable = avgExecutionTime > 0 && avgExecutionTime < timeLimit * 0.8;

  const score =
    (samplePass ? 30 : 0) +
    Math.floor(40 * generatedRate) +
    (complexityValid ? 15 : 0) +
    (runtimeAcceptable ? 15 : 0);

  return {
    score,
    threshold: config.confidenceThreshold,
    should_submit: score >= config.confidenceThreshold,
    breakdown: {
      sample_tests: { passed: samplePass, details: sampleDetails, points: samplePass ? 30 : 0 },
      generated_tests: {
        passed: generatedRate >= 0.9,
        pass_rate: `${Math.round(generatedRate * 100)}%`,
        details: generatedDetails,
        points: Math.floor(40 * generatedRate),
      },
      complexity: {
        valid: complexityValid,
        estimate: complexityEstimate || "Not estimated",
        points: complexityValid ? 15 : 0,
      },
      runtime: {
        acceptable: runtimeAcceptable,
        estimate: avgExecutionTime > 0 ? `${avgExecutionTime.toFixed(3)}s (limit: ${timeLimit}s)` : "Not measured",
        points: runtimeAcceptable ? 15 : 0,
      },
    },
  };
}
