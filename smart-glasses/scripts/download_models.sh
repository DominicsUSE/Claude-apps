#!/usr/bin/env bash
# Downloads the offline models into ./models (~110 MB):
#   Vosk small English speech model (~40 MB), SSD-MobileNet-v2 COCO detector (~70 MB).
#   --piper  also fetches a Piper voice for nicer text-to-speech (~60 MB).
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p models
cd models

if [ ! -d vosk-model-small-en-us-0.15 ]; then
  curl -fL -o vosk.zip https://alphacephei.com/vosk/models/vosk-model-small-en-us-0.15.zip
  unzip -q vosk.zip && rm vosk.zip
fi

if [ ! -f ssd_mobilenet_v2_coco_2018_03_29/frozen_inference_graph.pb ]; then
  curl -fL https://storage.googleapis.com/download.tensorflow.org/models/object_detection/ssd_mobilenet_v2_coco_2018_03_29.tar.gz \
    | tar xz ssd_mobilenet_v2_coco_2018_03_29/frozen_inference_graph.pb
fi
[ -f ssd_mobilenet_v2_coco_2018_03_29.pbtxt ] || curl -fLO \
  https://raw.githubusercontent.com/opencv/opencv_extra/4.x/testdata/dnn/ssd_mobilenet_v2_coco_2018_03_29.pbtxt

if [ "${1:-}" = "--piper" ]; then
  for f in en_US-lessac-low.onnx en_US-lessac-low.onnx.json; do
    [ -f "$f" ] || curl -fLO "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/low/$f"
  done
fi
echo "models ready in $PWD"
