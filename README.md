# mcp-server-codechef

[![CI](https://github.com/iamrudhresh/mcp-server-codechef/actions/workflows/ci.yml/badge.svg)](https://github.com/iamrudhresh/mcp-server-codechef/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/mcp-server-codechef)](https://www.npmjs.com/package/mcp-server-codechef)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![python](https://img.shields.io/badge/python-%3E%3D3.11-blue)](requirements.txt)

**Docs & showcase:** https://iamrudhresh.github.io/mcp-server-codechef/

A **Model Context Protocol (MCP)** server for CodeChef. It connects AI assistants (Claude Desktop,
Claude Code, Cursor, Cline, Gemini and others) to CodeChef for **profile analytics**, **contests
and problems**, **sandboxed code execution**, and **submission with verdict tracking**.

It ships in two interchangeable runtimes with **the same 18 tools**:

* **Node.js** — `npx -y mcp-server-codechef`, STDIO. No browser or native modules required.
* **Python (FastMCP)** — STDIO or Streamable HTTP, Docker image included.

---

## Tools

### Profiles & analytics (no setup)
| Tool | Description |
| --- | --- |
| `get_profile` | Name, stars, current/highest rating, division, global/country rank, problems solved, contest count, recent form. |
| `get_rating_history` | Contest history (newest first) with rating, rating change and rank. |
| `get_activity` | Submission heat-map summary: totals, active days, busiest day, monthly breakdown. |
| `get_contests` | Contests a user took part in, with problems solved, rank and rating change. |
| `get_solved_problems` | Unique problems solved, mapped to their contest. |
| `compare_users` | Side-by-side comparison of 2–5 handles. |

### Contests & problems (no setup)
| Tool | Description |
| --- | --- |
| `open_contest` | Contest metadata and problem list; starts progress tracking. Parent contests (e.g. Starters) list their division contests. |
| `list_problems` | Problems in a contest with codes, names and submission counts. |
| `get_problem` | Statement, constraints, time/memory limits and sample tests. |
| `get_contest_progress` | Solved / attempted / skipped / remaining problems and the recommended next one. |
| `validate_complexity` | Heuristic time-complexity estimate from loop nesting and annotations. |
| `generate_tests` | Edge-case inputs: min/max bounds, duplicates, sorted, sign flips. |
| `evaluate_confidence` | Pre-submission score out of 100 from sample tests, generated tests, complexity and runtime. |

### Code execution (needs Docker)
| Tool | Description |
| --- | --- |
| `run_code` | Compile and run C, C++, Python, Java, Go or Rust in an isolated container: no network, read-only filesystem, memory/CPU/process limits, time limit. |

### Submission (needs your CodeChef login)
| Tool | Description |
| --- | --- |
| `submit_solution` | Submit code to CodeChef on your account; returns the submission id. |
| `get_submission_status` | Wait for the verdict: Accepted, Wrong Answer, TLE, Runtime Error, Compilation Error, Partially Accepted, with time and memory. |
| `retry_solution` | Diagnose the latest failed submission and suggest concrete fixes. |
| `get_submission_history` | Submissions made through the server for a problem, with verdicts. |

**Argument naming:** Node uses camelCase (`contestCode`, `problemCode`), Python uses snake_case
(`contest_code`, `problem_code`). Outputs are the same.

---

## Quick start

### Node.js (recommended)

```json
{
  "mcpServers": {
    "codechef": {
      "command": "npx",
      "args": ["-y", "mcp-server-codechef"]
    }
  }
}
```

Claude Code: `claude mcp add codechef -- npx -y mcp-server-codechef`

### Enabling submission

Add your CodeChef username and password to the server's `env` block:

```json
{
  "mcpServers": {
    "codechef": {
      "command": "npx",
      "args": ["-y", "mcp-server-codechef"],
      "env": {
        "CODECHEF_USERNAME": "your_handle",
        "CODECHEF_PASSWORD": "your_password"
      }
    }
  }
}
```

* Credentials stay on your machine. They are sent only to `www.codechef.com` to log in.
* The session cookie is cached in `~/.mcp-server-codechef/session.json` (owner-only permissions)
  so the server does not log in on every call, and logs in again automatically when it expires.
* Accounts created with **Google sign-in** have no password; set one at
  <https://www.codechef.com/user/password> first.

### Enabling `run_code`

Install and start [Docker Desktop](https://www.docker.com/products/docker-desktop/) (or Docker
Engine on Linux). Language images (`gcc`, `python`, `eclipse-temurin`, `golang`, `rust`) are pulled
automatically on first use.

### Python

```bash
python -m venv venv
# Windows: .\venv\Scripts\activate     Linux/macOS: source venv/bin/activate
pip install -r requirements.txt

python run_server.py                        # STDIO
python run_server.py --http --port 8000     # Streamable HTTP at http://localhost:8000/mcp
```

Put credentials in `.env` (see `.env.example`) or in the client's `env` block.

---

## How submission works

The server calls the same JSON endpoints the codechef.com web app uses:

| Step | Endpoint |
| --- | --- |
| Log in | `POST /api/login` with the page's CSRF token |
| Languages | `GET /api/ide/all/languages/all` (ids resolved automatically: `cpp` → C++, `python` → PYTH 3, …) |
| Submit | `POST /api/ide/submit` with `sourceCode`, `language`, `problemCode`, `contestCode` |
| Verdict | `GET /api/ide/submit?solution_id=<id>`, polled while judging |

No headless browser is used.

---

## Project structure

```text
mcp-server-codechef/
├── src/                  # Node.js runtime (npm package)
│   ├── server.js         # STDIO entrypoint
│   ├── tools.js          # 18 tool registrations
│   ├── api.js, parse.js, http.js   # Profiles & analytics
│   ├── contest.js        # Contests, problems, complexity, test generation
│   ├── judge.js          # Login, submit, verdict
│   ├── sandbox.js        # Docker code execution
│   ├── solver.js         # Contest progress, failure analysis, confidence score
│   ├── store.js          # Local submission history (JSON file)
│   └── workflow.js       # Tool orchestration
├── app/                  # Python runtime (FastMCP)
│   ├── browser/          # Profile, contest, problem, login, submission, verdict clients
│   ├── sandbox/          # Docker runner & language configs
│   ├── tools/            # 18 tool registrations
│   ├── models/           # SQLite storage
│   └── retry_engine/, solver/, validator/
├── test/                 # Node tests
├── tests/                # Python tests
├── docs/                 # GitHub Pages site
├── run_server.py         # Python CLI (STDIO / --http)
└── Dockerfile, docker-compose.yml
```

---

## Testing

```bash
# Node
npm run test:unit      # offline: parsing, judge client (mocked), sandbox flags, scoring
npm run test:sandbox   # real Docker runs for every language (skips if Docker is missing)
npm run test:mcp       # boots the server and calls tools over MCP
npm run test:live      # live CodeChef profile checks

# Python
pytest
```

CI runs the Node suite on Node 20/22/24, the Docker sandbox suite, and the Python suite on 3.11–3.13.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `CODECHEF_USERNAME` / `CODECHEF_PASSWORD` | — | Needed for submission tools only |
| `CODECHEF_MCP_HOME` | `~/.mcp-server-codechef` | Node: session and history storage |
| `SANDBOX_MEMORY_LIMIT` | `512m` | Container memory limit |
| `SANDBOX_CPU_LIMIT` / `SANDBOX_PID_LIMIT` | `1` / `64` | CPU and process limits |
| `COMPILE_TIMEOUT` / `EXECUTION_TIMEOUT` | `20` / `5` | Seconds |
| `MAX_RETRIES` / `CONFIDENCE_THRESHOLD` | `3` / `75` | Retry tracking and submit threshold |

## License

MIT — see [LICENSE](LICENSE). Unofficial project, not affiliated with CodeChef.
