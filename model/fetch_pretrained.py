#!/usr/bin/env python3
"""Fetch already-trained fire/smoke weights, so the rover works without training.

Weights come from sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11, trained on
the same Roboflow dataset download_dataset.py fetches. Classes: Fire, Smoke.

    python fetch_pretrained.py              # yolo11 nano, the Pi-friendly one
    python fetch_pretrained.py --variant small
    python fetch_pretrained.py --list

Downloaded weights land in model/weights/ and are git-ignored. Export them for
the Pi with:  python export.py --weights weights/best_nano_111.pt
"""

from __future__ import annotations

import argparse
import sys
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
WEIGHTS_DIR = HERE / "weights"
BASE = "https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11/raw/main/models"

# Nano first: it is the only one worth running on a Pi CPU. The larger variants
# are here for comparing accuracy on a desktop, not for the rover.
VARIANTS = {
    "nano": ("best_nano_111.pt", "yolo11n, ~5 MB -- the rover default"),
    "small": ("kaggle developed models/best_small.pt", "yolo11s, more accurate, too slow for a Pi 4"),
    "medium": ("kaggle developed models/best_medium.pt", "yolo11m, desktop only"),
    "large": ("kaggle developed models/best_large.pt", "yolo11l, desktop only"),
    "dfire": ("kaggle developed models/yolo11-d-fire-dataset.pt", "trained on the D-Fire dataset instead"),
}


def download(url: str, target: Path) -> None:
    print(f"downloading {url}")
    request = urllib.request.Request(url, headers={"User-Agent": "agni-rover"})
    with urllib.request.urlopen(request) as response:
        payload = response.read()
    # A Git LFS pointer is a few hundred bytes of text, not a model. Catch that
    # rather than handing ultralytics a file it will fail on cryptically.
    if len(payload) < 100_000 or payload[:1] not in (b"P", b"\x80", b"\x50"):
        head = payload[:80].decode("utf-8", "replace")
        raise SystemExit(f"That URL did not return model weights ({len(payload)} bytes): {head!r}")
    target.write_bytes(payload)
    print(f"saved {target} ({len(payload) / 1e6:.1f} MB)")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--variant", default="nano", choices=sorted(VARIANTS))
    parser.add_argument("--list", action="store_true", help="show the variants and exit")
    args = parser.parse_args()

    if args.list:
        for name, (path, note) in VARIANTS.items():
            print(f"  {name:<7} {Path(path).name:<28} {note}")
        return 0

    remote, note = VARIANTS[args.variant]
    target = WEIGHTS_DIR / Path(remote).name
    WEIGHTS_DIR.mkdir(parents=True, exist_ok=True)

    if target.exists():
        print(f"already have {target} ({target.stat().st_size / 1e6:.1f} MB)")
    else:
        download(f"{BASE}/{urllib.parse.quote(remote)}", target)
    print(f"variant: {args.variant} -- {note}")

    try:
        from ultralytics import YOLO
    except ImportError:
        print("\nultralytics is not installed, so the weights were not verified.")
        print("Run: pip install -r requirements.txt")
        return 0

    names = YOLO(str(target)).names
    print(f"loaded OK, classes: {list(names.values())}")
    print(f"\nNext: python export.py --weights \"{target}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
