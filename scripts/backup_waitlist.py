#!/usr/bin/env python3
"""Back up the EmailOctopus waitlist to a CSV you own.

Usage:
    python3 scripts/backup_waitlist.py

Reads EMAILOCTOPUS_API_KEY (and optionally EMAILOCTOPUS_LIST_ID) from the
environment or from a .env file in the project root.

Writes two files into backups/:
    waitlist.csv             - running master list. Every email ever seen is kept,
                               even if it is later deleted from EmailOctopus.
    waitlist-YYYY-MM-DD.csv  - exact snapshot of what EmailOctopus has today.
"""

from __future__ import annotations

import csv
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any

API_BASE = "https://api.emailoctopus.com"
ROOT = Path(__file__).resolve().parent.parent
BACKUP_DIR = ROOT / "backups"
MASTER_CSV = BACKUP_DIR / "waitlist.csv"
COLUMNS = ["email", "status", "signed_up_at", "first_backed_up", "last_seen_in_emailoctopus"]


def load_env() -> None:
    env_file = ROOT / ".env"
    if not env_file.exists():
        return
    for line in env_file.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def api_get(path: str, api_key: str, params: dict[str, str] | None = None) -> dict[str, Any]:
    url = API_BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    request = urllib.request.Request(url, headers={"Authorization": f"Bearer {api_key}"})
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            data: dict[str, Any] = json.load(response)
            return data
    except urllib.error.HTTPError as err:
        sys.exit(f"EmailOctopus API error {err.code} for {path}: {err.read().decode(errors='replace')}")


def get_all(path: str, api_key: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    params = {"limit": "100"}
    while True:
        page = api_get(path, api_key, params)
        items.extend(page.get("data", []))
        next_page = (page.get("paging") or {}).get("next")
        if not next_page or not next_page.get("starting_after"):
            return items
        params = {"limit": "100", "starting_after": next_page["starting_after"]}


def pick_list_id(api_key: str) -> str:
    list_id = os.environ.get("EMAILOCTOPUS_LIST_ID")
    if list_id:
        return list_id
    lists = get_all("/lists", api_key)
    if len(lists) == 1:
        return str(lists[0]["id"])
    names = "\n".join(f"  {lst['id']}  {lst.get('name', '')}" for lst in lists)
    sys.exit(f"Found {len(lists)} lists. Set EMAILOCTOPUS_LIST_ID in .env to one of:\n{names}")


def read_master() -> dict[str, dict[str, str]]:
    if not MASTER_CSV.exists():
        return {}
    with MASTER_CSV.open(newline="") as f:
        return {row["email"].lower(): row for row in csv.DictReader(f)}


def write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)


def main() -> None:
    load_env()
    api_key = os.environ.get("EMAILOCTOPUS_API_KEY")
    if not api_key:
        sys.exit("Missing EMAILOCTOPUS_API_KEY. Add it to .env (EmailOctopus > Settings > API keys).")

    list_id = pick_list_id(api_key)
    contacts = get_all(f"/lists/{list_id}/contacts", api_key)
    now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

    snapshot: list[dict[str, str]] = []
    master = read_master()
    new_count = 0
    for contact in contacts:
        email = contact["email_address"]
        key = email.lower()
        existing = master.get(key)
        if existing is None:
            new_count += 1
        row = {
            "email": email,
            "status": contact.get("status", ""),
            "signed_up_at": contact.get("created_at", ""),
            "first_backed_up": existing["first_backed_up"] if existing else now,
            "last_seen_in_emailoctopus": now,
        }
        master[key] = row
        snapshot.append(row)

    BACKUP_DIR.mkdir(exist_ok=True)
    master_rows = sorted(master.values(), key=lambda r: r["signed_up_at"])
    write_csv(MASTER_CSV, master_rows)
    snapshot_path = BACKUP_DIR / f"waitlist-{date.today().isoformat()}.csv"
    write_csv(snapshot_path, sorted(snapshot, key=lambda r: r["signed_up_at"]))

    print(f"{len(contacts)} contacts in EmailOctopus, {new_count} new since last backup.")
    print(f"Master list: {MASTER_CSV.relative_to(ROOT)} ({len(master_rows)} total)")
    print(f"Snapshot:    {snapshot_path.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
