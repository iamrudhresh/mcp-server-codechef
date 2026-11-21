"""
User profile scraping and analytics for CodeChef.

Extracts structured data from CodeChef profile pages:
- User details (name, stars, country, organization, role)
- Rating stats (current, highest, division, global/country rank)
- Historical contest ratings and rating deltas
- Submission activity heat map
- Solved problems per contest
"""

import asyncio
import datetime
import json
import re
from typing import Any, Optional
import httpx
from bs4 import BeautifulSoup

from app.utils.cache import get_cache, set_cache
from app.utils.logger import logger

BASE_USER_URL = "https://www.codechef.com/users/"
ALLOWED_HOST = "www.codechef.com"
USER_AGENT = "codechef-mcp/0.1 (+https://github.com/sarthaksec/codechef-mcp)"
REQUEST_TIMEOUT_SECONDS = 25.0
MAX_RETRIES = 3
CACHE_TTL_SECONDS = 600  # 10 minutes


class CodeChefProfileError(Exception):
    """Exception raised during CodeChef profile fetching or parsing."""

    def __init__(self, message: str, code: str = "ERROR", status: Optional[int] = None, retryable: bool = False):
        super().__init__(message)
        self.message = message
        self.code = code
        self.status = status
        self.retryable = retryable


def is_valid_handle(handle: str) -> bool:
    """Validate handle format."""
    if not isinstance(handle, str):
        return False
    return bool(re.match(r"^[A-Za-z0-9._-]{1,64}$", handle))


def clean_text(s: Optional[str] = "") -> str:
    """Normalize whitespace and remove non-breaking spaces."""
    if not s:
        return ""
    return re.sub(r"\s+", " ", s.replace("\u00a0", " ")).strip()


def parse_num(v: Any) -> Optional[int]:
    """Parse integer from string or number."""
    if v is None:
        return None
    cleaned = re.sub(r"[^0-9-]", "", str(v))
    try:
        return int(cleaned)
    except (ValueError, TypeError):
        return None


def extract_json_array(source: str, marker: str) -> Optional[str]:
    """Extract a JavaScript array literal following a marker string.

    Uses bracket-matching to support nested objects, strings, and escaped characters.
    """
    at = source.find(marker)
    if at == -1:
        return None
    start = source.find("[", at)
    if start == -1:
        return None

    depth = 0
    in_string = False
    escaped = False

    for i in range(start, len(source)):
        ch = source[i]
        if escaped:
            escaped = False
            continue
        if in_string:
            if ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "[":
            depth += 1
        elif ch == "]":
            depth -= 1
            if depth == 0:
                return source[start : i + 1]

    return None


def safe_parse_array(source: str, marker: str) -> list[Any]:
    """Safely parse a JSON array from source text."""
    raw = extract_json_array(source, marker)
    if not raw:
        return []
    try:
        parsed = json.loads(raw)
        return parsed if isinstance(parsed, list) else []
    except Exception:
        return []


def normalize_date(value: Any) -> Optional[str]:
    """Normalize date string to YYYY-MM-DD."""
    if not value:
        return None
    m = re.match(r"^(\d{4})-(\d{1,2})-(\d{1,2})", str(value).strip())
    if not m:
        return None
    year, month, day = m.groups()
    return f"{year}-{int(month):02d}-{int(day):02d}"


def is_cloudflare_challenge(html: str) -> bool:
    """Check if the HTML content is a Cloudflare anti-bot challenge."""
    if not isinstance(html, str):
        return False
    return (
        "_cf_chl_opt" in html
        or "Just a moment..." in html
        or "Enable JavaScript and cookies to continue" in html
    )


def looks_like_profile(html: str) -> bool:
    """Check if HTML looks like a valid CodeChef profile page."""
    if not isinstance(html, str):
        return False
    return (
        ('class="user-details"' in html or "h2-style" in html)
        and "all_rating" in html
    )


