"""
Contest navigation and management via browser automation.

Handles:
- Opening a contest page
- Extracting the list of problems
- Parsing contest metadata (name, start time, duration)
"""

import httpx

from app.config import config
from app.utils.logger import logger


async def fetch_contest_details(contest_code: str) -> dict:
    """Fetch contest details using CodeChef API.

    Args:
        contest_code: The contest code (e.g., "START123")

    Returns:
        Dict with contest metadata and problem list
    """
    url = f"{config.CODECHEF_API_URL}/contests/{contest_code}"

    # Contest data is public; reuse an existing login session if there is one,
    # but never force a login just to read it.
    from app.browser.login import get_session
    cookies = get_session().cookies()

    async with httpx.AsyncClient() as client:
        try:
            response = await client.get(
                url,
                headers={
                    "User-Agent": "CodeChef-MCP/1.0",
                    "Accept": "application/json",
                },
                cookies=cookies,
                timeout=30.0,
            )
            response.raise_for_status()
            data = response.json()

            # Extract problem list
            problems = []
            # CodeChef sends an object keyed by problem code, or [] when empty.
            problem_data = data.get("problems") or {}
            if not isinstance(problem_data, dict):
                problem_data = {}
            for code, info in problem_data.items():
                problems.append({
                    "code": code,
                    "name": info.get("name", ""),
                    "successful_submissions": info.get("successful_submissions", 0),
                    "category_name": info.get("category_name", ""),
                })

            # Sort by problem order (usually alphabetical code)
            problems.sort(key=lambda p: p["code"])

            result = {
                "contest_code": contest_code,
                "contest_name": data.get("name", contest_code),
                "start_date": data.get("start_date", ""),
                "end_date": data.get("end_date", ""),
                "problems": problems,
                "problem_count": len(problems),
            }

            # Starters-style contests are parents: problems live in per-division
            # child contests (START100A, START100B, ...); the parent lists none.
            divisions = parse_divisions(data.get("child_contests"))
            if divisions:
                result["divisions"] = divisions
                if not problems:
                    result["message"] = (
                        "This is a parent contest with no problems of its own. Open one of the "
                        f'division contests instead, e.g. open_contest("{divisions[-1]["contest_code"]}").'
                    )
            return result

        except httpx.HTTPStatusError as e:
            logger.error(f"Contest API error: {e.response.status_code}")
            return {"error": f"Contest '{contest_code}' not found or API error: {e.response.status_code}"}
        except Exception as e:
            logger.error(f"Failed to fetch contest: {e}")
            return {"error": str(e)}


def parse_divisions(child_contests) -> list[dict]:
    """Normalize the ``child_contests`` map of a parent contest."""
    if not isinstance(child_contests, dict):
        return []
    divisions = []
    for child in child_contests.values():
        if not isinstance(child, dict) or not child.get("contest_code"):
            continue
        div = child.get("div") or {}
        divisions.append({
            "division": div.get("name"),
            "contest_code": str(child["contest_code"]),
            "min_rating": div.get("min_rating"),
            "max_rating": div.get("max_rating"),
        })
    return sorted(divisions, key=lambda d: d["contest_code"])


async def fetch_problem_list(contest_code: str) -> list[dict]:
    """Fetch just the list of problems for a contest.

    Args:
        contest_code: The contest code

    Returns:
        List of problem dicts with code, name, and metadata
    """
    details = await fetch_contest_details(contest_code)
    if "error" in details:
        return []
    return details.get("problems", [])
