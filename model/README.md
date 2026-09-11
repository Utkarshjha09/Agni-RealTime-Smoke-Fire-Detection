# Agni detector training

Everything to do with the detector's weights: fetching ones already trained,
training your own on the dataset behind
[sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11](https://github.com/sayedgamal99/Real-Time-Smoke-Fire-Detection-YOLO11),
and exporting either into a format the Raspberry Pi runs quickly.

Training is optional. If you just want the rover detecting fire today, jump to
**The short path** below.

| File | Purpose |
|---|---|
| `fetch_pretrained.py` | download already-trained weights, no training needed |
| `download_dataset.py` | fetch the Roboflow dataset into `data/` and fix its paths |
| `train.py` | train yolo11n on it locally |
| `train_colab.ipynb` | the same training on a free Colab or Kaggle GPU |
| `export.py` | convert weights to NCNN/ONNX for the Pi |

## The short path: no training at all

The reference repo publishes weights already trained on this dataset. Two commands
put them on the rover:

```bash
python fetch_pretrained.py     # 5.5 MB, classes Fire and Smoke
python export.py --weights weights/best_nano_111.pt
```

Verified on this machine: the weights load, report classes `['Fire', 'Smoke']`, and
detect fire and smoke on real photographs. Measured on four sample images at 640px,
CPU:

| Image | Detections | Top confidence |
|---|---|---|
| burning house | 2 | Fire 0.83 |
| car fire | 1 | Fire 0.87 |
| wildfire | 4 | Fire 0.66 |
| distant smoke | 1 | Smoke 0.36 |

Those same images at 320px found less: the distant-smoke photo produced **nothing
at 320 and a detection at 640**. That is why `export.py` defaults to 640 even
though the rover's own `DETECT_IMGSZ` default is 320. Under-detecting fire is the
expensive mistake. Set `DETECT_IMGSZ=640` on the rover to match the export, and
drop both to 416 only if the Pi cannot keep up.

Nothing here is installed on the rover. The Pi only needs
`raspberry_pi/requirements.txt` plus the exported weights.

## The dataset

[Fire-Smoke-Detection-YOLOv11 v2](https://universe.roboflow.com/sayed-gamall/fire-smoke-detection-yolov11),
10,463 annotated images, two classes `Fire` and `Smoke`.

| Split | Images | Annotations |
|---|---|---|
| train | 9,156 | 27,468 |
| valid | 872 | 2,616 |
| test | 435 | 1,305 |

It is **not** vendored into this repo. It is about a gigabyte, it has its own
licence, and Roboflow hands it out only to an account. `data/` is git-ignored.

## 1. Install

Install PyTorch for your hardware **first**, then the rest:

```bash
cd model
# NVIDIA GPU:
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu121
# or CPU only (see the warning below):
pip install torch torchvision

pip install -r requirements.txt
```

Check the GPU is actually visible before spending hours on a run:

```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
```

If that prints `False`, you installed the CPU build. Training this dataset on a
CPU takes days, not hours. Use a CUDA build, train on Colab or Kaggle, or stay
with the pretrained weights the rover downloads on its own.

## 2. Download the dataset

Roboflow needs a free account key from
[app.roboflow.com/settings/api](https://app.roboflow.com/settings/api):

```bash
ROBOFLOW_API_KEY=xxxx python download_dataset.py
```

This writes `data/Fire-Smoke-Detection-YOLOv11-2/` and rewrites its `data.yaml`
with absolute split paths, without which ultralytics looks in its own datasets
directory and trains on nothing.

## 3. Train

On a free Colab or Kaggle T4, open `train_colab.ipynb` and run it top to bottom.
That is the better option unless you have a desktop GPU: it runs the same recipe,
checks per-class recall, and hands you the NCNN export at the end.

Locally:

```bash
python train.py
```

Defaults follow the reference recipe: `yolo11n.pt`, 640px, 250 epochs, early
stop after 20 epochs with no improvement. Batch size is the one deliberate
change. The reference used 32 on a 16 GB Kaggle P100; `--batch -1` lets
ultralytics fit the batch to your card instead, which is what makes a 4 GB
laptop GPU work. Mixed precision is on for the same reason.

```bash
python train.py --batch 8 --epochs 100   # pin it yourself
python train.py --workers 0              # if the Windows dataloader stalls
python train.py --resume                 # continue an interrupted run
```

Expect hours, not minutes. A 4 GB laptop GPU runs roughly 5 to 8 hours for a
full early-stopped run. Results land in `runs/agni-fire-smoke/`, with
`weights/best.pt` and the usual precision, recall and confusion-matrix plots.
Read those plots before trusting the model: this is a fire detector, and recall
on `Fire` matters more than a headline mAP.

## 4. Export for the Pi

```bash
python export.py
```

NCNN at 320px by default, matching the rover's `DETECT_IMGSZ`. The export bakes
its input size in, so if you change one, change the other.

## 5. Run it on the rover

Copy the exported folder to the Pi and point the service at it:

```bash
MODEL_PATH=/home/pi/best_ncnn_model DETECT_IMGSZ=320 DETECTOR=1 \
  ROVER_TOKEN=yourtoken python3 rover_server.py
```

`MODEL_PATH` overrides the Hugging Face download entirely, so the rover runs
your weights and never reaches the network for a model. The detector maps class
names loosely, so `Fire` and `Smoke` from this dataset map onto the two kinds
the app draws without any further change.