def is_not_found_page(html: str) -> bool:
    """Check if HTML corresponds to a 404 or non-existent user."""
    if not isinstance(html, str):
        return False
    if looks_like_profile(html):
        return False
    if re.search(r"does not exist|user not found|no such user|invalid user", html, re.IGNORECASE):
        return True
    return bool(
        re.search(r"<title>\s*CodeChef\s*-\s*Learn and Practice Coding with Problems\s*</title>", html, re.IGNORECASE)
        or 'property="og:url" content="https://www.codechef.com/"' in html
    )


def parse_user_page(html: str, handle: str) -> dict[str, Any]:
    """Parse raw HTML of a CodeChef user page into structured data."""
    soup = BeautifulSoup(html, "html.parser")

    h1 = soup.select_one("h1.h2-style")
    name = clean_text(h1.get_text()) if h1 else None

    username_el = soup.select_one(".m-username--link")
    username = clean_text(username_el.get_text()) if username_el else handle

    # Sidebar: student/professional, organisation, etc.
    sidebar: dict[str, str] = {}
    for li in soup.select(".user-details li"):
        label_el = li.find("label")
        if not label_el:
            continue
        label = clean_text(label_el.get_text()).rstrip(":").lower()
        if not label:
            continue
        # Clone or strip label and anchor elements
        text_parts = []
        for child in li.children:
            if child == label_el or getattr(child, "name", None) in ("a", "label"):
                continue
            text = child.get_text() if hasattr(child, "get_text") else str(child)
            text_parts.append(text)
        val = clean_text(" ".join(text_parts))
        val = re.sub(r"View Details$", "", val, flags=re.IGNORECASE).strip()
        if val:
            sidebar[label] = val

    stars_el = soup.select_one(".user-details .rating")
    stars_match = re.search(r"(\d+)", clean_text(stars_el.get_text())) if stars_el else None
    stars = int(stars_match.group(1)) if stars_match else None

    star_count_spans = soup.select("#rating-block-all .rating-star span")
    star_count = len(star_count_spans) if star_count_spans else None

    block = soup.select_one("#rating-block-all")
    current_rating = None
    division = None
    highest_rating = None
    ranks: dict[str, Any] = {}

    if block:
        rating_num_el = block.select_one(".rating-number")
        if rating_num_el:
            txt = clean_text(rating_num_el.get_text())
            current_rating = int(txt) if txt.isdigit() else None

        header_el = block.select_one(".rating-header")
        if header_el:
            div_match = re.search(r"\(Div\s*(\d+)\)", clean_text(header_el.get_text()), re.IGNORECASE)
            if div_match:
                division = int(div_match.group(1))

        small_el = block.select_one("small")
        if small_el:
            highest_match = re.search(r"(\d+)", clean_text(small_el.get_text()))
            if highest_match:
                highest_rating = int(highest_match.group(1))

        for li in block.select(".rating-ranks li"):
            strong = li.find("strong")
            strong_text = clean_text(strong.get_text()) if strong else ""
            label_text = clean_text(li.get_text()).replace(strong_text, "").strip().lower()
            key = "global" if "global" in label_text else ("country" if "country" in label_text else (label_text or "unknown"))
            ranks[key] = int(strong_text) if strong_text.isdigit() else (strong_text or None)

    # Problems solved
    problems_solved = None
    for h in soup.find_all("h3"):
        m = re.search(r"Total Problems Solved:\s*([\d,]+)", clean_text(h.get_text()), re.IGNORECASE)
        if m:
            problems_solved = int(m.group(1).replace(",", ""))
            break

    # Solved contests and problems list
    contests: list[dict[str, Any]] = []
    for el in soup.select(".problems-solved .content"):
        h5 = el.select_one("h5")
        p = el.select_one("p")
        contest_title = clean_text(h5.get_text()) if h5 else ""
        raw_probs = clean_text(p.get_text()) if p else ""
        prob_list = [p_str.strip() for p_str in raw_probs.split(",") if p_str.strip()]
        if contest_title:
            contests.append({
                "contest": contest_title,
                "problemsSolved": len(prob_list),
                "problems": prob_list,
            })

    # Rating history
    raw_history = safe_parse_array(html, "var all_rating")
    rating_history: list[dict[str, Any]] = []
    for r in raw_history:
        if not isinstance(r, dict):
            continue
        end_date = r.get("end_date")
        if not end_date and all(k in r for k in ("getyear", "getmonth", "getday")):
            end_date = f"{r.get('getyear')}-{r.get('getmonth')}-{r.get('getday')}"
        norm_date = normalize_date(end_date)
        rat = parse_num(r.get("rating"))
        if norm_date or rat is not None:
            rating_history.append({
                "code": r.get("code"),
                "contest": clean_text(r.get("name")),
                "date": norm_date,
                "rating": rat,
                "rank": parse_num(r.get("rank")),
                "reason": r.get("reason"),
            })

    # Activity heatmap
    raw_heatmap = safe_parse_array(html, "userDailySubmissionsStats")
    heatmap: list[dict[str, Any]] = []
    for d in raw_heatmap:
        if not isinstance(d, dict):
            continue
        norm_date = normalize_date(d.get("date"))
        if norm_date:
            heatmap.append({
                "date": norm_date,
                "submissions": parse_num(d.get("value")) or 0,
            })

    country_name_el = soup.select_one(".user-country-name")
    country = clean_text(country_name_el.get_text()) if country_name_el else None

    flag_img = soup.select_one("img.user-country-flag")
    country_code = flag_img.get("title") if flag_img else None

    return {
        "username": username,
        "name": name,
        "stars": stars if stars is not None else star_count,
        "country": country,
        "countryCode": country_code,
        "role": sidebar.get("student/professional"),
        "organisation": sidebar.get("organisation") or sidebar.get("institution"),
        "rating": {
            "current": current_rating,
            "highest": highest_rating,
            "division": division,
            "globalRank": ranks.get("global"),
            "countryRank": ranks.get("country"),
        },
        "problemsSolved": problems_solved,
        "contests": contests,
        "ratingHistory": rating_history,
        "heatmap": heatmap,
    }


