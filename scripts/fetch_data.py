"""Fetches TFT data from public APIs and saves JSON files to data/."""
import json
import os
import re
import sys
import time
from collections import defaultdict
from pathlib import Path

import requests

SET_NUM = os.environ.get("TFT_SET", "17")
RIOT_KEY = os.environ.get("RIOT_API_KEY", "")
REGION = os.environ.get("TFT_REGION", "kr")  # platform: euw1, kr, na1, etc.

# Riot routing: platform -> regional cluster
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
SLEEP = 1.5  # secunde intre call-uri Riot API (max 100/2min)

errors = []


def save(filename: str, data) -> None:
    path = DATA_DIR / filename
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  saved {filename} ({path.stat().st_size // 1024} KB)")


def riot_get(url: str) -> dict:
    """GET cu rate limiting pentru Riot API."""
    time.sleep(SLEEP)
    r = requests.get(url, headers=RIOT_HEADERS, timeout=15)
    r.raise_for_status()
    return r.json()


def fetch_cdragon(lang: str) -> dict | None:
    url = f"https://raw.communitydragon.org/latest/cdragon/tft/{lang}.json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        print(f"  ERROR CDragon {lang}: {exc}")
        errors.append(f"cdragon-{lang}: {exc}")
        return None


def build_trait_name_map(data_en: dict | None) -> dict[str, str]:
    """Construieste un map apiName -> displayName din CDragon, ca fallback."""
    if not data_en:
        return {}
    result: dict[str, str] = {}
    for s in data_en.get("setData", []):
        for t in s.get("traits", []):
            api = t.get("apiName", "")
            name = t.get("name", "")
            if api and name:
                result[api] = name
    return result


def normalize_trait_name(raw: str, trait_map: dict[str, str]) -> str:
    """Transforma API name in display name, cu fallback la strip prefix."""
    if raw in trait_map:
        return trait_map[raw]
    # Curata prefix-uri de tipul TFT17_ASTrait -> ASTrait sau Set17_Challenger -> Challenger
    cleaned = re.sub(r"^(?:TFT\d+_|Set\d+_)", "", raw)
    return cleaned


def fetch_challenger_and_meta(trait_map: dict | None = None) -> None:
    """Challenger leaderboard + meta comps din meciuri reale via Riot API."""
    trait_map = trait_map or {}
    if not RIOT_KEY:
        print("  SKIP: RIOT_API_KEY nu e setat")
        save(f"challenger-euw-{SET_NUM}.json", {"entries": [], "error": "no_api_key"})
        errors.append("challenger: RIOT_API_KEY lipsa")
        return

    # --- Leaderboard ---
    print("Fetching Challenger EUW...")
    try:
        league = riot_get(
            f"https://{REGION}.api.riotgames.com/tft/league/v1/challenger?queue=RANKED_TFT"
        )
    except Exception as exc:
        print(f"  ERROR: {exc}")
        errors.append(f"challenger: {exc}")
        return

    entries = sorted(
        league.get("entries", []),
        key=lambda x: x.get("leaguePoints", 0),
        reverse=True,
    )
    print(f"  {len(entries)} jucatori Challenger")

    save(
        f"challenger-{REGION}-{SET_NUM}.json",
        {
            "tier": "CHALLENGER",
            "entries": [
                {
                    "summonerName": e.get("summonerName", ""),
                    "leaguePoints": e.get("leaguePoints"),
                    "wins": e.get("wins"),
                    "losses": e.get("losses"),
                }
                for e in entries[:50]
            ],
        },
    )

    # --- Match IDs (top 30 jucatori, ultimele 10 meciuri fiecare) ---
    print("Fetching match IDs pentru top 30...")
    top30 = entries[:30]
    match_ids: set[str] = set()

    for e in top30:
        puuid = e.get("puuid")

        # Fallback: summoner endpoint daca puuid lipseste din entry
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
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/by-puuid/{puuid}/ids?count=10"
            )
            match_ids.update(ids)
        except Exception as exc:
            print(f"  WARN match IDs: {exc}")

    print(f"  {len(match_ids)} meciuri unice")

    # --- Match details (max 200) ---
    print("Fetching match details...")
    matches = []
    for match_id in list(match_ids)[:200]:
        try:
            match = riot_get(
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/{match_id}"
            )
            matches.append(match)
        except Exception as exc:
            print(f"  WARN {match_id}: {exc}")

    print(f"  Preluat {len(matches)} meciuri")

    # --- Agregate comps ---
    comp_stats: dict = defaultdict(
        lambda: {
            "games": 0,
            "total_placement": 0,
            "top4": 0,
            "wins": 0,
            "sample_units": [],
            "augments": defaultdict(int),
        }
    )

    for match in matches:
        for p in match.get("info", {}).get("participants", []):
            placement = p.get("placement", 9)

            active_traits = sorted(
                [t for t in p.get("traits", []) if t.get("style", 0) > 0],
                key=lambda t: (t.get("style", 0), t.get("num_units", 0)),
                reverse=True,
            )
            if not active_traits:
                continue

            sig = " + ".join(
                normalize_trait_name(t["name"], trait_map) for t in active_traits[:2]
            )
            s = comp_stats[sig]
            s["games"] += 1
            s["total_placement"] += placement
            if placement <= 4:
                s["top4"] += 1
            if placement == 1:
                s["wins"] += 1
            if not s["sample_units"]:
                s["sample_units"] = [
                    u.get("character_id") for u in p.get("units", [])[:8]
                ]
            for aug in p.get("augments", []):
                s["augments"][aug] += 1

    meta_comps = []
    for name, s in comp_stats.items():
        if s["games"] < 3:
            continue
        meta_comps.append(
            {
                "name": name,
                "games": s["games"],
                "placement": round(s["total_placement"] / s["games"], 2),
                "top4": round(s["top4"] / s["games"] * 100, 1),
                "win": round(s["wins"] / s["games"] * 100, 1),
                "units": s["sample_units"],
                "top_augments": [
                    aug
                    for aug, _ in sorted(
                        s["augments"].items(), key=lambda x: x[1], reverse=True
                    )[:3]
                ],
            }
        )

    meta_comps.sort(key=lambda c: (c["placement"], -c["top4"]))
    save(
        f"meta-{SET_NUM}.json",
        {"source": "challenger_matches", "comps": meta_comps[:30]},
    )
    print(f"  Salvat {len(meta_comps[:30])} comps din {len(matches)} meciuri")


def fetch_augments_and_artifacts(data_en: dict) -> None:
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


def fetch_locale(data: dict, lang: str) -> None:
    print(f"Fetching locale '{lang}'...")
    if not data:
        errors.append(f"locale-{lang}: no CDragon data")
        return
    try:
        locale_map: dict[str, dict] = {}
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
        print(f"  locale-{lang}: {len(locale_map)} intrari")
    except Exception as exc:
        print(f"  ERROR locale {lang}: {exc}")
        errors.append(f"locale-{lang}: {exc}")


if __name__ == "__main__":
    print(f"=== TFT Set {SET_NUM} data fetch ===\n")

    print("Downloading CDragon en_us...")
    data_en = fetch_cdragon("en_us")

    print("Downloading CDragon ro_ro...")
    data_ro = fetch_cdragon("ro_ro")

    trait_map = build_trait_name_map(data_en)
    fetch_challenger_and_meta(trait_map)
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
