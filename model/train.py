#!/usr/bin/env python3
"""Train the Agni fire/smoke detector.

Mirrors the recipe from sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11:
yolo11n, imgsz 640, 250 epochs, patience 20 -- with a batch size that fits the
GPU you actually have rather than the 32 that recipe used on a Kaggle P100.

    python train.py                       # auto batch, auto device
    python train.py --batch 8 --epochs 100
    python train.py --model yolo11s.pt    # bigger, slower, more accurate

Weights land in model/runs/<name>/weights/best.pt. Feed that to export.py before
putting it on the Pi -- a raw .pt runs far slower there than an NCNN export.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_DATA = HERE / "data" / "Fire-Smoke-Detection-YOLOv11-2" / "data.yaml"


def find_data_yaml() -> Path | None:
    """Locate the downloaded dataset without hardcoding Roboflow's folder name."""
    if DEFAULT_DATA.exists():
        return DEFAULT_DATA
    candidates = sorted((HERE / "data").glob("*/data.yaml"))
    return candidates[0] if candidates else None


def pick_device(requested: str) -> str:
    if requested != "auto":
        return requested
    try:
        import torch
    except ImportError:
        print("PyTorch is not installed. See model/README.md for the install command.", file=sys.stderr)
        raise SystemExit(2)
    return "0" if torch.cuda.is_available() else "cpu"


def warn_if_cpu(device: str) -> None:
    if device != "cpu":
        return
    print(
        "\nWARNING: training on CPU.\n"
        "  This dataset is 9,156 training images. On a CPU one epoch takes tens of\n"
        "  minutes, so a full run is days, not hours. Either install a CUDA build of\n"
        "  PyTorch, train on Colab or Kaggle, or use the pretrained weights the\n"
        "  rover already downloads (see raspberry_pi/README.md).\n",
        file=sys.stderr,
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", type=Path, default=None, help="path to data.yaml (default: autodetect in model/data)")
    parser.add_argument("--model", default="yolo11n.pt", help="base weights (default: yolo11n.pt)")
    parser.add_argument("--epochs", type=int, default=250)
    parser.add_argument("--imgsz", type=int, default=640)
    # -1 asks ultralytics to size the batch to ~60%% of available VRAM, which is
    # what makes this work on a 4 GB card where the reference batch of 32 OOMs.
    parser.add_argument("--batch", type=int, default=-1, help="batch size; -1 auto-fits the GPU (default: -1)")
    parser.add_argument("--patience", type=int, default=20, help="stop after N epochs without improvement")
    parser.add_argument("--device", default="auto", help="'auto', '0', 'cpu'")
    parser.add_argument("--workers", type=int, default=4, help="dataloader workers; use 0 if Windows stalls")
    parser.add_argument("--name", default="agni-fire-smoke", help="run name under model/runs")
    parser.add_argument("--resume", action="store_true", help="resume the last interrupted run")
    args = parser.parse_args()

    data = args.data or find_data_yaml()
    if data is None or not Path(data).exists():
        print(
            "No dataset found. Download it first:\n"
            "    ROBOFLOW_API_KEY=xxxx python download_dataset.py",
            file=sys.stderr,
        )
        return 2

    try:
        from ultralytics import YOLO
    except ImportError:
        print("ultralytics is not installed. Run: pip install -r requirements.txt", file=sys.stderr)
        return 2

    device = pick_device(args.device)
    warn_if_cpu(device)
    print(f"data={data}\nmodel={args.model} device={device} imgsz={args.imgsz} batch={args.batch}")

    model = YOLO(args.model)
    results = model.train(
        data=str(data),
        epochs=args.epochs,
        imgsz=args.imgsz,
        batch=args.batch,
        patience=args.patience,
        device=device,
        workers=args.workers,
        project=str(HERE / "runs"),
        name=args.name,
        exist_ok=True,
        resume=args.resume,
        # Mixed precision roughly halves VRAM use, which is what keeps 640px
        # training inside 4 GB.
        amp=True,
        plots=True,
    )

    best = Path(results.save_dir) / "weights" / "best.pt"
    print(f"\nbest weights: {best}")
    print(f"Next: python export.py --weights \"{best}\"")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