async def fetch_user_page(handle: str, force: bool = False) -> tuple[str, bool, str]:
    """Fetch CodeChef profile HTML with caching, throttling, and retries.

    Returns:
        (html_content, from_cache, url)
    """
    if not is_valid_handle(handle):
        raise CodeChefProfileError(f"Invalid CodeChef handle: '{handle}'", code="INVALID_HANDLE")

    cache_key = f"profile_html:{handle.lower()}"
    if not force:
        cached = get_cache(cache_key)
        if cached and isinstance(cached, dict):
            return cached["html"], True, cached["url"]

    url = f"{BASE_USER_URL}{handle}"
    last_err: Optional[Exception] = None

    async with httpx.AsyncClient(follow_redirects=True) as client:
        for attempt in range(MAX_RETRIES):
            try:
                resp = await client.get(
                    url,
                    headers={
                        "User-Agent": USER_AGENT,
                        "Accept": "text/html,application/xhtml+xml",
                        "Accept-Language": "en-US,en;q=0.9",
                    },
                    timeout=REQUEST_TIMEOUT_SECONDS,
                )

                if resp.status_code == 404:
                    raise CodeChefProfileError(
                        f"CodeChef user '{handle}' not found (HTTP 404).",
                        code="USER_NOT_FOUND",
                        status=404,
                    )

                if resp.status_code in (429, 403) or resp.status_code >= 500:
                    last_err = CodeChefProfileError(
                        f"CodeChef responded with HTTP {resp.status_code}.",
                        code="UPSTREAM",
                        status=resp.status_code,
                        retryable=True,
                    )
                    await asyncio.sleep(0.5 * (2**attempt))
                    continue

                if not resp.is_success:
                    raise CodeChefProfileError(
                        f"Unexpected HTTP {resp.status_code} from CodeChef.",
                        code="UPSTREAM",
                        status=resp.status_code,
                    )

                # Validate redirect host
                final_host = resp.url.host
                if final_host != ALLOWED_HOST:
                    raise CodeChefProfileError(
                        f"Refusing response redirected to unexpected host: {final_host}",
                        code="UNEXPECTED_REDIRECT",
                    )

                html = resp.text

                if is_cloudflare_challenge(html):
                    last_err = CodeChefProfileError(
                        "CodeChef's Cloudflare protection served a challenge. Please wait and retry.",
                        code="BLOCKED",
                        retryable=True,
                    )
                    await asyncio.sleep(1.5 * (2**attempt))
                    continue

                if is_not_found_page(html):
                    raise CodeChefProfileError(
                        f"CodeChef user '{handle}' does not exist.",
                        code="USER_NOT_FOUND",
                        status=404,
                    )

                if not looks_like_profile(html):
                    raise CodeChefProfileError(
                        "CodeChef returned a page without profile data (possible markup change or outage).",
                        code="UNPARSEABLE",
                        retryable=True,
                    )

                # Cache successful HTML
                set_cache(cache_key, {"html": html, "url": str(resp.url)}, expire_seconds=CACHE_TTL_SECONDS)
                return html, False, str(resp.url)

            except CodeChefProfileError as err:
                if not err.retryable:
                    raise err
                last_err = err
                await asyncio.sleep(0.5 * (2**attempt))
            except Exception as e:
                last_err = e
                await asyncio.sleep(0.5 * (2**attempt))

    if isinstance(last_err, CodeChefProfileError) and last_err.code == "BLOCKED":
        raise last_err

    raise CodeChefProfileError(
        f"Could not fetch CodeChef profile for '{handle}' after {MAX_RETRIES} attempts: {last_err}",
        code="FETCH_FAILED",
        retryable=True,
    )


