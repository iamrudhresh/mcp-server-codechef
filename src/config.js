import os from "node:os";
import path from "node:path";

/**
 * Runtime configuration, read from environment variables on every access so
 * MCP clients (and tests) can change them without restarting the module.
 *
 * Everything is optional. Credentials are only needed for submit_solution and
 * get_submission_status; Docker is only needed for run_code.
 */
const num = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

export const config = {
  get username() {
    return process.env.CODECHEF_USERNAME ?? "";
  },
  get password() {
    return process.env.CODECHEF_PASSWORD ?? "";
  },
  /** Where submission history, execution logs and the login session are kept. */
  get home() {
    return process.env.CODECHEF_MCP_HOME || path.join(os.homedir(), ".mcp-server-codechef");
  },
  get sandbox() {
    return {
      memory: process.env.SANDBOX_MEMORY_LIMIT || "512m",
      cpus: num(process.env.SANDBOX_CPU_LIMIT, 1),
      pids: num(process.env.SANDBOX_PID_LIMIT, 64),
      compileTimeout: num(process.env.COMPILE_TIMEOUT, 20),
      executionTimeout: num(process.env.EXECUTION_TIMEOUT, 5),
    };
  },
  get maxRetries() {
    return num(process.env.MAX_RETRIES, 3);
  },
  get confidenceThreshold() {
    return num(process.env.CONFIDENCE_THRESHOLD, 75);
  },
};
