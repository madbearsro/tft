"""Fetches TFT data from Riot API and CDragon, saves JSON files to data/.

Output format for challenger-{region}-{set}.json mirrors riotApi.js
scanChallengerMatches so the frontend consumes it without transformation.
"""
import json
import os
import re
import sys
import time
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests

SET_NUM = os.environ.get("TFT_SET", "17")
RIOT_KEY = os.environ.get("RIOT_API_KEY", "")
REGION = os.environ.get("TFT_REGION", "kr")
OUTPUT_REGION = os.environ.get("TFT_REGION_ALIAS", REGION)
CHALLENGER_ONLY = os.environ.get("TFT_CHALLENGER_ONLY", "") == "1"

REGIONAL = {
    "euw1": "europe", "eune1": "europe", "tr1": "europe", "ru": "europe",
    "kr": "asia", "jp1": "asia",
    "na1": "americas", "br1": "americas", "la1": "americas", "la2": "americas",
    "oc1": "sea",
}.get(REGION, "asia")

DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TFT-Helper/1.0; +https://github.com)",
    "Accept": "application/json",
}
RIOT_HEADERS = {**HEADERS, "X-Riot-Token": RIOT_KEY}
SLEEP = 1.5

errors = []

# Units that start with these patterns are PvE / summons / not playable
_PVE_RE = re.compile(
    r"(?:Minion|Summon|PVE_|_PVE|Clone|Illusion|Training|Dragon(?:ling)?|Beacon|Dummy)",
    re.IGNORECASE,
)


def is_pve_unit(character_id):
    """Return True if the unit ID looks like a PvE/summon/non-playable unit."""
    # Strip the set prefix then check
    stripped = re.sub(r"^TFT\d+_", "", character_id)
    return bool(_PVE_RE.search(stripped))


