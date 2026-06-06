"""Fetches TFT data from Riot API and CDragon, saves JSON files to data/.

Output format for challenger-{region}-{set}.json mirrors riotApi.js
scanChallengerMatches so the frontend consumes it without transformation.
"""
import json
import os
import re
import sys
import time
from pathlib import Path

import requests

SET_NUM = os.environ.get("TFT_SET", "17")
RIOT_KEY = os.environ.get("RIOT_API_KEY", "")
REGION = os.environ.get("TFT_REGION", "kr")

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


# ── Main match analysis ─────────────────────────────────────────────────────────

def fetch_matches_and_analyze():
    if not RIOT_KEY:
        print("  SKIP: RIOT_API_KEY not set")
        errors.append("challenger: RIOT_API_KEY missing")
        return

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
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/by-puuid/{puuid}/ids?count=20"
            )
            match_ids.update(ids)
        except Exception as exc:
            print(f"  WARN match IDs: {exc}")

    print(f"  {len(match_ids)} unique matches found")

    # Fetch & analyze
    print("Fetching & analyzing match details...")

    unit_stats: dict = {}
    comp_stats: dict = {}
    augment_stats: dict = {}

    analyzed = 0
    skipped = 0

    for match_id in list(match_ids)[:200]:
        try:
            match = riot_get(
                f"https://{REGIONAL}.api.riotgames.com/tft/match/v1/matches/{match_id}"
            )
            info = match.get("info", {})

            queue_id = info.get("queue_id")
            if queue_id and queue_id != 1100:
                skipped += 1
                continue

            tft_set = info.get("tft_set_number")
            if tft_set and str(tft_set) != SET_NUM:
                skipped += 1
                continue

            participants = info.get("participants", [])
            if not participants:
                skipped += 1
                continue

            for p in participants:
                placement = p.get("placement", 9)
                is_top4 = placement <= 4
                units = p.get("units", [])
                augments = p.get("augments", [])

                comp_unit_ids = list({
                    u["character_id"]
                    for u in units
                    if u.get("character_id", "").startswith(f"TFT{SET_NUM}_")
                })
                comp_key = ",".join(sorted(comp_unit_ids))

                # Comp stats
                if len(comp_unit_ids) >= 4 and comp_key:
                    if comp_key not in comp_stats:
                        comp_stats[comp_key] = {
                            "top4": 0, "total": 0, "totalPlacement": 0,
                            "items": {},
                            "itemHolderGames": {},
                            "thiefsGlovesGames": {},
                            "augments": {},
                            "threeStars": {},
                        }
                    cs = comp_stats[comp_key]
                    cs["total"] += 1
                    cs["totalPlacement"] += placement
                    if is_top4:
                        cs["top4"] += 1

                    for aug in augments:
                        if aug:
                            cs["augments"][aug] = cs["augments"].get(aug, 0) + 1

                    for unit in units:
                        uid = unit.get("character_id", "")
                        if uid not in comp_unit_ids:
                            continue

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

                # Unit stats (global)
                for unit in units:
                    uid = unit.get("character_id", "")
                    if not uid.startswith(f"TFT{SET_NUM}_"):
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

                # Augment stats (global)
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

    if analyzed == 0:
        errors.append("No matches could be analyzed")
        return

    # Build unitOutput
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

    # Build augmentOutput
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

    # Build challengerComps
    def build_challenger_comp(comp_key, cs):
        champion_ids = [cid for cid in comp_key.split(",") if cid]
        avg_place = cs["totalPlacement"] / cs["total"]
        top4_rate = cs["top4"] / cs["total"]
        holder_threshold = max(1, round(cs["total"] * 0.25))

        items = {}
        for champ_id, counts in cs["items"].items():
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

        augments = []
        for aug_raw, count in sorted(cs["augments"].items(), key=lambda x: x[1], reverse=True)[:6]:
            display = augment_id_to_name(aug_raw)
            if display:
                augments.append({"name": display, "appearances": count, "fromChallenger": True})

        three_stars = [
            cid for cid, count in cs["threeStars"].items()
            if count / cs["total"] >= 0.35
        ]

        roles = {}
        for champ_id, item_list in items.items():
            if item_list and not any(is_thiefs_gloves(i) for i in item_list):
                roles[champ_id] = "Item holder"
        for cid in three_stars:
            roles[cid] = "3-star"

        display_names = [
            re.sub(r"^TFT\d+_", "", cid) for cid in champion_ids
        ]

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
            "style": f"{cs['total']} jocuri Challenger",
            "items": items,
            "augments": augments,
            "roles": roles,
            "threeStars": three_stars,
            "positions": {},
            "tips": [],
            "sourceCount": 1,
        }

    sorted_entries = sorted(
        comp_stats.items(),
        key=lambda x: (
            -x[1]["total"],
            -len(x[1].get("augments", {})),
            x[1]["totalPlacement"] / x[1]["total"] if x[1]["total"] > 0 else 9,
        ),
    )

    comp_entries = [(k, v) for k, v in sorted_entries if v["total"] >= 2]
    if len(comp_entries) < 10:
        existing = {k for k, _ in comp_entries}
        fill = [
            (k, v)
            for k, v in sorted_entries
            if k not in existing and (len(v.get("augments", {})) > 0 or v["top4"] > 0)
        ][: 20 - len(comp_entries)]
        comp_entries = comp_entries + fill

    challenger_comps = sorted(
        [build_challenger_comp(k, v) for k, v in comp_entries],
        key=lambda c: (-c["top4Rate"], c["avgPlace"], -c["count"]),
    )[:20]

    # Save challenger-{region}-{set}.json (primary source for frontend)
    save(
        f"challenger-{REGION}-{SET_NUM}.json",
        {
            "unitStats": unit_output,
            "augmentStats": augment_output[:50],
            "challengerComps": challenger_comps,
            "scannedMatches": analyzed,
            "source": {
                "ladder": "TFT Challenger + Grandmaster",
                "region": REGION,
                "queue": "RANKED_TFT",
            },
        },
    )
    print(f"  {len(challenger_comps)} comps, {len(unit_output)} units, {len(augment_output)} augments")

    # Save meta-{set}.json in scraped-meta format for useMetaScraper enrichment
    meta_comps = [
        {
            "name": " + ".join(c["champions"][:2]) + " Comp",
            "championIds": c["championIds"],
            "champions": c["champions"],
            "tier": c["tier"],
            "avgPlace": c["avgPlace"],
            "top4Rate": c["top4Rate"],
            "count": c["count"],
            "games": c["count"],
            "items": c["items"],
            "augments": c["augments"],
            "source": "TFT Challenger KR",
            "primarySource": "TFT Challenger KR",
            "sourceKind": "challenger",
            "sources": ["TFT Challenger KR"],
            "sourceCount": 1,
            "roles": c["roles"],
            "threeStars": c["threeStars"],
            "positions": {},
            "tips": [],
        }
        for c in challenger_comps
    ]
    save(
        f"meta-{SET_NUM}.json",
        {
            "source": "challenger_matches_kr",
            "comps": meta_comps,
            "confirmedCount": 0,
            "scrapedAt": int(time.time() * 1000),
        },
    )
    print(f"  Saved {len(meta_comps)} comps to meta-{SET_NUM}.json")


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

    print("Downloading CDragon en_us...")
    data_en = fetch_cdragon("en_us")

    print("Downloading CDragon ro_ro...")
    data_ro = fetch_cdragon("ro_ro")

    if not data_en:
        print("FATAL: CDragon en_us unavailable")
        sys.exit(1)

    fetch_matches_and_analyze()
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
