#!/usr/bin/env python3
"""Download the fire/smoke dataset the Agni detector is trained on.

Source: https://universe.roboflow.com/sayed-gamall/fire-smoke-detection-yolov11
(the dataset behind sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11)

10,463 annotated images, two classes: Fire, Smoke.

Roboflow requires a free account key. Get yours at
https://app.roboflow.com/settings/api and pass it in:

    ROBOFLOW_API_KEY=xxxx python download_dataset.py

The dataset lands in model/data/ and is git-ignored: it is ~1 GB and does not
belong in a repo. Re-running is cheap -- an already-downloaded version is reused.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

import yaml

WORKSPACE = os.getenv("ROBOFLOW_WORKSPACE", "sayed-gamall")
PROJECT = os.getenv("ROBOFLOW_PROJECT", "fire-smoke-detection-yolov11")
VERSION = int(os.getenv("ROBOFLOW_VERSION", "2"))
DATA_DIR = Path(__file__).resolve().parent / "data"


def rewrite_paths(location: Path) -> Path:
    """Point data.yaml at absolute split paths.

    Roboflow ships relative paths that assume the notebook's working directory.
    Ultralytics resolves them against its own datasets root, so training from
    anywhere but that directory silently fails to find any images.
    """
    config_path = location / "data.yaml"
    if not config_path.exists():
        raise SystemExit(f"Downloaded dataset has no data.yaml at {config_path}")

    config = yaml.safe_load(config_path.read_text(encoding="utf-8"))
    for split, folder in (("train", "train"), ("val", "valid"), ("test", "test")):
        split_dir = location / folder / "images"
        if split_dir.is_dir():
            config[split] = str(split_dir)
        else:
            config.pop(split, None)
            print(f"note: no {folder}/images in this version, dropped '{split}' from data.yaml")

    config_path.write_text(yaml.safe_dump(config, default_flow_style=False), encoding="utf-8")
    print(f"data.yaml rewritten with absolute paths: {config_path}")
    print(f"classes: {config.get('names')}")
    return config_path


def main() -> int:
    api_key = os.getenv("ROBOFLOW_API_KEY", "").strip()
    if not api_key:
        print(
            "ROBOFLOW_API_KEY is not set.\n"
            "Create a free account at https://app.roboflow.com, copy the key from\n"
            "https://app.roboflow.com/settings/api, then run:\n"
            "    ROBOFLOW_API_KEY=xxxx python download_dataset.py",
            file=sys.stderr,
        )
        return 2

    try:
        from roboflow import Roboflow
    except ImportError:
        print("roboflow is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 2

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    # Roboflow writes into the process working directory, so make that model/data.
    os.chdir(DATA_DIR)

    project = Roboflow(api_key=api_key).workspace(WORKSPACE).project(PROJECT)
    dataset = project.version(VERSION).download("yolov11")
    location = Path(dataset.location).resolve()
    print(f"dataset downloaded to {location}")

    config_path = rewrite_paths(location)
    for split in ("train", "valid", "test"):
        images = location / split / "images"
        count = len(list(images.glob("*"))) if images.is_dir() else 0
        print(f"  {split:<6} {count} images")

    print(f"\nNext: python train.py --data \"{config_path}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