def save(filename, data):
    path = DATA_DIR / filename
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  saved {filename} ({path.stat().st_size // 1024} KB)")


def riot_get(url):
    time.sleep(SLEEP)
    r = requests.get(url, headers=RIOT_HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_cdragon(lang):
    url = f"https://raw.communitydragon.org/latest/cdragon/tft/{lang}.json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        print(f"  ERROR CDragon {lang}: {exc}")
        errors.append(f"cdragon-{lang}: {exc}")
        return None


# ── Name helpers (mirror of riotApi.js) ────────────────────────────────────────

def augment_id_to_name(api_name):
    if not api_name:
        return ""
    name = re.sub(r"^TFT\d*_Augment_", "", str(api_name), flags=re.IGNORECASE)
    name = re.sub(r"([a-z])([A-Z])", r"\1 \2", name)
    name = re.sub(r"([A-Z])([A-Z][a-z])", r"\1 \2", name)
    name = re.sub(r"\s*3$", " III", name)
    name = re.sub(r"\s*2$", " II", name)
    name = re.sub(r"\s*1$", " I", name)
    name = name.replace("Plus", "+").replace("Minus", "-")
    return re.sub(r"\s+", " ", name).strip()


def is_thiefs_gloves(item_name):
    return bool(re.search(
        r"thief.?s\s*gloves|thiefsgloves",
        str(item_name or "").replace("_", " "),
        re.IGNORECASE,
    ))


def is_trait_custom_item(item_name):
    return bool(re.search(
        r"emblem|spatula|tactician.?s\s*crown|trait",
        str(item_name or "").replace("_", " "),
        re.IGNORECASE,
    ))


def infer_tier(avg_place):
    if avg_place < 3.2:
        return "S"
    if avg_place < 3.7:
        return "A"
    if avg_place < 4.2:
        return "B"
    return "C"


# ── Patch start time ───────────────────────────────────────────────────────────

_MONTH_NUM = {
    'january': 1, 'february': 2, 'march': 3, 'april': 4,
    'may': 5, 'june': 6, 'july': 7, 'august': 8,
    'september': 9, 'october': 10, 'november': 11, 'december': 12,
}

def fetch_patch_start_time():
    """Return (epoch_seconds, patch_version_str) for the current TFT patch.

    If the article contains a Mid-Patch Updates section with a date heading,
    returns the mid-patch date instead of the main patch release date.
    """
    try:
        html_headers = {
            "User-Agent": "Mozilla/5.0 (compatible; TFT-Helper/1.0)",
            "Accept": "text/html",
        }
        index_url = "https://teamfighttactics.leagueoflegends.com/en-us/news/game-updates/"
        r = requests.get(index_url, headers=html_headers, timeout=15)
        r.raise_for_status()
        m = re.search(r'href="([^"]*teamfight-tactics-patch-[^"]+)"', r.text, re.IGNORECASE)
        if not m:
            return None, None
        path = m.group(1)
        article_url = (
            f"https://teamfighttactics.leagueoflegends.com{path}"
            if path.startswith("/") else path
        )
        r = requests.get(article_url, headers=html_headers, timeout=15)
        r.raise_for_status()

        date_m = re.search(r"(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z)", r.text)
        ver_m = re.search(r"Teamfight Tactics patch (\d+\.\d+)", r.text, re.IGNORECASE)
        if not date_m:
            return None, None

        dt = datetime.fromisoformat(date_m.group(1).replace("Z", "+00:00"))
        patch_ver = ver_m.group(1) if ver_m else None
        patch_epoch = int(dt.timestamp())
        print(f"  Patch release: {date_m.group(1)} (epoch {patch_epoch}), version: {patch_ver}")

        # Detect mid-patch date: look for month+day heading right after "Mid-Patch Updates"
        midpatch_m = re.search(
            r"mid-patch updates[\s\S]{0,400}"
            r"\b(january|february|march|april|may|june|july|august|september|october|november|december)"
            r"\s+(\d{1,2})(?:st|nd|rd|th)?\b",
            r.text, re.IGNORECASE
        )
        if midpatch_m:
            month = _MONTH_NUM[midpatch_m.group(1).lower()]
            day = int(midpatch_m.group(2))
            year = dt.year
            midpatch_dt = datetime(year, month, day, 6, 0, 0, tzinfo=timezone.utc)
            midpatch_epoch = int(midpatch_dt.timestamp())
            print(f"  Mid-patch detected: {midpatch_dt.strftime('%Y-%m-%d')} (epoch {midpatch_epoch})")
            return midpatch_epoch, patch_ver

        return patch_epoch, patch_ver
    except Exception as exc:
        print(f"  WARN fetch_patch_start_time: {exc}")
        return None, None


def last_wednesday_epoch():
    """Fallback: epoch seconds for last Wednesday 06:00 UTC."""
    utc_now = datetime.now(timezone.utc)
    days_since_wed = (utc_now.weekday() - 2) % 7
    last_wed = (utc_now - timedelta(days=days_since_wed)).replace(
        hour=6, minute=0, second=0, microsecond=0
    )
    return int(last_wed.timestamp())


# ── Main match analysis ─────────────────────────────────────────────────────────

def fetch_matches_and_analyze():
    if not RIOT_KEY:
        print("  SKIP: RIOT_API_KEY not set")
        errors.append("challenger: RIOT_API_KEY missing")
        return

    # Patch start time
    patch_start, patch_version = fetch_patch_start_time()
    if patch_start:
        print(f"  Using patch start: {datetime.utcfromtimestamp(patch_start).strftime('%Y-%m-%d %H:%M UTC')}")
    else:
        patch_start = last_wednesday_epoch()
        print(f"  Fallback to last Wednesday: {datetime.utcfromtimestamp(patch_start).strftime('%Y-%m-%d %H:%M UTC')}")

    # Challenger
    print(f"Fetching Challenger {REGION.upper()}...")
    try:
        league = riot_get(
            f"https://{REGION}.api.riotgames.com/tft/league/v1/challenger?queue=RANKED_TFT"
        )
    except Exception as exc:
        print(f"  ERROR: {exc}")
        errors.append(f"challenger: {exc}")
        return

    entries = sorted(league.get("entries", []), key=lambda x: x.get("leaguePoints", 0), reverse=True)
    print(f"  {len(entries)} Challenger players")

    # Grandmaster
    print(f"Fetching Grandmaster {REGION.upper()}...")
    try:
        gm = riot_get(
            f"https://{REGION}.api.riotgames.com/tft/league/v1/grandmaster?queue=RANKED_TFT"
        )
        gm_entries = sorted(gm.get("entries", []), key=lambda x: x.get("leaguePoints", 0), reverse=True)
        print(f"  {len(gm_entries)} Grandmaster players")
    except Exception as exc:
        print(f"  WARN Grandmaster: {exc}")
        gm_entries = []

    all_entries = entries[:30] + gm_entries[:100]

    # Match IDs
    print(f"Fetching match IDs for {len(all_entries)} players...")
    match_ids: set = set()
    for e in all_entries:
        puuid = e.get("puuid")
        if not puuid:
            try:
                summoner = riot_get(
                    f"https://{REGION}.api.riotgames.com/tft/summoner/v1/summoners/{e['summonerId']}"
                )
                puuid = summoner.get("puuid")
            except Exception as exc:
                print(f"  WARN puuid: {exc}")
                continue
        if not puuid:
            continue
        try:
            ids = riot_get(
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/by-puuid/{puuid}/ids"
                f"?count=30&startTime={patch_start}"
            )
            match_ids.update(ids)
        except Exception as exc:
            print(f"  WARN match IDs: {exc}")

    print(f"  {len(match_ids)} unique matches found")

    # Fetch & analyze
    print("Fetching & analyzing match details...")

    unit_stats: dict = {}
    trait_stats: dict = {}
    # comp_stats keyed by "TraitA + TraitB" (top 2 active traits, sorted)
    comp_stats: dict = {}
    augment_stats: dict = {}

    analyzed = 0
    skipped = 0
    debug_printed = False
    raw_comps = []
    unique_match_ids = set()

    for match_id in list(match_ids)[:200]:
        try:
            match = riot_get(
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/{match_id}"
            )
            unique_match_ids.add(match_id)
            info = match.get("info", {})

            queue_id = info.get("queue_id")
            if queue_id and queue_id not in (1100, 1090, 1130):
                skipped += 1
                continue

            tft_set = info.get("tft_set_number")
            if tft_set and str(int(tft_set)) != SET_NUM:
                skipped += 1
                continue

            participants = info.get("participants", [])
            if not participants:
                skipped += 1
                continue

            # Debug: print field names of first participant once
            if not debug_printed and participants:
                p0 = participants[0]
                print(f"  DEBUG participant fields: {list(p0.keys())}")
                aug_sample = (p0.get("augments") or p0.get("augmentIds") or p0.get("augment_ids") or [])
                print(f"  DEBUG augments sample (first participant): {aug_sample[:3]}")
                debug_printed = True

            for p in participants:
                placement = p.get("placement", 9)
                is_top4 = placement <= 4
                units = p.get("units", [])

                # Try multiple field names for augments
                augments = (
                    p.get("augments")
                    or p.get("augmentIds")
                    or p.get("augment_ids")
                    or []
                )

                # Filter out PvE/summon/non-playable units
                playable_units = [
                    u for u in units
                    if (
                        u.get("character_id", "").startswith(f"TFT{SET_NUM}_")
                        and not is_pve_unit(u.get("character_id", ""))
                    )
                ]

                champion_ids = sorted({
                    u.get("character_id", "")
                    for u in playable_units
                    if u.get("character_id", "")
                })
                if len(champion_ids) >= 4:
                    comp_items = {}
                    comp_three_stars = []
                    for unit in playable_units:
                        uid = unit.get("character_id", "")
                        if not uid:
                            continue
                        tier = unit.get("tier") or unit.get("star_level") or unit.get("rarity") or 0
                        if int(tier or 0) >= 3:
                            comp_three_stars.append(uid)
                        item_names = unit.get("item_names") or unit.get("itemNames") or []
                        item_names = [i for i in item_names if i]
                        if item_names:
                            comp_items[uid] = item_names
                    raw_comps.append({
                        "matchId": match_id,
                        "championIds": champion_ids,
                        "placement": placement,
                        "items": comp_items,
                        "threeStars": sorted(set(comp_three_stars)),
                    })

                # ── Trait-based comp key ────────────────────────────────────
                traits_data = p.get("traits", [])
                active_traits = sorted(
                    [t for t in traits_data if t.get("style", 0) > 0],
                    key=lambda t: (-t.get("style", 0), -t.get("num_units", 0)),
                )
                top_trait_names = [t["name"] for t in active_traits[:2]]
                comp_key = " + ".join(sorted(top_trait_names)) if top_trait_names else None

                # ── Global trait stats ──────────────────────────────────────
                for t in active_traits:
                    tname = t.get("name", "")
                    if not tname:
                        continue
                    if tname not in trait_stats:
                        trait_stats[tname] = {"top4": 0, "total": 0, "totalPlacement": 0}
                    trait_stats[tname]["total"] += 1
                    trait_stats[tname]["totalPlacement"] += placement
                    if is_top4:
                        trait_stats[tname]["top4"] += 1

                # ── Comp stats (trait-based) ────────────────────────────────
                if comp_key and len(playable_units) >= 4:
                    if comp_key not in comp_stats:
                        comp_stats[comp_key] = {
                            "top4": 0,
                            "total": 0,
                            "totalPlacement": 0,
                            "unit_counts": {},
                            "items": {},
                            "itemHolderGames": {},
                            "thiefsGlovesGames": {},
                            "augmentStats": {},
                            "threeStars": {},
                        }
                    cs = comp_stats[comp_key]
                    cs["total"] += 1
                    cs["totalPlacement"] += placement
                    if is_top4:
                        cs["top4"] += 1

                    for aug in augments:
                        if aug:
                            if aug not in cs["augmentStats"]:
                                cs["augmentStats"][aug] = {"top4": 0, "total": 0, "totalPlacement": 0}
                            cs["augmentStats"][aug]["total"] += 1
                            cs["augmentStats"][aug]["totalPlacement"] += placement
                            if is_top4:
                                cs["augmentStats"][aug]["top4"] += 1

                    for unit in playable_units:
                        uid = unit.get("character_id", "")
                        if not uid:
                            continue

                        cs["unit_counts"][uid] = cs["unit_counts"].get(uid, 0) + 1

                        tier = unit.get("tier") or unit.get("star_level") or 0
                        if tier >= 3:
                            cs["threeStars"][uid] = cs["threeStars"].get(uid, 0) + 1

                        item_names = unit.get("item_names") or unit.get("itemNames") or []
                        item_names = [i for i in item_names if i]

                        if uid not in cs["items"]:
                            cs["items"][uid] = {}

                        thiefs = next((i for i in item_names if is_thiefs_gloves(i)), None)
                        if thiefs:
                            cs["thiefsGlovesGames"][uid] = cs["thiefsGlovesGames"].get(uid, 0) + 1
                            cs["items"][uid][thiefs] = cs["items"][uid].get(thiefs, 0) + 1
                            continue

                        has_trait_item = any(is_trait_custom_item(i) for i in item_names)
                        if len(item_names) >= 3 or has_trait_item:
                            cs["itemHolderGames"][uid] = cs["itemHolderGames"].get(uid, 0) + 1

                        for item in item_names:
                            cs["items"][uid][item] = cs["items"][uid].get(item, 0) + 1

                # ── Global unit stats ───────────────────────────────────────
                for unit in playable_units:
                    uid = unit.get("character_id", "")
                    if not uid:
                        continue
                    if uid not in unit_stats:
                        unit_stats[uid] = {"top4": 0, "total": 0, "items": {}, "placements": []}
                    unit_stats[uid]["total"] += 1
                    unit_stats[uid]["placements"].append(placement)
                    if is_top4:
                        unit_stats[uid]["top4"] += 1
                        for item in (unit.get("item_names") or unit.get("itemNames") or []):
                            if item:
                                unit_stats[uid]["items"][item] = unit_stats[uid]["items"].get(item, 0) + 1

                # ── Global augment stats ────────────────────────────────────
                for aug in augments:
                    if not aug:
                        continue
                    if aug not in augment_stats:
                        augment_stats[aug] = {"top4": 0, "total": 0, "totalPlacement": 0}
                    augment_stats[aug]["total"] += 1
                    augment_stats[aug]["totalPlacement"] += placement
                    if is_top4:
                        augment_stats[aug]["top4"] += 1

            analyzed += 1
            if analyzed % 10 == 0:
                print(f"  Analyzed {analyzed} matches...")

        except Exception as exc:
            print(f"  WARN {match_id}: {exc}")
            skipped += 1

    print(f"  Analyzed {analyzed} matches, skipped {skipped}")
    print(f"  Comp keys found: {len(comp_stats)}, Augments found: {len(augment_stats)}")

    if analyzed == 0:
        errors.append("No matches could be analyzed")
        return

    # ── Build unitOutput ────────────────────────────────────────────────────────
    unit_output = {}
    for uid, stats in unit_stats.items():
        if stats["total"] < 2:
            continue
        top_items = sorted(stats["items"].items(), key=lambda x: x[1], reverse=True)[:4]
        unit_output[uid] = {
            "top4Rate": round(stats["top4"] / stats["total"], 4),
            "avgPlacement": round(sum(stats["placements"]) / len(stats["placements"]), 3),
            "total": stats["total"],
            "topItems": [{"name": name, "count": count} for name, count in top_items],
        }

    # ── Build augmentOutput ─────────────────────────────────────────────────────
    augment_output = []
    for raw_name, stats in augment_stats.items():
        if stats["total"] < 2:
            continue
        display_name = augment_id_to_name(raw_name)
        if not display_name:
            continue
        augment_output.append({
            "name": display_name,
            "top4Rate": round(stats["top4"] / stats["total"], 4),
            "avgPlacement": round(stats["totalPlacement"] / stats["total"], 3),
            "appearances": stats["total"],
        })
    augment_output.sort(key=lambda x: x["top4Rate"], reverse=True)

    # ── Build challengerComps (trait-based) ─────────────────────────────────────
    def build_challenger_comp(comp_key, cs):
        # Top 8 most frequently seen champions in this trait group
        top_units = sorted(cs["unit_counts"].items(), key=lambda x: x[1], reverse=True)[:8]
        top_unit_ids = {uid for uid, _ in top_units}
        champion_ids = [uid for uid, _ in top_units]

        avg_place = cs["totalPlacement"] / cs["total"]
        top4_rate = cs["top4"] / cs["total"]
        holder_threshold = max(1, round(cs["total"] * 0.25))

        # Items: only for top units and only if they meet holder threshold
        items = {}
        for champ_id, counts in cs["items"].items():
            if champ_id not in top_unit_ids:
                continue
            thiefs_count = cs["thiefsGlovesGames"].get(champ_id, 0)
            holder_count = cs["itemHolderGames"].get(champ_id, 0)

            if thiefs_count >= holder_threshold:
                thiefs_item = next((n for n in counts if is_thiefs_gloves(n)), None)
                if thiefs_item:
                    items[champ_id] = [thiefs_item]
                continue

            if holder_count < holder_threshold:
                continue

            top_items = sorted(
                [(n, c) for n, c in counts.items() if not is_thiefs_gloves(n)],
                key=lambda x: x[1],
                reverse=True,
            )[:3]
            if top_items:
                items[champ_id] = [n for n, _ in top_items]

        # Augments: top augments by Bayesian-smoothed top4 lift
        # Minimum 3 appearances in this comp; sort by smoothed top4Rate
        _PRIOR = 30   # smaller prior for comp-specific stats (sample sizes < global)
        _GLOBAL_TOP4 = 0.50
        augments = []
        for aug_raw, stats in cs["augmentStats"].items():
            if stats["total"] < 3:
                continue
            display = augment_id_to_name(aug_raw)
            if not display:
                continue
            raw_top4 = stats["top4"] / stats["total"]
            smoothed = (stats["total"] * raw_top4 + _PRIOR * _GLOBAL_TOP4) / (stats["total"] + _PRIOR)
            augments.append({
                "apiName": aug_raw,
                "name": display,
                "top4Rate": round(raw_top4, 3),
                "avgPlacement": round(stats["totalPlacement"] / stats["total"], 3),
                "appearances": stats["total"],
                "smoothedTop4": round(smoothed, 3),
                "fromChallenger": True,
            })
        augments.sort(key=lambda a: a["smoothedTop4"], reverse=True)
        augments = augments[:6]

        # Three-stars
        three_stars = [
            cid for cid, count in cs["threeStars"].items()
            if count / cs["total"] >= 0.35 and cid in top_unit_ids
        ]

        # Roles
        roles = {}
        for champ_id, item_list in items.items():
            if item_list and not any(is_thiefs_gloves(i) for i in item_list):
                roles[champ_id] = "Item holder"
        for cid in three_stars:
            roles[cid] = "3-star"

        # Display names: strip TFT17_ prefix
        display_names = [re.sub(r"^TFT\d+_", "", uid) for uid in champion_ids]

        # Comp name from the trait key
        trait_display = " + ".join(
            re.sub(r"^TFT\d*_", "", t) for t in comp_key.split(" + ")
        )

        return {
            "source": "TFT Challenger",
            "sourceKind": "challenger",
            "primarySource": "TFT Challenger",
            "tier": infer_tier(avg_place),
            "championIds": champion_ids,
            "champions": display_names,
            "count": cs["total"],
            "avgPlace": round(avg_place, 2),
            "top4Rate": round(top4_rate, 3),
            "winRate": 0,
            "style": f"{cs['total']} jocuri · {trait_display}",
            "items": items,
            "augments": augments,
            "roles": roles,
            "threeStars": three_stars,
            "positions": {},
            "tips": [],
            "sourceCount": 1,
        }

    # Sort by games desc, then avg placement asc
    sorted_entries = sorted(
        comp_stats.items(),
        key=lambda x: (
            -x[1]["total"],
            x[1]["totalPlacement"] / x[1]["total"] if x[1]["total"] > 0 else 9,
        ),
    )

    # Require at least 5 games for a comp to be meaningful
    comp_entries = [(k, v) for k, v in sorted_entries if v["total"] >= 5]
    print(f"  Comp groups with >= 5 games: {len(comp_entries)}")

    # If fewer than 10 comps pass the threshold, lower to 3
    if len(comp_entries) < 10:
        comp_entries = [(k, v) for k, v in sorted_entries if v["total"] >= 3]
        print(f"  Lowered threshold to 3 games: {len(comp_entries)} comp groups")

    challenger_comps = sorted(
        [build_challenger_comp(k, v) for k, v in comp_entries[:30]],
        key=lambda c: (-c["top4Rate"], c["avgPlace"], -c["count"]),
    )[:20]

    # ── Build traitOutput ───────────────────────────────────────────────────────
    trait_output = []
    for tname, stats in trait_stats.items():
        if stats["total"] < 2:
            continue
        trait_output.append({
            "name": tname,
            "apiName": tname,
            "appearances": stats["total"],
            "top4Rate": round(stats["top4"] / stats["total"], 4),
            "avgPlacement": round(stats["totalPlacement"] / stats["total"], 3),
            "source": "riot",
        })
    trait_output.sort(key=lambda x: x["appearances"], reverse=True)

    # Save challenger-{region}-{set}.json
    save(
        f"challenger-{OUTPUT_REGION}-{SET_NUM}.json",
        {
            "sources": {"riot": True},
            "unitStats": unit_output,
            "traitStats": trait_output,
            "augmentStats": augment_output[:50],
            "challengerComps": challenger_comps,
            "matchIds": sorted(unique_match_ids),
            "rawComps": raw_comps,
            "scannedMatches": analyzed,
            "region": OUTPUT_REGION,
            "patchVersion": patch_version,
            "patchStartTime": patch_start,
            "scrapedAt": int(time.time() * 1000),
        },
    )
    print(f"  {len(challenger_comps)} comps, {len(unit_output)} units, {len(augment_output)} augments")


# ── CDragon: augments, artifacts, locale ───────────────────────────────────────

def fetch_augments_and_artifacts(data_en):
    print("Fetching augments & artifacts...")
    if not data_en:
        errors.append("augments/artifacts: no CDragon data")
        return
    try:
        all_items = data_en.get("items", [])

        augments = [
            {
                "id": it.get("id"),
                "apiName": it.get("apiName"),
                "name": it.get("name"),
                "desc": it.get("desc"),
                "icon": it.get("icon"),
                "tier": it.get("tier"),
            }
            for it in all_items
            if "augment" in (it.get("apiName") or "").lower()
        ]

        artifacts = [
            {
                "id": it.get("id"),
                "apiName": it.get("apiName"),
                "name": it.get("name"),
                "desc": it.get("desc"),
                "icon": it.get("icon"),
            }
            for it in all_items
            if "artifact" in (it.get("apiName") or "").lower()
        ]

        save(f"augments-{SET_NUM}.json", augments)
        save(f"artifacts-{SET_NUM}.json", artifacts)
        print(f"  augments: {len(augments)}, artifacts: {len(artifacts)}")
    except Exception as exc:
        print(f"  ERROR augments/artifacts: {exc}")
        errors.append(f"augments/artifacts: {exc}")


def fetch_locale(data, lang):
    print(f"Fetching locale '{lang}'...")
    if not data:
        errors.append(f"locale-{lang}: no CDragon data")
        return
    try:
        locale_map: dict = {}
        for it in data.get("items", []):
            api = it.get("apiName")
            if api:
                locale_map[api] = {"name": it.get("name"), "desc": it.get("desc")}
        for s in data.get("setData", []):
            for c in s.get("champions", []):
                api = c.get("apiName")
                if api:
                    locale_map[api] = {
                        "name": c.get("name"),
                        "desc": c.get("squareIconPath"),
                    }
            for t in s.get("traits", []):
                api = t.get("apiName")
                if api:
                    locale_map[api] = {"name": t.get("name"), "desc": t.get("desc")}
        save(f"locale-{lang}.json", locale_map)
        print(f"  locale-{lang}: {len(locale_map)} entries")
    except Exception as exc:
        print(f"  ERROR locale {lang}: {exc}")
        errors.append(f"locale-{lang}: {exc}")


if __name__ == "__main__":
    print(f"=== TFT Set {SET_NUM} data fetch ({REGION.upper()}) ===\n")

    fetch_matches_and_analyze()

    if not CHALLENGER_ONLY:
        print("Downloading CDragon en_us...")
        data_en = fetch_cdragon("en_us")

        print("Downloading CDragon ro_ro...")
        data_ro = fetch_cdragon("ro_ro")

        if not data_en:
            print("FATAL: CDragon en_us unavailable")
            sys.exit(1)

        fetch_augments_and_artifacts(data_en)
        fetch_locale(data_ro, "ro")
        fetch_locale(data_en, "en")

    print()
    if errors:
        print(f"Finished with {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("All data fetched successfully.")