def sorted_history(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Sort history chronologically by date."""
    return sorted(
        [h for h in history if h.get("date")],
        key=lambda x: str(x.get("date", "")),
    )


def with_deltas(history: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Compute rating changes (deltas) between consecutive contests."""
    sorted_h = sorted_history(history)
    result = []
    for i, entry in enumerate(sorted_h):
        r_current = entry.get("rating")
        r_prev = sorted_h[i - 1].get("rating") if i > 0 else None
        delta = None
        if i > 0 and r_current is not None and r_prev is not None:
            delta = r_current - r_prev
        new_entry = dict(entry)
        new_entry["ratingChange"] = delta
        result.append(new_entry)
    return result


async def get_profile(handle: str) -> dict[str, Any]:
    """Fetch structured profile data for a CodeChef user."""
    html, from_cache, url = await fetch_user_page(handle)
    data = parse_user_page(html, handle)
    history = with_deltas(data["ratingHistory"])

    latest = history[-1] if history else None
    best = None
    for h in history:
        r = h.get("rating")
        if r is not None and (best is None or r > best.get("rating", -1)):
            best = h

    return {
        "username": data["username"],
        "name": data["name"],
        "stars": data["stars"],
        "country": data["country"],
        "countryCode": data["countryCode"],
        "role": data["role"],
        "organisation": data["organisation"],
        "rating": data["rating"],
        "problemsSolved": data["problemsSolved"],
        "contestsParticipated": len(history),
        "latestContest": {
            "contest": latest["contest"],
            "date": latest["date"],
            "rating": latest["rating"],
            "ratingChange": latest["ratingChange"],
            "rank": latest["rank"],
        } if latest else None,
        "bestRating": {
            "rating": best["rating"],
            "contest": best["contest"],
            "date": best["date"],
        } if best else None,
        "recentForm": [
            {
                "date": h["date"],
                "rating": h["rating"],
                "ratingChange": h["ratingChange"],
                "rank": h["rank"],
            }
            for h in history[-5:]
        ],
        "profileUrl": url,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }


async def get_rating_history(handle: str, limit: int = 20) -> dict[str, Any]:
    """Return user's contest rating history with rating changes, newest first."""
    html, from_cache, url = await fetch_user_page(handle)
    data = parse_user_page(html, handle)
    history = with_deltas(data["ratingHistory"])
    recent = list(reversed(history[-limit:]))

    return {
        "username": data["username"],
        "totalContests": len(history),
        "currentRating": data["rating"]["current"],
        "highestRating": data["rating"]["highest"],
        "contests": [
            {
                "contest": h["contest"],
                "code": h["code"],
                "date": h["date"],
                "rating": h["rating"],
                "ratingChange": h["ratingChange"],
                "rank": h["rank"],
            }
            for h in recent
        ],
        "profileUrl": url,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }


async def get_activity(handle: str, days: int = 90) -> dict[str, Any]:
    """Summarize submission heat map activity over a time window."""
    html, from_cache, url = await fetch_user_page(handle)
    data = parse_user_page(html, handle)

    cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
    window = [d for d in data["heatmap"] if d.get("date", "") >= cutoff]
    window.sort(key=lambda d: str(d.get("date", "")))

    total_submissions = sum(d["submissions"] for d in window)
    active_days = sum(1 for d in window if d["submissions"] > 0)
    avg_per_day = round(total_submissions / active_days, 1) if active_days > 0 else 0.0

    busiest = None
    for d in window:
        if busiest is None or d["submissions"] > busiest["submissions"]:
            busiest = d

    by_month: dict[str, int] = {}
    for d in window:
        dt = d.get("date")
        if dt:
            month = dt[:7]
            by_month[month] = by_month.get(month, 0) + d["submissions"]

    res: dict[str, Any] = {
        "username": data["username"],
        "windowDays": days,
        "since": cutoff,
        "totalSubmissions": total_submissions,
        "activeDays": active_days,
        "avgSubmissionsPerActiveDay": avg_per_day,
        "busiestDay": busiest,
        "byMonth": by_month,
        "profileUrl": url,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }
    if days <= 60:
        res["daily"] = window

    return res


async def get_contests(handle: str, limit: int = 10) -> dict[str, Any]:
    """List user's contests with solved problems and contest performance."""
    html, from_cache, url = await fetch_user_page(handle)
    data = parse_user_page(html, handle)
    by_name = {h["contest"]: h for h in with_deltas(data["ratingHistory"]) if h.get("contest")}

    rev_contests = list(reversed(data["contests"]))[:limit]
    contest_list = []
    for c in rev_contests:
        rating_info = by_name.get(c["contest"])
        contest_list.append({
            "contest": c["contest"],
            "problemsSolved": c["problemsSolved"],
            "problems": c["problems"],
            "date": rating_info["date"] if rating_info else None,
            "rank": rating_info["rank"] if rating_info else None,
            "ratingAfter": rating_info["rating"] if rating_info else None,
            "ratingChange": rating_info["ratingChange"] if rating_info else None,
        })

    return {
        "username": data["username"],
        "totalContestsWithSolutions": len(data["contests"]),
        "contests": contest_list,
        "profileUrl": url,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }


async def get_solved_problems(handle: str, limit: int = 200) -> dict[str, Any]:
    """Return unique problems solved by a user mapped to their contest."""
    html, from_cache, url = await fetch_user_page(handle)
    data = parse_user_page(html, handle)

    seen: dict[str, str] = {}
    for c in data["contests"]:
        for p in c["problems"]:
            if p not in seen:
                seen[p] = c["contest"]

    all_solved = [{"problem": p, "contest": c} for p, c in seen.items()]

    return {
        "username": data["username"],
        "uniqueProblemsSolved": len(all_solved),
        "reportedTotalSolved": data["problemsSolved"],
        "returned": min(limit, len(all_solved)),
        "problems": all_solved[:limit],
        "profileUrl": url,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }


async def compare_users(handles: list[str]) -> dict[str, Any]:
    """Fetch compact side-by-side comparison for 2-5 CodeChef handles."""
    results = []
    for handle in handles:
        try:
            p = await get_profile(handle)
            best_rat = p["bestRating"]["rating"] if p.get("bestRating") else None
            results.append({
                "username": p["username"],
                "name": p["name"],
                "stars": p["stars"],
                "country": p["country"],
                "rating": p["rating"],
                "problemsSolved": p["problemsSolved"],
                "contestsParticipated": p["contestsParticipated"],
                "bestRating": best_rat,
            })
        except Exception as err:
            results.append({"username": handle, "error": str(err)})

    return {
        "users": results,
        "fetchedAt": datetime.datetime.utcnow().isoformat() + "Z",
    }
