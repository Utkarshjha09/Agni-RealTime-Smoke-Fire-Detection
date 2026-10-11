#!/usr/bin/env python3
"""On-device fire and smoke detection for the Agni rover.

The detector runs inside `rover_server.py` because Picamera2 cannot be opened by
two processes at once: the server owns the camera and hands frames to this module.

Weights come from the pretrained YOLOv10 fire/smoke model on Hugging Face
(TommyNgx/YOLOv10-Fire-and-Smoke-Detection, Apache-2.0, two classes: fire, smoke).
Nothing needs to be trained. Set MODEL_PATH to use your own .pt file instead --
for example a run fine-tuned on the Roboflow fire-and-smoke dataset.

Enable it with DETECTOR=1 when starting the server.
"""

from __future__ import annotations

import os
import time
import uuid
from dataclasses import dataclass, field
from typing import Any

MODEL_REPO = os.getenv("MODEL_REPO", "TommyNgx/YOLOv10-Fire-and-Smoke-Detection")
MODEL_PATH = os.getenv("MODEL_PATH", "")
# 320 is the Raspberry Pi 4 default: roughly 1-2 inferences per second on its CPU.
# Raise to 416 on a Pi 5, or 640 on a desktop, for a modest accuracy gain.
IMAGE_SIZE = int(os.getenv("DETECT_IMGSZ", "320"))
CONFIDENCE_FLOOR = float(os.getenv("DETECT_CONF", "0.25"))
NMS_IOU = float(os.getenv("DETECT_NMS_IOU", "0.45"))
# A box within this overlap of a previous box is treated as the same ongoing event,
# so one fire updates one alert instead of creating a new one every frame.
TRACK_IOU = float(os.getenv("DETECT_TRACK_IOU", "0.3"))
TRACK_TTL = float(os.getenv("DETECT_TRACK_TTL", "3.0"))
# Threads the model may use. NCNN and PyTorch each default to one per core; on a
# Pi 4 those four, at low priority beside the video encoder, kept waiting on one
# another, and a 0.4 s pass took 6.5 s (measured 2026-10-11). Two leaves the
# camera and the stream a core each.
DETECT_THREADS = max(1, int(os.getenv("DETECT_THREADS", "2")))
CANDIDATE_WEIGHT_FILES = ("best.pt", "yolov10_fire_smoke.pt", "model.pt", "pytorch_model.bin")


