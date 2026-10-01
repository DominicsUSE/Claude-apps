# Face-recognition embedding model (EdgeFace)

`edgeface_xxs.onnx` is the "XXS" variant of [EdgeFace](https://github.com/otroshi/edgeface)
(Idiap Research Institute), an EdgeNeXt-based face-recognition model built for efficient,
on-device inference. Downloaded unmodified from the ONNX re-export at
[yakhyo/edgeface-onnx](https://github.com/yakhyo/edgeface-onnx) (release asset
`edgeface_xxs.onnx`, verified against the SHA-256 published in that project's own model
registry: `dc674de4cbc77fa0bf9a82d5149558ab8581d82a2cd3bb60f28fd1a5d3ff8a2f`). Both the
original architecture/weights and the ONNX re-export are
[BSD-3-Clause licensed](https://github.com/otroshi/edgeface/blob/main/LICENSE) — no
non-commercial or share-alike restriction, unlike several other face models in the same
`yakhyo/uniface` family (SCRFD, ArcFace/`w600k_*`, AgeGender, 106-point landmarks) which
are InsightFace-derived and restricted to non-commercial research use and were
deliberately **not** used here for that reason.

XXS is the smallest variant: 1.24M parameters, ~5MB. Input: a 112x112 RGB face crop,
*already aligned* so the eyes/nose/mouth land on a fixed reference layout (this app
performs that alignment itself — see `alignFaceCrop()`/`estimateSimilarityTransform()` in
`dinocam/index.html` — using 5-point landmarks derived from face-api.js's existing
68-point detection, against the standard ArcFace-style reference template). Preprocessing:
`(pixel - 127.5) / 127.5` per channel, RGB order. Output: a single 512-D embedding vector,
L2-normalized before use; two faces are compared by cosine similarity.

It runs fully client-side via ONNX Runtime Web, the same engine already used for the
plate-OCR model (`dinocam/models/plate-ocr/`) — no image or embedding is ever sent
anywhere. It supplements, not replaces, the app's existing face-api.js-based recognition:
face-api.js still does detection, 68-point landmarks, and expression; this model only
replaces the *recognition* embedding with a stronger one. A person enrolled before this
model was added keeps matching on their original face-api.js descriptor until
re-enrolled — see `dinocam/test/README.md` for details and accuracy comparison.
