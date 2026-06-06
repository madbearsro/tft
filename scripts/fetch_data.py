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


def fetch_cdragon(lang: str) -> dict | None:
    """Fetch full TFT data from CDragon for a given language."""
    url = f"https://raw.communitydragon.org/latest/cdragon/tft/{lang}.json"
    try:
        r = requests.get(url, headers=HEADERS, timeout=60)
        r.raise_for_status()
        return r.json()
    except Exception as exc:
        print(f"  ERROR CDragon {lang}: {exc}")
        errors.append(f"cdragon-{lang}: {exc}")
        return None


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


def fetch_meta(data_en: dict) -> None:
    """Extract current set meta data from CDragon set list."""
    print("Fetching meta...")
    if not data_en:
        errors.append("meta: no CDragon data")
        return
    try:
        sets = data_en.get("sets", {})
        set_data = data_en.get("setData", [])
        meta = {
            "source": "cdragon",
            "sets": sets,
            "setData": [
                {
                    "name": s.get("name"),
                    "number": s.get("number"),
                    "traits": s.get("traits", []),
                    "champions": [
                        {
                            "apiName": c.get("apiName"),
                            "name": c.get("name"),
                            "cost": c.get("cost"),
                            "traits": c.get("traits", []),
                        }
                        for c in s.get("champions", [])
                    ],
                }
                for s in set_data
            ],
        }
        save(f"meta-{SET_NUM}.json", meta)
    except Exception as exc:
        print(f"  ERROR meta: {exc}")
        errors.append(f"meta: {exc}")


def fetch_augments_and_artifacts(data_en: dict) -> None:
    """Extract augments and artifacts from CDragon TFT data."""
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
    """Build a compact name/desc locale map from CDragon TFT data."""
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
                    locale_map[api] = {"name": c.get("name"), "desc": c.get("squareIconPath")}
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
    print(f"=== TFT Set {SET_NUM} data fetch ===\n")

    print("Downloading CDragon en_us...")
    data_en = fetch_cdragon("en_us")

    print("Downloading CDragon ro_ro...")
    data_ro = fetch_cdragon("ro_ro")

    fetch_challenger()
    fetch_meta(data_en)
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
