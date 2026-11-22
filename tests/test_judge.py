"""
Offline tests for the CodeChef judge client (login, submit, verdict), the
sandbox command construction and contest divisions.

The CodeChef API is replaced by an ``httpx.MockTransport`` that mimics the
real endpoints' shapes (verified against the codechef.com web app bundle).
"""

import json
from urllib.parse import parse_qs

import httpx
import pytest

from app.browser import login as login_mod
from app.browser import submission as submission_mod
from app.browser import verdict as verdict_mod
from app.browser.contest import parse_divisions
from app.config import config
from app.sandbox import runner
from app.sandbox.languages import get_language_config

LANGS = [
    {"id": 42, "short_name": "C++"},
    {"id": 116, "short_name": "PYTH 3"},
    {"id": 10, "short_name": "JAVA"},
    {"id": 109, "short_name": "PYPY3"},
]


class FakeCodeChef:
    def __init__(self):
        self.session = None
        self.calls = []
        self.polls = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        cookie = request.headers.get("cookie", "")
        authed = self.session is not None and f"SESS={self.session}" in cookie
        self.calls.append((request.method, request.url.path, authed, request))
        path = request.url.path

        if path == "/login":
            token = "tokenAfterLogin1234567890" if authed else "tokenBeforeLogin123456789"
            return httpx.Response(200, text=f"<script>window.csrfToken = '{token}';</script>")
        if path == "/api/login":
            body = json.loads(request.content)
            if body == {"name": "alice", "pass": "s3cret", "csrfToken": "tokenBeforeLogin123456789"}:
                self.session = f"s{len(self.calls)}"
                return httpx.Response(200, json={"status": "success"},
                                      headers={"set-cookie": f"SESS={self.session}; Path=/"})
            return httpx.Response(200, json={"status": "error", "errors": {"pass": "Wrong <a>Reset</a>"}})
        if path == "/api/ide/all/languages/all":
            return httpx.Response(200, json={"languages": LANGS})
        if path == "/api/ide/submit" and request.method == "POST":
            if not authed or request.headers.get("x-csrf-token") != "tokenAfterLogin1234567890":
                return httpx.Response(403, text="<html>Please login</html>")
            form = parse_qs(request.content.decode())
            if form["problemCode"] == ["BADPROB"]:
                return httpx.Response(200, json={"status": "error", "errors": ["Problem not found"]})
            return httpx.Response(200, json={"status": "OK", "upid": 7654321})
        if path == "/api/ide/submit":
            if not authed:
                return httpx.Response(403, text="<html>login</html>")
            self.polls += 1
            body = {"result_code": "wait"} if self.polls < 2 else {"result_code": "accepted", "time": "0.02", "memory": "4M"}
            return httpx.Response(200, json=body)
        return httpx.Response(404, text="not found")


@pytest.fixture
def fake(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "CODECHEF_USERNAME", "alice")
    monkeypatch.setattr(config, "CODECHEF_PASSWORD", "s3cret")
    monkeypatch.setattr(login_mod, "SESSION_PATH", str(tmp_path / "session.json"))
    monkeypatch.setattr(config, "COOKIES_DIR", str(tmp_path))
    site = FakeCodeChef()
    login_mod.set_session(login_mod.CodeChefSession(transport=httpx.MockTransport(site.handler)))
    submission_mod.reset_language_cache()
    yield site
    login_mod.set_session(None)
    submission_mod.reset_language_cache()


# ── Pure helpers ─────────────────────────────────────────────────


def test_extract_csrf_and_clean_message():
    assert login_mod.extract_csrf("x window.csrfToken = 'abcdef0123456789abcd'; y") == "abcdef0123456789abcd"
    assert login_mod.extract_csrf("<html></html>") == ""
    assert login_mod.clean_message({"pass": "Wrong <a href='x'>Reset</a>"}) == "Wrong Reset"
    assert login_mod.clean_message(["a", "b"]) == "a; b"


@pytest.mark.parametrize(
    "given,expected_id",
    [("cpp", 42), ("C++", 42), ("python3", 116), ("pyth 3", 116), ("109", 109), ("java", 10)],
)
def test_resolve_language(given, expected_id):
    assert submission_mod.resolve_language(given, LANGS)["id"] == expected_id


def test_resolve_language_unknown():
    assert submission_mod.resolve_language("cobol", LANGS) is None


@pytest.mark.parametrize(
    "result_code,code,label",
    [
        ("accepted", "AC", "Accepted"),
        ("wrong", "WA", "Wrong Answer"),
        ("time", "TLE", "Time Limit Exceeded"),
        ("runtime", "RE", "Runtime Error"),
        ("compile", "CE", "Compilation Error"),
        ("partial_accepted", "PAC", "Partially Accepted"),
    ],
)
def test_normalize_verdict(result_code, code, label):
    v = verdict_mod.normalize_verdict("1", {"result_code": result_code})
    assert (v["verdict_code"], v["verdict"], v["pending"]) == (code, label, False)


