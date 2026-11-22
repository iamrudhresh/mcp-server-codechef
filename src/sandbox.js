import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { config } from "./config.js";

/**
 * Secure code execution in a throw-away Docker container.
 *
 * Each run gets: no network, read-only root filesystem, all capabilities
 * dropped, no privilege escalation, memory/CPU/PID limits, and a writable
 * /tmp. The source and stdin are mounted read-only.
 *
 * Differences from the original Python runner (bugs fixed here):
 *  - /tmp is mounted with `exec`; Docker's tmpfs default is `noexec`, which
 *    made every compiled binary (C++, Go, Rust) fail with "permission denied".
 *  - The program is compiled once (the Python runner compiled twice).
 *  - On timeout the container itself is killed; killing only the docker CLI
 *    left the container running.
 *  - Go gets a writable HOME/GOCACHE, which `go build` needs on a read-only root.
 */
export const LANGUAGES = {
  cpp: {
    name: "C++17",
    image: "gcc:13",
    file: "solution.cpp",
    compile: "g++ -std=c++17 -O2 -o /tmp/solution /tmp/solution.cpp",
    run: "/tmp/solution",
  },
  cpp14: {
    name: "C++14",
    image: "gcc:13",
    file: "solution.cpp",
    compile: "g++ -std=c++14 -O2 -o /tmp/solution /tmp/solution.cpp",
    run: "/tmp/solution",
  },
  c: {
    name: "C",
    image: "gcc:13",
    file: "solution.c",
    compile: "gcc -std=c17 -O2 -o /tmp/solution /tmp/solution.c -lm",
    run: "/tmp/solution",
  },
  python: {
    name: "Python 3",
    image: "python:3.12-slim",
    file: "solution.py",
    compile: null,
    run: "python3 /tmp/solution.py",
  },
  java: {
    name: "Java",
    image: "eclipse-temurin:21-jdk",
    file: "Main.java",
    compile: "javac -d /tmp /tmp/Main.java",
    run: "java -Xss64m -cp /tmp Main",
  },
  go: {
    name: "Go",
    image: "golang:1.22-alpine",
    file: "solution.go",
    compile: "go build -o /tmp/solution /tmp/solution.go",
    run: "/tmp/solution",
  },
  rust: {
    name: "Rust",
    image: "rust:1.75-slim",
    file: "solution.rs",
    compile: "rustc -O -o /tmp/solution /tmp/solution.rs",
    run: "/tmp/solution",
  },
};

const ALIASES = { "c++": "cpp", cpp17: "cpp", python3: "python", py: "python", golang: "go", rs: "rust" };

export function getLanguage(language) {
  const key = String(language ?? "").trim().toLowerCase();
  return LANGUAGES[ALIASES[key] ?? key] ?? null;
}

export const SUPPORTED_LANGUAGES = Object.keys(LANGUAGES);

const MAX_OUTPUT_BYTES = 64 * 1024;
const COMPILE_ERROR_EXIT = 97;
const TIME_MARKER = "__MCP_RUN_NS__";

/** The shell script executed inside the container. */
export function buildScript(lang, executionTimeout) {
  const steps = [`cp /code/${lang.file} /tmp/${lang.file}`];
  if (lang.compile) {
    steps.push(
      `${lang.compile} > /tmp/compile.log 2>&1 || { cat /tmp/compile.log >&2; exit ${COMPILE_ERROR_EXIT}; }`,
    );
  }
  steps.push(
    `s=$(date +%s%N)`,
    `timeout ${executionTimeout} ${lang.run} < /code/input.txt`,
    `rc=$?`,
    `e=$(date +%s%N)`,
    `echo "${TIME_MARKER} $s $e" >&2`,
    `exit $rc`,
  );
  return steps.join("\n");
}

/** Every security flag lives here, so it can be unit-tested. */
export function buildDockerArgs({ lang, hostDir, name, limits = config.sandbox }) {
  return [
    "run",
    "--rm",
    "--name",
    name,
    "--network=none",
    `--memory=${limits.memory}`,
    `--memory-swap=${limits.memory}`,
    `--cpus=${limits.cpus}`,
    `--pids-limit=${limits.pids}`,
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--tmpfs=/tmp:rw,exec,nosuid,size=256m",
    "-e",
    "HOME=/tmp",
    "-e",
    "GOCACHE=/tmp/.gocache",
    "-e",
    "GOPATH=/tmp/go",
    "-v",
    `${hostDir}:/code:ro`,
    lang.image,
    "sh",
    "-c",
    buildScript(lang, limits.executionTimeout),
  ];
}

