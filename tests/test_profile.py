"""
Unit tests for CodeChef user profile parsing and analytics tools.
"""

import json
import pytest
from app.browser.profile import (
    extract_json_array,
    parse_user_page,
    is_cloudflare_challenge,
    is_not_found_page,
    looks_like_profile,
    is_valid_handle,
    with_deltas,
)

SAMPLE_HTML = """
<h1 class="h2-style">Test User</h1>
<section class="user-details"><ul>
  <li><label>Username:</label><span><span class='rating'>5&#9733;</span><span class='m-username--link'>testuser</span></span></li>
  <li><label>Country:</label><span><img class="user-country-flag" title="IN"><span class="user-country-name">India</span></span></li>
  <li><label>Organisation:</label><span>IIT Test</span></li>
</ul></section>
<div id="rating-block-all">
  <div class="rating-header"><div class="rating-number">1800</div><div>(Div 3)</div><small>(Highest Rating 1900)</small></div>
  <div class="rating-ranks"><ul>
    <li><a href="/ratings/all"><strong>1234</strong></a>Global Rank</li>
    <li><a href="/ratings/all?x"><strong>56</strong></a>Country Rank</li>
  </ul></div>
</div>
<h3>Total Problems Solved: 120</h3>
<section class="rating-data-section problems-solved">
  <div class='content'><h5><span>Contest A</span></h5><p><span>P1</span>,&nbsp;<span>P2</span></p></div>
</section>
<script>var all_rating = [{"code":"A","name":"Contest A","end_date":"2024-01-15 12:00:00","rating":"1700","rank":"10"}];</script>
<script>userDailySubmissionsStats = [{"date":"2024-1-2","value":3},{"date":"2024-01-03","value":5}];</script>
"""


def test_extract_json_array():
    """Verify extract_json_array handles brackets in strings and nested structures."""
    raw = 'x = [{"a":"]"},{"b":2}];'
    extracted = extract_json_array(raw, "x =")
    assert extracted is not None
    data = json.loads(extracted)
    assert data == [{"a": "]"}, {"b": 2}]


def test_parse_user_page():
    """Verify parse_user_page extracts all required fields with normalized types."""
    p = parse_user_page(SAMPLE_HTML, "testuser")

    assert p["name"] == "Test User"
    assert p["username"] == "testuser"
    assert p["stars"] == 5
    assert p["country"] == "India"
    assert p["countryCode"] == "IN"
    assert p["organisation"] == "IIT Test"

    assert p["rating"]["current"] == 1800
    assert p["rating"]["highest"] == 1900
    assert p["rating"]["division"] == 3
    assert p["rating"]["globalRank"] == 1234
    assert p["rating"]["countryRank"] == 56

    assert p["problemsSolved"] == 120
    assert len(p["contests"]) == 1
    assert p["contests"][0]["contest"] == "Contest A"
    assert p["contests"][0]["problems"] == ["P1", "P2"]

    assert len(p["ratingHistory"]) == 1
    assert p["ratingHistory"][0]["date"] == "2024-01-15"
    assert p["ratingHistory"][0]["rating"] == 1700

    assert len(p["heatmap"]) == 2
    assert p["heatmap"][0]["date"] == "2024-01-02"
    assert p["heatmap"][1]["submissions"] == 5


def test_detection_helpers():
    """Verify Cloudflare and 404 detection helpers."""
    assert is_cloudflare_challenge("<html>Just a moment...</html>") is True
    assert is_cloudflare_challenge("<html>Normal page</html>") is False

    assert is_not_found_page("<p>The user does not exist.</p>") is True
    assert is_not_found_page("<title>CodeChef - Learn and Practice Coding with Problems</title>") is True
    assert is_not_found_page(SAMPLE_HTML) is False

    assert looks_like_profile(SAMPLE_HTML) is True
    assert looks_like_profile("<html>Not a profile</html>") is False


def test_is_valid_handle():
    """Verify handle validation regex."""
    assert is_valid_handle("gennady.korotkevich") is True
    assert is_valid_handle("tourist_99") is True
    assert is_valid_handle("bad handle with spaces") is False
    assert is_valid_handle("") is False


def test_with_deltas():
    """Verify rating delta calculation between consecutive contests."""
    history = [
        {"contest": "Round 1", "date": "2024-01-01", "rating": 1500},
        {"contest": "Round 2", "date": "2024-02-01", "rating": 1620},
        {"contest": "Round 3", "date": "2024-03-01", "rating": 1580},
    ]
    deltas = with_deltas(history)
    assert len(deltas) == 3
    assert deltas[0]["ratingChange"] is None
    assert deltas[1]["ratingChange"] == 120
    assert deltas[2]["ratingChange"] == -40
