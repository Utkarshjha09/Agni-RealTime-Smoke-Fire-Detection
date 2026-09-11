#!/usr/bin/env python3
"""Export trained weights into a format the Raspberry Pi can run quickly.

A raw .pt runs through PyTorch on the Pi's CPU and is slow. NCNN is the format
ultralytics recommends for ARM CPUs and is typically several times faster at the
same accuracy, so it is the default here.

    python export.py                                  # newest run, NCNN
    python export.py --format onnx
    python export.py --weights runs/agni-fire-smoke/weights/best.pt

Then copy the exported folder (or file) to the Pi and start the rover with:

    MODEL_PATH=/home/pi/best_ncnn_model DETECTOR=1 ROVER_TOKEN=yourtoken python3 rover_server.py
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent


def newest_best() -> Path | None:
    candidates = list((HERE / "runs").glob("*/weights/best.pt"))
    if not candidates:
        return None
    return max(candidates, key=lambda path: path.stat().st_mtime)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weights", type=Path, default=None, help="path to best.pt (default: newest run)")
    parser.add_argument("--format", default="ncnn", choices=["ncnn", "onnx", "torchscript", "openvino"])
    # Must match DETECT_IMGSZ on the rover: an exported model has its input size
    # baked in, so a mismatch means the Pi silently resizes every frame.
    # 640 rather than the rover's 320 default: measured on these weights, 320 found
    # nothing on a real smoke photo that 640 detected, and under-detecting fire is
    # the expensive failure here. Drop to 416 only if the Pi cannot keep up.
    parser.add_argument("--imgsz", type=int, default=640, help="input size baked into the export (default: 640)")
    parser.add_argument("--half", action="store_true", help="FP16 export; not supported by NCNN on ARM CPU")
    args = parser.parse_args()

    weights = args.weights or newest_best()
    if weights is None or not Path(weights).exists():
        print("No trained weights found. Run train.py first, or pass --weights.", file=sys.stderr)
        return 2

    try:
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 2

    print(f"exporting {weights} to {args.format} at imgsz={args.imgsz}")
    exported = YOLO(str(weights)).export(format=args.format, imgsz=args.imgsz, half=args.half)

    print(f"\nexported: {exported}")
    print("Copy it to the Pi, then start the rover with:")
    print(f"  MODEL_PATH=/home/pi/{Path(exported).name} DETECT_IMGSZ={args.imgsz} DETECTOR=1 ROVER_TOKEN=yourtoken python3 rover_server.py")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
