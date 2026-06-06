"""Fetches TFT data from public APIs and saves JSON files to data/."""
import json
import os
import sys
from pathlib import Path

import requests

SET_NUM = os.environ.get("TFT_SET", "17")
DATA_DIR = Path("data")
DATA_DIR.mkdir(exist_ok=True)

HEADERS = {
    "User-Agent": "Mozilla/5.0 (compatible; TFT-Helper/1.0; +https://github.com)",
    "Accept": "application/json",
}

errors = []


def save(filename: str, data) -> None:
    path = DATA_DIR / filename
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"  saved {filename} ({path.stat().st_size // 1024} KB)")


def fetch_challenger() -> None:
    """OP.GG public TFT challenger endpoint (EUW)."""
    print("Fetching challenger...")
    try:
        r = requests.get(
            "https://lol.op.gg/api/v2/tft/rankings",
            params={"region": "euw", "tier": "challenger", "page": 1},
            headers=HEADERS,
            timeout=20,
        )
        r.raise_for_status()
        save(f"challenger-euw-{SET_NUM}.json", r.json())
    except Exception as exc:
        print(f"  WARN challenger: {exc}")
        errors.append(f"challenger: {exc}")


def fetch_meta() -> None:
    """MetaTFT public API — falls back to CDragon set data."""
    print("Fetching meta...")
    try:
        r = requests.get(
            "https://api.metatft.com/tft/comps",
            params={"region": "euw"},
            headers=HEADERS,
            timeout=20,
        )
        r.raise_for_status()
        save(f"meta-{SET_NUM}.json", r.json())
        return
    except Exception as exc:
        print(f"  WARN metatft: {exc}, trying CDragon fallback...")

    try:
        r = requests.get(
            "https://raw.communitydragon.org/latest/cdragon/tft/en_us.json",
            headers=HEADERS,
            timeout=40,
        )
        r.raise_for_status()
        full = r.json()
        # Keep only set-level data to avoid huge file
        meta = {
            "source": "cdragon",
            "setData": [
                {"name": s.get("name"), "number": s.get("number"), "traits": s.get("traits", [])[:10]}
                for s in full.get("setData", [])
            ],
        }
        save(f"meta-{SET_NUM}.json", meta)
    except Exception as exc:
        print(f"  ERROR meta: {exc}")
        errors.append(f"meta: {exc}")


def fetch_augments_and_artifacts() -> None:
    """CDragon TFT JSON — extracts augments and artifact items."""
    print("Fetching augments & artifacts from CDragon...")
    try:
        r = requests.get(
            "https://raw.communitydragon.org/latest/cdragon/tft/en_us.json",
            headers=HEADERS,
            timeout=40,
        )
        r.raise_for_status()
        full = r.json()

        all_items = full.get("items", [])

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


def fetch_locale(lang: str) -> None:
    """CommunityDragon game locale strings."""
    print(f"Fetching locale '{lang}'...")
    lang_code = {
        "ro": "ro_ro",
        "en": "en_us",
        "fr": "fr_fr",
        "de": "de_de",
        "es": "es_es",
        "it": "it_it",
        "pl": "pl_pl",
    }.get(lang, f"{lang}_{lang}")
    url = (
        f"https://raw.communitydragon.org/latest/game/data/menu"
        f"/{lang_code}/main.stringtable.json"
    )
    try:
        r = requests.get(url, headers=HEADERS, timeout=30)
        r.raise_for_status()
        save(f"locale-{lang}.json", r.json())
    except Exception as exc:
        print(f"  ERROR locale {lang}: {exc}")
        errors.append(f"locale-{lang}: {exc}")


if __name__ == "__main__":
    print(f"=== TFT Set {SET_NUM} data fetch ===\n")
    fetch_challenger()
    fetch_meta()
    fetch_augments_and_artifacts()
    fetch_locale("ro")
    fetch_locale("en")

    print()
    if errors:
        print(f"Finished with {len(errors)} error(s):")
        for e in errors:
            print(f"  - {e}")
        sys.exit(1)
    else:
        print("All data fetched successfully.")
