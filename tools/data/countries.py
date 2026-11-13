# /// script
# requires-python = "==3.12.*"
# dependencies = ["pycountry==26.2.16"]
# ///
import hashlib
import io
import json
import tarfile
from pathlib import Path
from typing import TypedDict
from urllib.request import urlopen

import pycountry

ROOT = Path(__file__).resolve().parents[2]
OUTPUT = ROOT / "models/labels"
TZDATA_RELEASE = "2026f"
TZDATA_URL = f"https://data.iana.org/time-zones/releases/tzdata{TZDATA_RELEASE}.tar.gz"
TZDATA_SHA256 = "01b4a91cec5167ed48c11e8ab78f2048cead78ce94b0cafcad0ae8c5a3044d3d"
ZONE_TAB_FIELDS = 3


class Country(TypedDict):
    alpha2: str
    alpha3: str
    name: str


class State(TypedDict):
    code: str
    name: str


class TimeZones(TypedDict):
    release: str
    url: str
    sha256: str
    zones: dict[str, str]


US_STATES: tuple[State, ...] = tuple(
    {"code": code, "name": name}
    for code, name in (
        ("AL", "Alabama"),
        ("AK", "Alaska"),
        ("AZ", "Arizona"),
        ("AR", "Arkansas"),
        ("CA", "California"),
        ("CO", "Colorado"),
        ("CT", "Connecticut"),
        ("DE", "Delaware"),
        ("DC", "District of Columbia"),
        ("FL", "Florida"),
        ("GA", "Georgia"),
        ("HI", "Hawaii"),
        ("ID", "Idaho"),
        ("IL", "Illinois"),
        ("IN", "Indiana"),
        ("IA", "Iowa"),
        ("KS", "Kansas"),
        ("KY", "Kentucky"),
        ("LA", "Louisiana"),
        ("ME", "Maine"),
        ("MD", "Maryland"),
        ("MA", "Massachusetts"),
        ("MI", "Michigan"),
        ("MN", "Minnesota"),
        ("MS", "Mississippi"),
        ("MO", "Missouri"),
        ("MT", "Montana"),
        ("NE", "Nebraska"),
        ("NV", "Nevada"),
        ("NH", "New Hampshire"),
        ("NJ", "New Jersey"),
        ("NM", "New Mexico"),
        ("NY", "New York"),
        ("NC", "North Carolina"),
        ("ND", "North Dakota"),
        ("OH", "Ohio"),
        ("OK", "Oklahoma"),
        ("OR", "Oregon"),
        ("PA", "Pennsylvania"),
        ("RI", "Rhode Island"),
        ("SC", "South Carolina"),
        ("SD", "South Dakota"),
        ("TN", "Tennessee"),
        ("TX", "Texas"),
        ("UT", "Utah"),
        ("VT", "Vermont"),
        ("VA", "Virginia"),
        ("WA", "Washington"),
        ("WV", "West Virginia"),
        ("WI", "Wisconsin"),
        ("WY", "Wyoming"),
    )
)


def countries() -> list[Country]:
    rows: list[Country] = []
    for country in pycountry.countries:
        alpha2 = getattr(country, "alpha_2", "")
        alpha3 = getattr(country, "alpha_3", "")
        if not alpha2 or not alpha3:
            raise ValueError(f"Missing ISO code for {country.name}")
        rows.append({"alpha2": alpha2, "alpha3": alpha3, "name": country.name})
    return sorted(rows, key=lambda row: row["alpha2"])


def parse_zone_tab(text: str, alpha3: dict[str, str]) -> dict[str, str]:
    zones: dict[str, str] = {}
    for row in text.splitlines():
        if not row or row.startswith("#"):
            continue
        fields = row.split("\t")
        if len(fields) < ZONE_TAB_FIELDS:
            raise ValueError(f"Unexpected zone.tab row: {row}")
        alpha2, _, zone = fields[:ZONE_TAB_FIELDS]
        country = alpha3.get(alpha2)
        if country is None:
            raise ValueError(f"No alpha-3 code for zone.tab country {alpha2}")
        zones[zone] = country
    return dict(sorted(zones.items()))


def fetch_zones(alpha3: dict[str, str]) -> TimeZones:
    with urlopen(TZDATA_URL, timeout=60) as response:
        archive_bytes = response.read()
    digest = hashlib.sha256(archive_bytes).hexdigest()
    if digest != TZDATA_SHA256:
        raise ValueError(f"tzdata checksum mismatch: {digest}")
    with tarfile.open(fileobj=io.BytesIO(archive_bytes), mode="r:gz") as archive:
        member = archive.extractfile("zone.tab")
        if member is None:
            raise ValueError("tzdata archive has no zone.tab")
        zones = parse_zone_tab(member.read().decode("ascii"), alpha3)
    return {
        "release": TZDATA_RELEASE,
        "url": TZDATA_URL,
        "sha256": TZDATA_SHA256,
        "zones": zones,
    }


def write_json(path: Path, value: object) -> None:
    path.write_text(json.dumps(value, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def main() -> None:
    country_rows = countries()
    alpha3 = {row["alpha2"]: row["alpha3"] for row in country_rows}
    OUTPUT.mkdir(parents=True, exist_ok=True)
    write_json(OUTPUT / "countries.json", country_rows)
    write_json(OUTPUT / "tz-country.json", fetch_zones(alpha3))
    write_json(OUTPUT / "us-states.json", list(US_STATES))
    print(
        f"Wrote {len(country_rows)} countries, "
        f"{len(US_STATES)} states and the zone table for tzdata {TZDATA_RELEASE}"
    )


if __name__ == "__main__":
    main()
