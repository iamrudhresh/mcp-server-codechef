# codechef-mcp (Unified Edition)

[![npm](https://img.shields.io/npm/v/codechef-mcp)](https://www.npmjs.com/package/codechef-mcp)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)](package.json)
[![python](https://img.shields.io/badge/python-%3E%3D3.10-blue)](requirements.txt)

The unified, complete **Model Context Protocol (MCP)** server for CodeChef. It bridges AI assistants (such as Claude Desktop, Cursor, OpenCode, and Gemini) with CodeChef for both **User Profiling & Analytics** and **Contest Participation & Problem Solving**.

Available in two seamless runtimes:
* **Node.js (ESM)**: Lightweight, zero-config stdio MCP server for profile analytics and contest browsing.
* **Python (FastMCP)**: Full-featured engine supporting all tools, Docker sandbox code execution (C++, Python, Java, Go, Rust), and Playwright browser submission/verdict polling over STDIO or streamable HTTP/SSE.

---

## 🚀 Capabilities & Tools

### 1. User Profiles & Analytics
| Tool | Description |
| --- | --- |
| `get_profile` | Structured user profile (name, stars, current/highest rating, division, global/country rank, problems solved, contest count, recent form). |
| `get_rating_history` | Chronological contest history with rating after each contest, rating deltas (`ratingChange`), and ranks. |
| `get_activity` | Submission heat map summary: total submissions, active days, average submissions per active day, busiest day, and monthly breakdown. |
| `get_contests` | Contests participated in with problems solved in each, merged with rating change and rank. |
| `get_solved_problems` | Unique problems solved by a user mapped to their source contest. |
| `compare_users` | Compact side-by-side comparison for 2–5 handles. |

### 2. Contest Management & Problem Solving
| Tool | Description |
| --- | --- |
| `open_contest` | Open contest and fetch metadata, start/end dates, problem list, and category details. |
| `list_problems` | List all problems in a contest with codes, names, and submission counts. |
| `get_problem` | Fetch clean problem statements (Markdown), constraints, time/memory limits, and sample test cases. |
| `validate_complexity` | Static heuristic time/space complexity analysis (loop nesting depth & annotations). |
| `generate_tests` | Generate adversarial edge cases (minimum/maximum bounds, all identical, sorted, boundary flips, random cases). |
| `get_contest_progress`* | Track attempted, solved, and remaining problems in an active contest. |

### 3. Execution, Submission & Automated Repair (Python Engine)
| Tool | Description |
| --- | --- |
| `run_code`* | Execute code in an isolated Docker sandbox with zero network access, memory limits, CPU caps, and timeouts (supports C++, Python, Java, Go, Rust). |
| `evaluate_confidence`* | Pre-submission confidence evaluation against sample and adversarial tests. |
| `submit_solution`* | Automate CodeChef submission via Playwright browser automation. |
| `get_submission_status`* | Poll submission verdict (AC, WA, TLE, RE) and runtime metrics. |
| `retry_solution`* | Self-repair diagnosis pipeline that analyzes failure causes and suggests code fixes. |
| `get_submission_history`* | Retrieve past submission history from local SQLite database. |

*\* Advanced execution and submission tools run via the Python engine.*

---

## 📂 Project Structure

```text
codechef-mcp/
│
├── app/                  # Python FastMCP Server
│   ├── browser/          # Profile scrapers, Playwright submitters, API clients
│   │   ├── profile.py    # User profile, rating history, heatmap & comparison
│   │   ├── contest.py    # Contest metadata & problem list fetching
│   │   ├── problem.py    # Problem statement & sample test parser
│   │   ├── login.py      # Playwright authentication manager
│   │   ├── submission.py # Code submission automation
│   │   └── verdict.py    # Verdict polling loop
│   ├── models/           # SQLAlchemy SQLite schema (contests, submissions, logs)
│   ├── retry_engine/     # Failure diagnostic & repair pipeline
│   ├── sandbox/          # Docker runner & multi-language configurations
│   ├── solver/           # Sequential contest solver state
│   ├── tools/            # FastMCP tool registrations (18 tools)
│   ├── utils/            # Structured logging & Redis/in-memory cache
│   ├── config.py         # Configuration loader
│   ├── main.py           # Streamable HTTP ASGI app
│   └── mcp_server.py     # FastMCP server instance
│
├── src/                  # Node.js MCP Server
│   ├── api.js            # Node API router
│   ├── contest.js        # Contest metadata, problem statement & complexity analyzer
│   ├── errors.js         # Error definitions
│   ├── http.js           # HTTP fetch client with caching & rate limits
│   ├── parse.js          # Profile HTML & inline script JSON parser
│   ├── server.js         # Stdio server entrypoint
│   └── tools.js          # Stdio tool definitions (11 tools)
│
├── tests/                # Python test suite (33 unit tests)
├── test/                 # Node.js test suite (34 unit tests)
├── docs/                 # PRD and cloud deployment guides (Fly.io, Render)
├── Dockerfile            # Container definition
├── docker-compose.yml    # Docker Compose definition
├── run_server.py         # Python server CLI runner (STDIO & HTTP)
├── requirements.txt      # Python dependencies
└── package.json          # Node.js package definition
```

---

## 🛠️ Usage & Setup

### Running via Node.js

#### 1. Instant run via npx:
```bash
npx codechef-mcp
```

#### 2. Local installation:
```bash
npm install
npm test
npm start
```

### Running via Python

#### 1. Setup virtual environment:
```bash
python -m venv venv
# Windows:
.\venv\Scripts\activate
# Linux/macOS:
source venv/bin/activate

pip install -r requirements.txt
playwright install chromium
```

#### 2. Run Python tests:
```bash
pytest tests/ -v
```

#### 3. Run Python Server:
```bash
# STDIO Transport:
python run_server.py

# Streamable HTTP/SSE Transport:
python run_server.py --http --port 8000
```

---

## 🔌 Connecting to AI Clients

### Claude Desktop
Add to your `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codechef": {
      "command": "node",
      "args": ["E:/PERSONAL/OpenSource/codechef-mcp/src/server.js"]
    }
  }
}
```

Or for the Python full-suite server:
```json
{
  "mcpServers": {
    "codechef": {
      "command": "E:/PERSONAL/OpenSource/codechef-mcp/venv/Scripts/python.exe",
      "args": ["E:/PERSONAL/OpenSource/codechef-mcp/run_server.py"]
    }
  }
}
```

### Cursor / Web Agents (HTTP/SSE)
Run:
```bash
python run_server.py --http --port 8000
```
Connect to `http://localhost:8000/mcp`.

---

## 📄 License
MIT License.
