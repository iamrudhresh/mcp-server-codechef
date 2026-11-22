import * as cheerio from "cheerio";
import { fetchJson } from "./http.js";

/**
 * Convert HTML problem body into clean Markdown/plain text.
 */
export function htmlToText(html = "") {
  if (!html) return "";
  const $ = cheerio.load(html);

  // Replace MathJax tags or math spans with inner text
  $("script[type='math/tex']").each((_, el) => {
    $(el).replaceWith(`$${$(el).text()}$`);
  });

  $("pre, code").each((_, el) => {
    const code = $(el).text();
    $(el).replaceWith(`\n\`\`\`\n${code}\n\`\`\`\n`);
  });

  $("p").each((_, el) => {
    $(el).append("\n\n");
  });

  $("li").each((_, el) => {
    $(el).prepend("- ");
    $(el).append("\n");
  });

  return $.text()
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract sample inputs and outputs from problem HTML.
 */
export function extractSamples(html = "") {
  if (!html) return { sampleInputs: [], sampleOutputs: [] };
  const $ = cheerio.load(html);

  const inputs = [];
  const outputs = [];

  // Alternate pre tags are standard input/output pairs in CodeChef
  const preTags = $("pre").toArray();
  for (let i = 0; i < preTags.length; i++) {
    const text = $(preTags[i]).text().trim();
    if (i % 2 === 0) {
      inputs.push(text);
    } else {
      outputs.push(text);
    }
  }

  return { sampleInputs: inputs, sampleOutputs: outputs };
}

/**
 * Fetch contest details and problem list from CodeChef.
 */
export async function openContest(contestCode) {
  const code = contestCode.toUpperCase();
  const { data } = await fetchJson(`/contests/${code}`);

  const problems = [];
  const problemMap = data?.problems ?? {};

  for (const [probCode, info] of Object.entries(problemMap)) {
    problems.push({
      code: probCode,
      name: info?.name ?? probCode,
      category: info?.category_name ?? "",
      successful_submissions: info?.successful_submissions ?? 0,
    });
  }

  problems.sort((a, b) => a.code.localeCompare(b.code));

  const result = {
    status: "success",
    contest_code: code,
    contest_name: data?.name ?? code,
    start_date: data?.start_date ?? "",
    end_date: data?.end_date ?? "",
    problems,
    problem_count: problems.length,
  };

  // Starters-style contests are parents: the problems live in per-division
  // child contests (START100A, START100B, ...), and the parent lists none.
  const divisions = parseDivisions(data?.child_contests);
  if (divisions.length) {
    result.divisions = divisions;
    if (!problems.length) {
      result.message =
        "This is a parent contest with no problems of its own. Open one of the division " +
        `contests instead, e.g. open_contest("${divisions[divisions.length - 1].contest_code}").`;
    }
  }
  return result;
}

/** Normalize the `child_contests` map of a parent contest. */
export function parseDivisions(childContests) {
  if (!childContests || typeof childContests !== "object") return [];
  return Object.values(childContests)
    .filter((c) => c && c.contest_code)
    .map((c) => ({
      division: c.div?.name ?? null,
      contest_code: String(c.contest_code),
      min_rating: c.div?.min_rating ?? null,
      max_rating: c.div?.max_rating ?? null,
    }))
    .sort((a, b) => a.contest_code.localeCompare(b.contest_code));
}

/**
 * List all problems for a contest.
 */
export async function listProblems(contestCode) {
  const details = await openContest(contestCode);
  return details.problems;
}

/**
 * Fetch full problem statement, limits, and samples.
 */
export async function getProblem(contestCode, problemCode) {
  const cCode = contestCode.toUpperCase();
  const pCode = problemCode.toUpperCase();

  const { data } = await fetchJson(`/contests/${cCode}/problems/${pCode}`);

  const bodyHtml = data?.body ?? "";
  const statement = htmlToText(bodyHtml);
  const { sampleInputs, sampleOutputs } = extractSamples(bodyHtml);

  return {
    problem_code: pCode,
    contest_code: cCode,
    name: data?.problem_name ?? pCode,
    statement,
    time_limit: data?.max_timelimit ?? "1",
    memory_limit: data?.source_sizelimit ?? "50000",
    difficulty: data?.difficulty_rating ?? "unknown",
    sample_inputs: sampleInputs,
    sample_outputs: sampleOutputs,
  };
}

/**
 * Static analysis of time and space complexity based on code structure.
 */
export function validateComplexity(code = "", language = "") {
  // Check for explicit complexity comment
  const commentMatch = /(?:complexity|time\s+complexity)\s*[:=-]?\s*([oO]\s*\([^)]+\))/i.exec(code);
  if (commentMatch) {
    return {
      complexity: commentMatch[1].trim(),
      source: "code_comment",
      explanation: "Found explicit complexity annotation in comments.",
    };
  }

  let maxDepth = 0;
  let currentDepth = 0;
  const lines = code.split("\n");

  for (const line of lines) {
    const stripped = line.trim();
    if (
      stripped.startsWith("//") ||
      stripped.startsWith("#") ||
      stripped.startsWith("*")
    ) {
      continue;
    }

    const loopMatches = stripped.match(/(?:for\s*\(|while\s*\(|for\s+|while\s+)/g);
    if (loopMatches) {
      currentDepth += loopMatches.length;
      if (currentDepth > maxDepth) maxDepth = currentDepth;
    }

    const closeMatches = stripped.match(/\}/g);
    if (closeMatches) {
      currentDepth = Math.max(0, currentDepth - closeMatches.length);
    } else if (language.toLowerCase() === "python" && stripped === "") {
      currentDepth = Math.max(0, currentDepth - 1);
    }
  }

  let complexity = "O(1)";
  let explanation = "No loops or recursion detected in code.";

  if (maxDepth === 1) {
    complexity = "O(n)";
    explanation = "Single level loop detected. Linear time complexity assumed.";
  } else if (maxDepth === 2) {
    complexity = "O(n^2)";
    explanation = "Double-nested loop structure detected. Quadratic time complexity assumed.";
  } else if (maxDepth > 2) {
    complexity = `O(n^${maxDepth})`;
    explanation = `Deeply nested loop structure (${maxDepth} levels) detected.`;
  }

  return { complexity, source: "heuristic", explanation, max_loop_depth: maxDepth };
}

/**
 * Generate adversarial and edge-case test inputs.
 */
export function generateTests(problemCode, constraints = {}) {
  const nMin = Number(constraints.n_min ?? 1);
  const nMax = Number(constraints.n_max ?? 100000);
  const valMin = Number(constraints.val_min ?? -1e9);
  const valMax = Number(constraints.val_max ?? 1e9);
  const problemType = String(constraints.problem_type ?? "array").toLowerCase();

  const cases = [];

  if (problemType === "string") {
    cases.push({
      name: "minimum_input",
      description: "Minimum allowed string length",
      input: `1\n${"a".repeat(nMin)}`,
    });
    cases.push({
      name: "maximum_input",
      description: "Maximum allowed string length",
      input: `1\n${"z".repeat(Math.min(nMax, 1000))}`,
    });
    cases.push({
      name: "duplicate_values",
      description: "Single repeating character",
      input: `1\n${"a".repeat(10)}`,
    });
  } else {
    // Array / integer defaults
    cases.push({
      name: "minimum_input",
      description: "Single element array with minimum bounds",
      input: `1\n${nMin}\n${valMin}`,
    });
    cases.push({
      name: "maximum_input",
      description: "Large array near upper limits",
      input: `1\n${Math.min(nMax, 1000)}\n${Array(Math.min(nMax, 10)).fill(valMax).join(" ")}`,
    });
    cases.push({
      name: "duplicate_values",
      description: "All elements identical",
      input: `1\n5\n7 7 7 7 7`,
    });
    cases.push({
      name: "sorted_ascending",
      description: "Strictly ascending array",
      input: `1\n5\n1 2 3 4 5`,
    });
    cases.push({
      name: "sorted_descending",
      description: "Strictly descending array",
      input: `1\n5\n5 4 3 2 1`,
    });
    cases.push({
      name: "boundary_values",
      description: "Zero and sign flips",
      input: `1\n4\n-1 0 1 0`,
    });
  }

  return cases;
}