/** Run a process, capturing capped stdout/stderr, with a hard wall-clock limit. */
export function runProcess(cmd, args, { timeoutMs, onTimeout } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true });
    } catch (err) {
      resolve({ code: -1, stdout: "", stderr: String(err.message), timedOut: false, spawnError: err });
      return;
    }
    const out = { stdout: "", stderr: "", truncated: false };
    const collect = (key) => (chunk) => {
      if (out[key].length < MAX_OUTPUT_BYTES) out[key] += chunk.toString("utf8");
      if (out[key].length > MAX_OUTPUT_BYTES) {
        out[key] = out[key].slice(0, MAX_OUTPUT_BYTES);
        out.truncated = true;
      }
    };
    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          onTimeout?.();
          child.kill("SIGKILL");
        }, timeoutMs)
      : null;

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: -1, stdout: out.stdout, stderr: String(err.message), timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, ...out, timedOut });
    });
  });
}

let dockerChecked = null;

/** Whether a Docker daemon is reachable. Cached for the process lifetime once true. */
export async function dockerAvailable() {
  if (dockerChecked === true) return true;
  const res = await runProcess("docker", ["info", "--format", "{{.ServerVersion}}"], { timeoutMs: 15_000 });
  dockerChecked = res.code === 0;
  return dockerChecked;
}

async function ensureImage(image) {
  const inspect = await runProcess("docker", ["image", "inspect", image], { timeoutMs: 15_000 });
  if (inspect.code === 0) return null;
  const pull = await runProcess("docker", ["pull", image], { timeoutMs: 10 * 60_000 });
  return pull.code === 0 ? null : `Could not pull Docker image ${image}: ${pull.stderr.trim().slice(-300)}`;
}

/** Split the timing marker out of stderr and turn it into seconds. */
export function extractTiming(stderr) {
  const lines = stderr.split("\n");
  let seconds = null;
  const kept = [];
  for (const line of lines) {
    const m = line.startsWith(TIME_MARKER) ? line.slice(TIME_MARKER.length).trim().split(/\s+/) : null;
    if (m) {
      const [s, e] = m.map(Number);
      if (Number.isFinite(s) && Number.isFinite(e) && e >= s) seconds = Number(((e - s) / 1e9).toFixed(3));
    } else {
      kept.push(line);
    }
  }
  return { stderr: kept.join("\n").trim(), seconds };
}

const result = (fields) => {
  const r = {
    stdout: "",
    stderr: "",
    exit_code: 0,
    timed_out: false,
    execution_time: 0,
    compile_error: "",
    ...fields,
  };
  r.success = r.exit_code === 0 && !r.timed_out && !r.compile_error;
  return r;
};

/**
 * Compile (if needed) and run `code` with `stdin` in a fresh sandbox.
 * Never throws: every failure is reported in the result object.
 */
export async function runCode(language, code, stdin = "", { limits = config.sandbox } = {}) {
  const lang = getLanguage(language);
  if (!lang) {
    return result({
      exit_code: 1,
      stderr: `Unsupported language: ${language}. Supported: ${SUPPORTED_LANGUAGES.join(", ")}`,
    });
  }
  if (!(await dockerAvailable())) {
    return result({
      exit_code: 1,
      stderr:
        "Docker is not installed or not running. run_code executes code in an isolated Docker " +
        "container; install Docker Desktop (or Docker Engine) and start it, then retry.",
    });
  }

  const pullError = await ensureImage(lang.image);
  if (pullError) return result({ exit_code: 1, stderr: pullError });

  const hostDir = fs.mkdtempSync(path.join(os.tmpdir(), "codechef-sandbox-"));
  const name = `codechef-mcp-${randomBytes(6).toString("hex")}`;
  try {
    fs.writeFileSync(path.join(hostDir, lang.file), code);
    fs.writeFileSync(path.join(hostDir, "input.txt"), stdin ?? "");
    // Let the unprivileged user inside the container read the files.
    fs.chmodSync(hostDir, 0o755);

    const started = Date.now();
    const res = await runProcess("docker", buildDockerArgs({ lang, hostDir, name, limits }), {
      timeoutMs: (limits.compileTimeout + limits.executionTimeout + 20) * 1000,
      onTimeout: () => runProcess("docker", ["kill", name], { timeoutMs: 15_000 }),
    });
    const wall = Number(((Date.now() - started) / 1000).toFixed(3));
    const { stderr, seconds } = extractTiming(res.stderr);

    if (res.timedOut) {
      return result({ exit_code: -1, timed_out: true, stderr: "Sandbox exceeded its wall-clock limit.", execution_time: wall });
    }
    if (res.code === COMPILE_ERROR_EXIT) {
      return result({ exit_code: COMPILE_ERROR_EXIT, compile_error: stderr || "Compilation failed." });
    }
    // `timeout` exits 124 when the program runs past the execution limit.
    const timedOut = res.code === 124;
    return result({
      stdout: res.stdout.replace(/\s+$/, ""),
      stderr: timedOut ? `Time limit exceeded (${limits.executionTimeout}s).` : stderr,
      exit_code: res.code,
      timed_out: timedOut,
      execution_time: seconds ?? wall,
      ...(res.truncated ? { output_truncated: true } : {}),
    });
  } finally {
    fs.rmSync(hostDir, { recursive: true, force: true });
  }
}
