"""
scripts/download_raw_data.py — Milestone 10.1

Automates the fetching of raw IRS migration CSV files directly from the IRS website.
These files are saved to data/original/ and serve as the input for the
enrich_state_data.py and enrich_county_data.py pipelines.

Usage
-----
    python scripts/download_raw_data.py
"""

import sys
import urllib.request
import urllib.error
from pathlib import Path

# The base URL where IRS stores its public CSVs
BASE_URL = "https://www.irs.gov/pub/irs-soi"

# The standard prefix naming conventions used by the IRS
FILE_TYPES = [
    ("state_inflow", "stateinflow"),
    ("state_outflow", "stateoutflow"),
    ("county_inflow", "countyinflow"),
    ("county_outflow", "countyoutflow"),
]

# The years we currently support. When extending data back to 1990 (Milestone 11.1),
# these lists can simply be expanded.
YEARS = [
    "0809", "0910", "1011", "1112", "1213", "1314", "1415", "1516",
    "1617", "1718", "1819", "1920", "2021", "2122", "2223"
]

def download_file(url: str, filepath: Path) -> bool:
    """Download a file from a URL to a local path. Return True if successful."""
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    try:
        with urllib.request.urlopen(req) as response, open(filepath, 'wb') as out_file:
            data = response.read()
            out_file.write(data)
        return True
    except urllib.error.HTTPError as e:
        print(f"    ERROR: HTTP {e.code} for {url}", file=sys.stderr)
        return False
    except Exception as e:
        print(f"    ERROR: Failed to download {url}: {e}", file=sys.stderr)
        return False

def main() -> None:
    print("Starting IRS Migration Data Downloader...\n")
    base_dir = Path("data/original")
    
    total_downloads = 0
    total_skipped = 0

    for folder_name, file_prefix in FILE_TYPES:
        folder_path = base_dir / folder_name
        folder_path.mkdir(parents=True, exist_ok=True)
        print(f"Processing category: {folder_name}/")
        
        for year in YEARS:
            filename = f"{file_prefix}{year}.csv"
            filepath = folder_path / filename
            url = f"{BASE_URL}/{filename}"
            
            if filepath.exists():
                # print(f"  [SKIP] {filename} (already exists)")
                total_skipped += 1
                continue
                
            print(f"  [FETCH] Downloading {filename}...")
            success = download_file(url, filepath)
            if success:
                total_downloads += 1
                print(f"          Saved to {filepath}")
        print()

    print(f"Done. Downloaded {total_downloads} new files. Skipped {total_skipped} existing files.")

if __name__ == "__main__":
    main()
