#!/usr/bin/env python3
"""Watch the fire/smoke detector work, live, on this computer's webcam.

This is the quickest honest answer to "does the model actually detect anything?".
It runs the same weights the rover runs, on your laptop camera, and draws what it
finds. Hold a lighter, a candle, or a phone showing a fire video in front of the
lens.

    python live_test.py                     # opens http://127.0.0.1:8777
    python live_test.py --weights weights/best_nano_111.pt
    python live_test.py --conf 0.15         # more sensitive, more false boxes
    python live_test.py --camera 1          # a second webcam
    python live_test.py --window            # a desktop window instead of the browser
    python live_test.py --headless          # no video at all, prints detections

The default is a browser page rather than a desktop window because the rover needs
`opencv-python-headless`, which has no GUI support compiled in. Serving the frames
avoids having to install a second OpenCV just to look at them. `--window` works if
you have the full `opencv-python` instead, and the browser is used automatically
if it does not.

Press Ctrl+C to stop.

This is a check on the model, not on the rover. It deliberately skips the rover's
server-side sensitivity gate, so you see everything the model reports at --conf.
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
DEFAULT_WEIGHTS = HERE / "weights" / "best_nano_111_ncnn_model"

# BGR, matching the app: fire is orange, smoke is grey-blue.
COLOURS = {"fire": (40, 120, 255), "smoke": (200, 170, 140)}


def open_camera(index: int, cv2):
    """Try the common Windows backends because laptop webcams vary by driver."""
    backends = [("default", 0)]
    if sys.platform == "win32":
        backends = [("default", 0), ("Media Foundation", cv2.CAP_MSMF), ("DirectShow", cv2.CAP_DSHOW)]
    for name, backend in backends:
        capture = cv2.VideoCapture(index, backend)
        if capture.isOpened():
            print(f"camera {index} opened with {name}")
            return capture
        capture.release()
    return None


class Stats:
    """What the run has seen so far, shared between the camera thread and the page."""

    def __init__(self) -> None:
        self.frames = 0
        self.seen = {"fire": 0, "smoke": 0}
        self.best = {"fire": 0.0, "smoke": 0.0}
        self.recent_ms: deque[float] = deque(maxlen=30)
        self.started = time.monotonic()

    @property
    def average_ms(self) -> float:
        return sum(self.recent_ms) / len(self.recent_ms) if self.recent_ms else 0.0

    def report(self, imgsz: int) -> str:
        lines = [f"\n{self.frames} frames in {time.monotonic() - self.started:.0f}s"]
        if self.recent_ms:
            lines.append(f"inference {self.average_ms:.0f} ms per frame at {imgsz}px on this CPU")
        for kind in ("fire", "smoke"):
            if self.seen[kind]:
                lines.append(f"{kind}: {self.seen[kind]} boxes, best confidence {self.best[kind]:.0f}%")
            else:
                lines.append(f"{kind}: none detected")
        if not any(self.seen.values()):
            lines.append("\nNothing was detected. Pointed at an ordinary room, that is the correct result.")
            lines.append("Test against a real flame or a fire video before concluding the model is broken.")
        return "\n".join(lines)


class LatestFrame:
    """The most recent annotated JPEG, handed from the camera thread to readers."""

    def __init__(self) -> None:
        self._data: bytes | None = None
        self._ready = threading.Condition()
        self.stopped = False

    def publish(self, data: bytes) -> None:
        with self._ready:
            self._data = data
            self._ready.notify_all()

    def wait(self, timeout: float = 5.0) -> bytes | None:
        with self._ready:
            self._ready.wait(timeout)
            return self._data

    def stop(self) -> None:
        with self._ready:
            self.stopped = True
            self._ready.notify_all()


def classify(label: str) -> str | None:
    """Same loose mapping the rover uses, so this test agrees with the rover."""
    name = label.strip().lower()
    if "fire" in name or "flame" in name:
        return "fire"
    if "smoke" in name:
        return "smoke"
    return None


def draw_box(frame, kind: str, confidence: float, box, cv2) -> None:
    x1, y1, x2, y2 = (int(value) for value in box)
    colour = COLOURS[kind]
    cv2.rectangle(frame, (x1, y1), (x2, y2), colour, 2)
    label = f"{kind.upper()} {confidence:.0f}%"
    (width, height), _ = cv2.getTextSize(label, cv2.FONT_HERSHEY_SIMPLEX, 0.6, 2)
    top = max(y1, height + 12)
    cv2.rectangle(frame, (x1, top - height - 10), (x1 + width + 8, top), colour, -1)
    cv2.putText(frame, label, (x1 + 4, top - 6), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (16, 16, 16), 2, cv2.LINE_AA)


def annotate(frame, found: list, stats: Stats, conf: float, cv2) -> None:
    status = f"{stats.average_ms:.0f} ms  {1000 / stats.average_ms:.1f} fps  conf>={conf:.2f}" if stats.average_ms else "warming up"
    counts = f"fire {stats.seen['fire']}  smoke {stats.seen['smoke']}"
    cv2.putText(frame, status, (12, 28), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    cv2.putText(frame, counts, (12, 56), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 255, 255), 2, cv2.LINE_AA)
    if not found:
        cv2.putText(frame, "nothing detected", (12, 84), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (170, 170, 170), 1, cv2.LINE_AA)


PAGE = b"""<!doctype html>
<title>Agni detector</title>
<style>
  body { margin: 0; background: #0b0f14; color: #e8edf3;
         font: 14px system-ui, -apple-system, Segoe UI, sans-serif;
         display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 20px; }
  h1 { font-size: 16px; font-weight: 600; margin: 0; letter-spacing: .01em; }
  img { max-width: 100%; border-radius: 10px; border: 1px solid #22303d; }
  p { margin: 0; color: #8fa3b5; max-width: 60ch; text-align: center; line-height: 1.5; }
  code { color: #cfe3f5; }
</style>
<h1>Agni fire and smoke detector, live</h1>
<img src="/stream.mjpg" alt="camera with detections drawn on it">
<p>Hold a lighter, a candle, or a phone playing a fire video in front of the camera.
Boxes are drawn on anything the model reports. Stop it with <code>Ctrl+C</code> in the terminal.</p>
"""


def browser_camera_page(conf: float) -> bytes:
    return f"""<!doctype html>
<title>Agni detector</title>
<style>
  body {{ margin: 0; background: #0b0f14; color: #e8edf3;
         font: 14px system-ui, -apple-system, Segoe UI, sans-serif;
         display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 20px; }}
  h1 {{ font-size: 16px; font-weight: 600; margin: 0; letter-spacing: .01em; }}
  #stage {{ position: relative; max-width: min(100%, 1100px); }}
  video, canvas {{ width: 100%; border-radius: 10px; border: 1px solid #22303d; }}
  #overlay {{ position: absolute; inset: 0; pointer-events: none; }}
  p {{ margin: 0; color: #8fa3b5; max-width: 60ch; text-align: center; line-height: 1.5; }}
  .status {{ color: #cfe3f5; }}
</style>
<h1>Agni fire and smoke detector, live</h1>
<div id="stage">
  <video id="video" autoplay playsinline muted></video>
  <canvas id="overlay"></canvas>
</div>
<p class="status" id="status">Starting camera...</p>
<p>Chrome owns the webcam. Frames are sent to the local Python model and boxes are drawn from real detections.</p>
<script>
const video = document.getElementById('video');
const overlay = document.getElementById('overlay');
const statusEl = document.getElementById('status');
const capture = document.createElement('canvas');
const ctx = capture.getContext('2d');
const out = overlay.getContext('2d');
let busy = false;

function resizeCanvas() {{
  const w = video.videoWidth || 640;
  const h = video.videoHeight || 480;
  capture.width = w;
  capture.height = h;
  overlay.width = w;
  overlay.height = h;
}}

function drawBoxes(detections, inferenceMs) {{
  resizeCanvas();
  out.clearRect(0, 0, overlay.width, overlay.height);
  out.font = '18px system-ui, sans-serif';
  out.lineWidth = 3;
  for (const det of detections) {{
    const b = det.boundingBox;
    const x = b.left / 100 * overlay.width;
    const y = b.top / 100 * overlay.height;
    const w = b.width / 100 * overlay.width;
    const h = b.height / 100 * overlay.height;
    const color = det.kind === 'fire' ? '#ff7a2f' : '#8fb4c8';
    out.strokeStyle = color;
    out.fillStyle = color;
    out.strokeRect(x, y, w, h);
    const label = `${{det.kind.toUpperCase()}} ${{det.confidence.toFixed(0)}}%`;
    const text = out.measureText(label);
    out.fillRect(x, Math.max(0, y - 28), text.width + 12, 26);
    out.fillStyle = '#111820';
    out.fillText(label, x + 6, Math.max(18, y - 9));
  }}
  statusEl.textContent = detections.length
    ? `${{detections.length}} detection(s), ${{inferenceMs.toFixed(0)}} ms`
    : `nothing detected, ${{inferenceMs.toFixed(0)}} ms, conf >= {conf:.2f}`;
}}

async function sendFrame() {{
  if (busy || video.readyState < 2) return;
  busy = true;
  resizeCanvas();
  ctx.drawImage(video, 0, 0, capture.width, capture.height);
  const blob = await new Promise(resolve => capture.toBlob(resolve, 'image/jpeg', 0.82));
  try {{
    const response = await fetch('/detect', {{ method: 'POST', body: blob }});
    const data = await response.json();
    drawBoxes(data.detections, data.inferenceMs);
  }} catch (error) {{
    statusEl.textContent = `Detector request failed: ${{error}}`;
  }} finally {{
    busy = false;
  }}
}}

async function start() {{
  try {{
    video.srcObject = await navigator.mediaDevices.getUserMedia({{
      video: {{ width: {{ ideal: 1280 }}, height: {{ ideal: 720 }} }},
      audio: false
    }});
    video.onloadedmetadata = () => {{
      resizeCanvas();
      statusEl.textContent = 'Camera ready. Point it at a real flame or fire video.';
      setInterval(sendFrame, 450);
    }};
  }} catch (error) {{
    statusEl.textContent = `Camera permission failed: ${{error}}`;
  }}
}}
start();
</script>
""".encode("utf-8")


def make_handler(latest: LatestFrame):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass  # The terminal is for detections, not one line per frame request.

        def do_GET(self) -> None:
            if self.path in ("/", "/index.html"):
                self.send_response(200)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(PAGE)))
                self.end_headers()
                self.wfile.write(PAGE)
                return
            if self.path != "/stream.mjpg":
                self.send_error(404)
                return

            self.send_response(200)
            self.send_header("Age", "0")
            self.send_header("Cache-Control", "no-cache, private")
            self.send_header("Content-Type", "multipart/x-mixed-replace; boundary=FRAME")
            self.end_headers()
            try:
                while not latest.stopped:
                    data = latest.wait()
                    if data is None:
                        continue
                    self.wfile.write(b"--FRAME\r\n")
                    self.send_header("Content-Type", "image/jpeg")
                    self.send_header("Content-Length", str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    self.wfile.write(b"\r\n")
            except (BrokenPipeError, ConnectionResetError):
                pass  # The tab was closed. Normal.

    return Handler


def make_browser_camera_handler(model, cv2, conf: float, imgsz: int):
    page = browser_camera_page(conf)

    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_args) -> None:
            pass

        def do_GET(self) -> None:
            if self.path not in ("/", "/index.html"):
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(page)))
            self.end_headers()
            self.wfile.write(page)

        def do_POST(self) -> None:
            if self.path != "/detect":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", "0"))
            data = self.rfile.read(length)
            try:
                import numpy as np

                encoded = np.frombuffer(data, dtype=np.uint8)
                frame = cv2.imdecode(encoded, cv2.IMREAD_COLOR)
                if frame is None:
                    raise ValueError("could not decode frame")
                started = time.perf_counter()
                results = model.predict(source=frame, imgsz=imgsz, conf=conf, iou=0.45, verbose=False)
                inference_ms = round((time.perf_counter() - started) * 1000, 1)
                height, width = frame.shape[:2]
                detections = []
                for result in results:
                    for box in getattr(result, "boxes", []) or []:
                        kind = classify(model.names.get(int(box.cls[0]), ""))
                        if kind is None:
                            continue
                        x1, y1, x2, y2 = (float(value) for value in box.xyxy[0])
                        detections.append({
                            "kind": kind,
                            "confidence": round(float(box.conf[0]) * 100, 1),
                            "boundingBox": {
                                "left": round(max(0.0, x1) / width * 100, 2),
                                "top": round(max(0.0, y1) / height * 100, 2),
                                "width": round(max(0.0, x2 - x1) / width * 100, 2),
                                "height": round(max(0.0, y2 - y1) / height * 100, 2),
                            },
                        })
                body = json.dumps({"detections": detections, "inferenceMs": inference_ms}).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            except Exception as error:  # noqa: BLE001 - report to the local test page.
                body = json.dumps({"error": str(error), "detections": [], "inferenceMs": 0}).encode("utf-8")
                self.send_response(500)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

    return Handler


def serve_browser_camera(model, cv2, conf: float, imgsz: int, port: int) -> None:
    server = ThreadingHTTPServer(("127.0.0.1", port), make_browser_camera_handler(model, cv2, conf, imgsz))
    print(f"\n  open  http://127.0.0.1:{port}  in your browser\n")
    print("Chrome will ask for camera permission. Ctrl+C here stops the test.\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--weights", type=Path, default=DEFAULT_WEIGHTS, help="weights or NCNN folder")
    parser.add_argument("--camera", type=int, default=0, help="webcam index (default: 0)")
    parser.add_argument("--imgsz", type=int, default=640, help="must match what the model was exported at")
    parser.add_argument("--conf", type=float, default=0.25, help="model confidence floor (default: 0.25)")
    parser.add_argument("--port", type=int, default=8777, help="port for the browser view")
    parser.add_argument("--window", action="store_true", help="desktop window; needs the full opencv-python")
    parser.add_argument("--headless", action="store_true", help="no video at all, print detections only")
    parser.add_argument("--browser-camera", action="store_true", help="use Chrome's webcam access and send frames to Python")
    args = parser.parse_args()

    try:
        import cv2
        from ultralytics import YOLO
    except ImportError as error:
        print(f"{error}. Run: pip install -r requirements.txt", file=sys.stderr)
        return 2

    if not args.weights.exists():
        print(f"No weights at {args.weights}\nGet them first:  python fetch_pretrained.py", file=sys.stderr)
        return 2

    print(f"loading {args.weights}")
    # NCNN needs the task stated: unlike a .pt, the export carries no task metadata.
    model = YOLO(str(args.weights), task="detect")
    print(f"classes: {list(model.names.values())}")

    if args.browser_camera:
        serve_browser_camera(model, cv2, args.conf, args.imgsz, args.port)
        return 0

    capture = open_camera(args.camera, cv2)
    if capture is None:
        print(f"Could not open camera {args.camera}. Falling back to browser camera.", file=sys.stderr)
        serve_browser_camera(model, cv2, args.conf, args.imgsz, args.port)
        return 0
    capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
    capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)

    stats = Stats()
    latest = LatestFrame()
    server: ThreadingHTTPServer | None = None
    use_window = args.window and not args.headless

    if not args.headless and not use_window:
        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(latest))
        threading.Thread(target=server.serve_forever, daemon=True).start()
        print(f"\n  open  http://127.0.0.1:{args.port}  in your browser\n")

    print("hold a flame or a fire video in front of the camera. Ctrl+C to stop.\n")

    try:
        while True:
            ok, frame = capture.read()
            if not ok:
                print("camera stopped returning frames", file=sys.stderr)
                break

            inference_started = time.perf_counter()
            results = model.predict(source=frame, imgsz=args.imgsz, conf=args.conf, iou=0.45, verbose=False)
            stats.recent_ms.append((time.perf_counter() - inference_started) * 1000)
            stats.frames += 1

            found = []
            for result in results:
                for box in getattr(result, "boxes", []) or []:
                    kind = classify(model.names.get(int(box.cls[0]), ""))
                    if kind is None:
                        continue
                    confidence = float(box.conf[0]) * 100
                    found.append((kind, confidence))
                    stats.seen[kind] += 1
                    stats.best[kind] = max(stats.best[kind], confidence)
                    if not args.headless:
                        draw_box(frame, kind, confidence, box.xyxy[0], cv2)

            if found:
                summary = ", ".join(f"{kind} {confidence:.0f}%" for kind, confidence in found)
                print(f"[{time.strftime('%H:%M:%S')}] {summary}")

            if args.headless:
                continue

            annotate(frame, found, stats, args.conf, cv2)

            if use_window:
                try:
                    cv2.imshow("Agni detector -- q to quit", frame)
                    if (cv2.waitKey(1) & 0xFF) == ord("q"):
                        break
                except cv2.error:
                    print("\nThis OpenCV has no GUI support (it is the headless build).")
                    print(f"Falling back to the browser view on http://127.0.0.1:{args.port}\n")
                    use_window = False
                    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(latest))
                    threading.Thread(target=server.serve_forever, daemon=True).start()
            else:
                ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    latest.publish(encoded.tobytes())
    except KeyboardInterrupt:
        pass
    finally:
        latest.stop()
        capture.release()
        if server is not None:
            server.shutdown()
        if use_window:
            try:
                cv2.destroyAllWindows()
            except cv2.error:
                pass

    print(stats.report(args.imgsz))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
