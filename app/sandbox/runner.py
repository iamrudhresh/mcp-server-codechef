"""
Secure Docker sandbox for code execution.

Each run gets: no network, read-only root filesystem, all capabilities dropped,
no privilege escalation, memory/CPU/PID limits and a writable /tmp. Source code
and stdin are mounted read-only.

Fixes over the previous runner (mirrored in src/sandbox.js):
- /tmp is mounted with ``exec``; Docker's tmpfs default is ``noexec``, which
  made every compiled binary (C++, Go, Rust) fail with "permission denied".
- Code is compiled once (it used to be compiled twice).
- On timeout the container itself is killed (killing only the docker CLI
  left the container running).
- Go gets a writable HOME/GOCACHE, which ``go build`` needs on a read-only root.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import tempfile
import time
import uuid

from app.config import config
from app.sandbox.languages import LanguageConfig, get_language_config, supported_languages
from app.utils.logger import logger

COMPILE_ERROR_EXIT = 97
TIME_MARKER = "__MCP_RUN_NS__"
MAX_OUTPUT_CHARS = 64 * 1024


class SandboxResult:
    """Result of a sandbox code execution."""

    def __init__(
        self,
        stdout: str = "",
        stderr: str = "",
        exit_code: int = 0,
        timed_out: bool = False,
        execution_time: float = 0.0,
        compile_error: str = "",
    ):
        self.stdout = stdout
        self.stderr = stderr
        self.exit_code = exit_code
        self.timed_out = timed_out
        self.execution_time = execution_time
        self.compile_error = compile_error

    @property
    def success(self) -> bool:
        return self.exit_code == 0 and not self.timed_out and not self.compile_error

    def to_dict(self) -> dict:
        return {
            "stdout": self.stdout,
            "stderr": self.stderr,
            "exit_code": self.exit_code,
            "timed_out": self.timed_out,
            "execution_time": self.execution_time,
            "compile_error": self.compile_error,
            "success": self.success,
        }


def build_script(lang: LanguageConfig, filename: str, execution_timeout: int) -> str:
    """Shell script run inside the container: copy, compile once, run with a time limit."""
    steps = [f"cp /code/{filename} /tmp/{filename}"]
    if lang.compile_command:
        steps.append(
            f"{lang.compile_command} > /tmp/compile.log 2>&1 || "
            f"{{ cat /tmp/compile.log >&2; exit {COMPILE_ERROR_EXIT}; }}"
        )
    steps += [
        "s=$(date +%s%N)",
        f"timeout {execution_timeout} {lang.run_command} < /code/input.txt",
        "rc=$?",
        "e=$(date +%s%N)",
        f'echo "{TIME_MARKER} $s $e" >&2',
        "exit $rc",
    ]
    return "\n".join(steps)


def build_docker_command(lang: LanguageConfig, host_dir: str, name: str, filename: str) -> list[str]:
    """Every security flag lives here so it can be unit-tested."""
    memory = config.SANDBOX_MEMORY_LIMIT
    return [
        "docker", "run",
        "--rm",
        "--name", name,
        "--network=none",
        f"--memory={memory}",
        f"--memory-swap={memory}",
        f"--cpus={config.SANDBOX_CPU_LIMIT}",
        f"--pids-limit={config.SANDBOX_PID_LIMIT}",
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges",
        "--tmpfs=/tmp:rw,exec,nosuid,size=256m",
        "-e", "HOME=/tmp",
        "-e", "GOCACHE=/tmp/.gocache",
        "-e", "GOPATH=/tmp/go",
        "-v", f"{host_dir}:/code:ro",
        lang.docker_image,
        "sh", "-c", build_script(lang, filename, config.EXECUTION_TIMEOUT),
    ]


def extract_timing(stderr: str) -> tuple[str, float | None]:
    """Remove the timing marker from stderr and return (stderr, seconds)."""
    seconds = None
    kept = []
    for line in stderr.splitlines():
        if line.startswith(TIME_MARKER):
            parts = line[len(TIME_MARKER):].split()
            try:
                start, end = int(parts[0]), int(parts[1])
                if end >= start:
                    seconds = round((end - start) / 1e9, 3)
            except (IndexError, ValueError):
                pass
        else:
            kept.append(line)
    return "\n".join(kept).strip(), seconds


def _cap(text: str) -> str:
    return text if len(text) <= MAX_OUTPUT_CHARS else text[:MAX_OUTPUT_CHARS]


def _docker_available() -> bool:
    """Check if Docker is installed and running."""
    try:
        result = subprocess.run(["docker", "info"], capture_output=True, text=True, timeout=15)
        return result.returncode == 0
    except (subprocess.TimeoutExpired, FileNotFoundError, OSError):
        return False


def _ensure_image(image: str) -> str | None:
    """Pull the image if missing (outside the run timeout). Returns an error or None."""
    try:
        if subprocess.run(["docker", "image", "inspect", image], capture_output=True, timeout=15).returncode == 0:
            return None
        pull = subprocess.run(["docker", "pull", image], capture_output=True, text=True, timeout=600)
        return None if pull.returncode == 0 else f"Could not pull Docker image {image}: {pull.stderr.strip()[-300:]}"
    except (subprocess.TimeoutExpired, OSError) as exc:
        return f"Could not pull Docker image {image}: {exc}"


def run_code_in_sandbox(language: str, code: str, stdin_input: str = "") -> SandboxResult:
    """Compile (if needed) and run code in a fresh sandbox. Never raises."""
    lang = get_language_config(language)
    if not lang:
        return SandboxResult(
            stderr=f"Unsupported language: {language}. Supported: {', '.join(supported_languages())}",
            exit_code=1,
        )
    if not _docker_available():
        return SandboxResult(
            stderr=(
                "Docker is not installed or not running. run_code executes code in an isolated "
                "Docker container; install Docker Desktop (or Docker Engine), start it, then retry."
            ),
            exit_code=1,
        )
    pull_error = _ensure_image(lang.docker_image)
    if pull_error:
        return SandboxResult(stderr=pull_error, exit_code=1)

    filename = "Main.java" if lang.file_extension == ".java" else f"solution{lang.file_extension}"
    tmp_dir = tempfile.mkdtemp(prefix="codechef_sandbox_")
    name = f"codechef-mcp-{uuid.uuid4().hex[:12]}"
    try:
        with open(os.path.join(tmp_dir, filename), "w", encoding="utf-8") as fh:
            fh.write(code)
        with open(os.path.join(tmp_dir, "input.txt"), "w", encoding="utf-8") as fh:
            fh.write(stdin_input or "")
        os.chmod(tmp_dir, 0o755)

        wall_limit = config.COMPILE_TIMEOUT + config.EXECUTION_TIMEOUT + 20
        started = time.time()
        try:
            proc = subprocess.run(
                build_docker_command(lang, tmp_dir, name, filename),
                capture_output=True,
                text=True,
                timeout=wall_limit,
            )
        except subprocess.TimeoutExpired:
            subprocess.run(["docker", "kill", name], capture_output=True, timeout=15)
            logger.warning(f"Sandbox exceeded wall-clock limit ({wall_limit}s); container killed")
            return SandboxResult(
                stderr="Sandbox exceeded its wall-clock limit.",
                exit_code=-1,
                timed_out=True,
                execution_time=round(time.time() - started, 3),
            )
        wall = round(time.time() - started, 3)
        stderr, seconds = extract_timing(proc.stderr or "")

        if proc.returncode == COMPILE_ERROR_EXIT:
            return SandboxResult(compile_error=_cap(stderr) or "Compilation failed.", exit_code=COMPILE_ERROR_EXIT)

        timed_out = proc.returncode == 124  # `timeout` exit status
        return SandboxResult(
            stdout=_cap((proc.stdout or "").rstrip()),
            stderr=f"Time limit exceeded ({config.EXECUTION_TIMEOUT}s)." if timed_out else _cap(stderr),
            exit_code=proc.returncode,
            timed_out=timed_out,
            execution_time=seconds if seconds is not None else wall,
        )
    except OSError as exc:
        logger.error(f"Sandbox error: {exc}")
        return SandboxResult(stderr=str(exc), exit_code=-1)
    finally:
        shutil.rmtree(tmp_dir, ignore_errors=True)


def run_cpp(code: str, stdin_input: str = "") -> SandboxResult:
    """Run C++ code in a secure sandbox."""
    return run_code_in_sandbox("cpp", code, stdin_input)


def run_python(code: str, stdin_input: str = "") -> SandboxResult:
    """Run Python code in a secure sandbox."""
    return run_code_in_sandbox("python", code, stdin_input)