def test_normalize_verdict_pending_and_compile_info():
    assert verdict_mod.normalize_verdict("1", {"result_code": "wait"})["pending"] is True
    ce = verdict_mod.normalize_verdict("1", {"result_code": "compile", "cmpinfo": "expected ';'"})
    assert ce["compile_error"] == "expected ';'"


# ── Judge flow ───────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_submit_and_poll_verdict(fake):
    result = await submission_mod.submit_code("start99", "flow001", "cpp", "int main(){}")
    assert result["submission_id"] == "7654321"
    assert (result["contest_code"], result["problem_code"], result["language_id"]) == ("START99", "FLOW001", 42)

    method, path, authed, request = next(c for c in fake.calls if c[0] == "POST" and c[1] == "/api/ide/submit")
    form = parse_qs(request.content.decode())
    assert form["sourceCode"] == ["int main(){}"]
    assert form["language"] == ["42"]
    assert request.headers["x-csrf-token"] == "tokenAfterLogin1234567890"

    verdict = await verdict_mod.poll_submission_verdict("7654321", max_wait=10, interval=0.01)
    assert verdict["verdict_code"] == "AC"
    assert verdict["execution_time"] == "0.02"


@pytest.mark.asyncio
async def test_expired_session_relogs_once(fake):
    await submission_mod.submit_code("START99", "FLOW001", "python", "print(1)")
    fake.session = None  # expires server-side
    fake.session_cookie_gone = True
    again = await submission_mod.submit_code("START99", "FLOW001", "python", "print(2)")
    assert again["submission_id"] == "7654321"
    assert sum(1 for c in fake.calls if c[1] == "/api/login") == 2


@pytest.mark.asyncio
async def test_rejections_and_validation(fake):
    rejected = await submission_mod.submit_code("START99", "BADPROB", "cpp", "x")
    assert rejected["code"] == "SUBMIT_REJECTED"
    assert "Problem not found" in rejected["error"]

    bad_lang = await submission_mod.submit_code("START99", "FLOW001", "cobol", "x")
    assert bad_lang["code"] == "INVALID_INPUT"

    bad_code = await submission_mod.submit_code("START 99; x", "FLOW001", "cpp", "x")
    assert bad_code["code"] == "INVALID_INPUT"

    bad_id = await verdict_mod.poll_submission_verdict("12; rm -rf")
    assert bad_id["code"] == "INVALID_INPUT"


@pytest.mark.asyncio
async def test_login_errors(fake, monkeypatch):
    monkeypatch.setattr(config, "CODECHEF_PASSWORD", "wrong")
    wrong = await submission_mod.submit_code("START99", "FLOW001", "cpp", "x")
    assert wrong["code"] == "LOGIN_FAILED"

    monkeypatch.setattr(config, "CODECHEF_PASSWORD", "")
    login_mod.get_session().logged_in = False
    missing = await submission_mod.submit_code("START99", "FLOW001", "cpp", "x")
    assert missing["code"] == "CREDENTIALS_MISSING"


def test_cookies_never_force_login(fake):
    assert login_mod.get_session().cookies() == {}
    assert not any(c[1] == "/api/login" for c in fake.calls)


# ── Sandbox command & divisions ──────────────────────────────────


def test_docker_command_security_flags():
    lang = get_language_config("cpp")
    cmd = runner.build_docker_command(lang, "/tmp/x", "n1", "solution.cpp")
    for flag in ("--network=none", "--read-only", "--cap-drop=ALL", "--security-opt=no-new-privileges"):
        assert flag in cmd
    assert any(a.startswith("--tmpfs=/tmp:rw,exec") for a in cmd), "compiled binaries need an exec /tmp"
    assert "/tmp/x:/code:ro" in cmd
    script = cmd[-1]
    assert script.count("g++") == 1, "compile exactly once"
    assert f"timeout {config.EXECUTION_TIMEOUT} /tmp/solution" in script


def test_extract_timing():
    assert runner.extract_timing("warn\n__MCP_RUN_NS__ 1000000000 1250000000") == ("warn", 0.25)
    assert runner.extract_timing("only stderr") == ("only stderr", None)


def test_language_aliases():
    assert get_language_config("C++").name == "C++17"
    assert get_language_config("golang").name == "Go"
    assert get_language_config("c").name == "C"
    assert get_language_config("cobol") is None


def test_parse_divisions():
    child = {
        "div_1": {"div": {"name": "Division 1", "min_rating": 2000, "max_rating": 50000}, "contest_code": "START100A"},
        "div_4": {"div": {"name": "Division 4", "min_rating": 0, "max_rating": 1399}, "contest_code": "START100D"},
    }
    divisions = parse_divisions(child)
    assert [d["contest_code"] for d in divisions] == ["START100A", "START100D"]
    assert divisions[0]["division"] == "Division 1"
    assert parse_divisions(None) == []