def box_iou(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax1, ay1, ax2, ay2 = a
    bx1, by1, bx2, by2 = b
    left, top = max(ax1, bx1), max(ay1, by1)
    right, bottom = min(ax2, bx2), min(ay2, by2)
    if right <= left or bottom <= top:
        return 0.0
    overlap = (right - left) * (bottom - top)
    union = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - overlap
    return overlap / union if union > 0 else 0.0


def classify(label: str) -> str | None:
    """Map a model class name onto the only two kinds the app displays."""
    name = label.strip().lower()
    if "fire" in name or "flame" in name:
        return "fire"
    if "smoke" in name:
        return "smoke"
    return None


@dataclass
class Track:
    id: str
    kind: str
    box: tuple[float, float, float, float]
    last_seen: float = field(default_factory=time.monotonic)


class DetectorUnavailable(RuntimeError):
    """Raised when ultralytics or the weights could not be loaded."""


class FireDetector:
    def __init__(self) -> None:
        self.model: Any = None
        self.names: dict[int, str] = {}
        self.last_inference_ms: float = 0.0
        self.weights_path: str = ""
        self._tracks: list[Track] = []

    # -- setup -------------------------------------------------------------

    def resolve_weights(self) -> str:
        if MODEL_PATH:
            if not os.path.exists(MODEL_PATH):
                raise DetectorUnavailable(f"MODEL_PATH does not exist: {MODEL_PATH}")
            return MODEL_PATH

        try:
            from huggingface_hub import hf_hub_download
        except ImportError as error:  # pragma: no cover - depends on the install
            raise DetectorUnavailable(
                "huggingface_hub is not installed. Run: pip install -r requirements.txt, "
                "or set MODEL_PATH to a local .pt file."
            ) from error

        last_error: Exception | None = None
        for filename in CANDIDATE_WEIGHT_FILES:
            try:
                # Cached after the first run, so the rover works offline afterwards.
                return hf_hub_download(repo_id=MODEL_REPO, filename=filename)
            except Exception as error:  # noqa: BLE001 - try the next candidate name
                last_error = error
        raise DetectorUnavailable(
            f"Could not download weights from {MODEL_REPO}. Set MODEL_PATH to a local .pt file. "
            f"Last error: {last_error}"
        )

    def load(self) -> None:
        """Load the model. Slow (seconds), so call it off the event loop."""
        if self.model is not None:
            return
        try:
            from ultralytics import YOLO
        except ImportError as error:  # pragma: no cover - depends on the install
            raise DetectorUnavailable(
                "ultralytics is not installed. Run: pip install -r requirements.txt"
            ) from error

        self.weights_path = self.resolve_weights()
        self.model = YOLO(self.weights_path)
        raw_names = getattr(self.model, "names", {}) or {}
        self.names = {int(key): str(value) for key, value in raw_names.items()} if isinstance(raw_names, dict) else dict(enumerate(map(str, raw_names)))
        print(f"Fire detector ready: {self.weights_path} classes={list(self.names.values())}")

    # -- inference ---------------------------------------------------------

    def _track_id(self, kind: str, box: tuple[float, float, float, float], now: float) -> str:
        best_track, best_score = None, TRACK_IOU
        for track in self._tracks:
            if track.kind != kind:
                continue
            score = box_iou(track.box, box)
            if score >= best_score:
                best_track, best_score = track, score
        if best_track is not None:
            best_track.box = box
            best_track.last_seen = now
            return best_track.id
        track = Track(id=str(uuid.uuid4()), kind=kind, box=box, last_seen=now)
        self._tracks.append(track)
        return track.id

    def _limit_ncnn_threads(self) -> None:
        """Cap NCNN's threads. ultralytics never sets them, so NCNN takes every core.

        The network only exists once the first predict() has built the predictor;
        NCNN reads the option on each pass, so setting it then takes effect.
        """
        predictor = getattr(self.model, "predictor", None)
        net = getattr(getattr(getattr(predictor, "model", None), "backend", None), "net", None)
        if net is not None and net.opt.num_threads != DETECT_THREADS:
            net.opt.num_threads = DETECT_THREADS

    def _expire_tracks(self, now: float) -> None:
        self._tracks = [track for track in self._tracks if now - track.last_seen <= TRACK_TTL]

    def detect(self, frame: Any) -> list[dict[str, Any]]:
        """Run one inference pass. `frame` is a BGR/RGB numpy array.

        Returns app-ready detections whose boundingBox is in percent of the frame,
        which is exactly what the Expo overlay draws.
        """
        if self.model is None:
            self.load()

        started = time.perf_counter()
        results = self.model.predict(
            source=frame,
            imgsz=IMAGE_SIZE,
            conf=CONFIDENCE_FLOOR,
            iou=NMS_IOU,
            verbose=False,
        )
        self.last_inference_ms = round((time.perf_counter() - started) * 1000, 1)
        self._limit_ncnn_threads()

        now = time.monotonic()
        self._expire_tracks(now)
        height, width = frame.shape[0], frame.shape[1]
        detections: list[dict[str, Any]] = []

        for result in results:
            boxes = getattr(result, "boxes", None)
            if boxes is None:
                continue
            for box in boxes:
                class_index = int(box.cls[0])
                kind = classify(self.names.get(class_index, str(class_index)))
                if kind is None:
                    continue
                x1, y1, x2, y2 = (float(value) for value in box.xyxy[0])
                x1, y1 = max(0.0, x1), max(0.0, y1)
                x2, y2 = min(float(width), x2), min(float(height), y2)
                if x2 <= x1 or y2 <= y1:
                    continue
                detections.append({
                    "id": self._track_id(kind, (x1, y1, x2, y2), now),
                    "kind": kind,
                    "confidence": round(float(box.conf[0]) * 100, 1),
                    "boundingBox": {
                        "left": round(x1 / width * 100, 2),
                        "top": round(y1 / height * 100, 2),
                        "width": round((x2 - x1) / width * 100, 2),
                        "height": round((y2 - y1) / height * 100, 2),
                    },
                    "location": "Rover camera",
                    "confirmedBySensor": False,
                })
        return detections


# -- the detector process ----------------------------------------------------
#
# rover_server.py runs the model in a process of its own through these two
# functions. In the server's process the NCNN inference held the interpreter
# lock for its whole ~0.4 s pass, which froze the event loop: measured on a Pi 4,
# even /status took 340 ms, the stream fell to 2 fps, and drive commands queued
# behind the model. A separate process has its own lock and its own core.

# Above the server's priority, so video and drive commands win the CPU and the
# model gets what is left. A Pi 4 has cores to spare for it either way.
DETECTOR_NICE = 10

_worker: FireDetector | None = None


def worker_load() -> list[str]:
    """Load the model in the detector process. Returns its class names."""
    global _worker
    try:
        os.nice(DETECTOR_NICE)
    except (AttributeError, OSError):  # no nice() on Windows; the split still helps
        pass
    import torch

    # PyTorch does the pre-processing, with its own pool of one thread per core.
    torch.set_num_threads(DETECT_THREADS)
    _worker = FireDetector()
    _worker.load()
    return list(_worker.names.values())


def worker_detect(frame: Any) -> tuple[list[dict[str, Any]], float]:
    """One inference pass in the detector process: detections and the time it took."""
    if _worker is None:
        raise DetectorUnavailable("the detector process has not loaded a model")
    detections = _worker.detect(frame)
    return detections, _worker.last_inference_ms
