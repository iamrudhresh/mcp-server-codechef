"""
CodeChef session management (login, CSRF token, cookie persistence).

Talks to the same JSON endpoints the codechef.com web app uses, verified
against the site's JavaScript bundle:

    POST /api/login   {"name", "pass", "csrfToken"}  -> {"status": "success" | "error"}

Requests carry the session cookies plus ``x-csrf-token`` (``window.csrfToken``
from any page) and ``X-Requested-With: XMLHttpRequest``, exactly like the
browser. No headless browser is required: the previous Playwright flow used
form selectors that no longer exist on the React site.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path
from typing import Any, Optional

import httpx

from app.config import config
from app.utils.logger import logger

ORIGIN = "https://www.codechef.com"
USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0 Safari/537.36 mcp-server-codechef"
)
SESSION_MAX_AGE = 7 * 24 * 3600
SESSION_PATH = os.path.join(config.COOKIES_DIR, "codechef_session.json")

_CSRF_RE = re.compile(r"""csrfToken\s*=\s*['"]([A-Za-z0-9_-]{16,})['"]""")


class JudgeError(Exception):
    """A login/submit/verdict failure with a stable machine-readable code."""

    def __init__(self, message: str, code: str = "ERROR"):
        super().__init__(message)
        self.message = message
        self.code = code

    def to_dict(self) -> dict:
        return {"status": "error", "code": self.code, "message": self.message, "error": self.message}


def extract_csrf(html: str) -> str:
    """Return ``window.csrfToken`` from a CodeChef HTML page, or ''."""
    match = _CSRF_RE.search(html or "")
    return match.group(1) if match else ""


def clean_message(value: Any) -> str:
    """Flatten CodeChef error payloads (str/list/dict, may contain HTML)."""
    if isinstance(value, dict):
        value = "; ".join(str(v) for v in value.values())
    elif isinstance(value, list):
        value = "; ".join(str(v) for v in value)
    text = re.sub(r"<[^>]+>", " ", str(value or ""))
    text = re.sub(r"&[a-z]+;", " ", text, flags=re.IGNORECASE)
    return re.sub(r"\s+", " ", text).strip()


class CodeChefSession:
    """A logged-in CodeChef API session. Safe to reuse across tool calls."""

    def __init__(self, transport: Optional[httpx.AsyncBaseTransport] = None):
        self._transport = transport
        self._client: Optional[httpx.AsyncClient] = None
        self.csrf = ""
        self.logged_in = False
        self._restored = False

    # ── HTTP plumbing ─────────────────────────────────────────────

    def _http(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=ORIGIN,
                transport=self._transport,
                follow_redirects=True,
                timeout=25.0,
                headers={
                    "User-Agent": USER_AGENT,
                    "X-Requested-With": "XMLHttpRequest",
                    "Origin": ORIGIN,
                    "Referer": f"{ORIGIN}/",
                },
            )
        return self._client

    async def request(self, method: str, path: str, **kwargs) -> httpx.Response:
        headers = dict(kwargs.pop("headers", {}) or {})
        if self.csrf:
            headers.setdefault("x-csrf-token", self.csrf)
        response = await self._http().request(method, path, headers=headers, **kwargs)
        host = response.url.host or ""
        if host and host != "www.codechef.com":
            raise JudgeError(f"Refusing response redirected to {host}", "UNEXPECTED_REDIRECT")
        return response

    @staticmethod
    def read_json(response: httpx.Response, what: str) -> Any:
        try:
            return response.json()
        except ValueError:
            if response.status_code in (401, 403) or "login" in response.text[:4000].lower():
                raise JudgeError(f"{what}: CodeChef session is not authenticated.", "AUTH_REQUIRED")
            raise JudgeError(
                f"{what}: CodeChef returned a non-JSON response (HTTP {response.status_code}).",
                "UPSTREAM",
            )

    # ── Session lifecycle ─────────────────────────────────────────

    async def refresh_csrf(self) -> None:
        response = await self.request("GET", "/login", headers={"Accept": "text/html"})
        token = extract_csrf(response.text)
        if not token:
            raise JudgeError(
                "Could not obtain a CSRF token from codechef.com (site change or bot check).",
                "UPSTREAM",
            )
        self.csrf = token

    def _persist(self) -> None:
        try:
            Path(config.COOKIES_DIR).mkdir(parents=True, exist_ok=True)
            cookies = {c.name: c.value for c in self._http().cookies.jar}
            tmp = f"{SESSION_PATH}.tmp"
            with open(tmp, "w", encoding="utf-8") as fh:
                json.dump({"saved_at": time.time(), "cookies": cookies}, fh)
            os.chmod(tmp, 0o600)
            os.replace(tmp, SESSION_PATH)
        except OSError as exc:  # persistence is best-effort
            logger.warning(f"Could not save CodeChef session: {exc}")

    def _restore(self) -> None:
        if self._restored:
            return
        self._restored = True
        try:
            with open(SESSION_PATH, encoding="utf-8") as fh:
                saved = json.load(fh)
        except (OSError, ValueError):
            return
        if time.time() - saved.get("saved_at", 0) < SESSION_MAX_AGE and saved.get("cookies"):
            for name, value in saved["cookies"].items():
                self._http().cookies.set(name, value, domain="www.codechef.com")
            self.logged_in = True  # verified lazily: an auth failure triggers a fresh login

    async def login(self) -> None:
        if not config.CODECHEF_USERNAME or not config.CODECHEF_PASSWORD:
            raise JudgeError(
                "CODECHEF_USERNAME and CODECHEF_PASSWORD are not set (.env or the MCP client's env "
                "block). Accounts created with Google sign-in must first set a password at "
                "https://www.codechef.com/user/password.",
                "CREDENTIALS_MISSING",
            )
        self._http().cookies.clear()
        self.logged_in = False
        self.csrf = ""
        await self.refresh_csrf()
        response = await self.request(
            "POST",
            "/api/login",
            json={
                "name": config.CODECHEF_USERNAME,
                "pass": config.CODECHEF_PASSWORD,
                "csrfToken": self.csrf,
            },
            headers={"Accept": "application/json"},
        )
        data = self.read_json(response, "Login")
        if not isinstance(data, dict) or data.get("status") != "success":
            reason = clean_message((data or {}).get("errors")) if isinstance(data, dict) else ""
            raise JudgeError(f"CodeChef login failed: {reason or 'unknown reason'}", "LOGIN_FAILED")
        self.logged_in = True
        await self.refresh_csrf()  # the token is bound to the new session
        self._persist()
        logger.info(f"Logged in to CodeChef as {config.CODECHEF_USERNAME}")

    async def ensure(self) -> None:
        self._restore()
        if not self.logged_in:
            await self.login()
        elif not self.csrf:
            await self.refresh_csrf()

    async def with_auth(self, fn):
        """Run ``fn()``; on an auth failure log in again once and retry."""
        await self.ensure()
        try:
            return await fn()
        except JudgeError as err:
            if err.code != "AUTH_REQUIRED":
                raise
            await self.login()
            return await fn()

    def cookies(self) -> dict[str, str]:
        """Current session cookies (empty when not logged in). Never forces a login."""
        self._restore()
        return {c.name: c.value for c in self._http().cookies.jar} if self.logged_in else {}

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None


_session: Optional[CodeChefSession] = None


def get_session() -> CodeChefSession:
    """The process-wide CodeChef session."""
    global _session
    if _session is None:
        _session = CodeChefSession()
    return _session


def set_session(session: Optional[CodeChefSession]) -> None:
    """Replace the process-wide session (used by tests)."""
    global _session
    _session = session
