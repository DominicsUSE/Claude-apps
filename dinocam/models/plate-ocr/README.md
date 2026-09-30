# Plate-specific OCR model

`cct_xs_v2_global.onnx` is the "XS" v2 global license-plate recognition model from
[ankandrew/fast-plate-ocr](https://github.com/ankandrew/fast-plate-ocr) (weights hosted at
[ankandrew/cnn-ocr-lp](https://github.com/ankandrew/cnn-ocr-lp)), downloaded unmodified from
that project's GitHub release. Both the training code and the released weights are
[MIT licensed](https://github.com/ankandrew/fast-plate-ocr/blob/master/LICENSE) — no
non-commercial or share-alike restriction.

It's a Compact Convolutional Transformer trained on 220k+ real license plates across 65+
countries, with a fixed-length (10-slot) character classification head — a model actually
built for this task, unlike the generic document-OCR engine (Tesseract) this app also
carries as a fallback. It runs fully client-side via ONNX Runtime Web; no image is sent
anywhere to use it.

Input: `(1, 64, 128, 3)` uint8 RGB, stretched to fit (no aspect-ratio padding). Output:
`plate` — `(1, 10, 38)` logits, one 38-way softmax per character slot over the alphabet
`0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_` (`_` = padding, stripped from the end of the decoded
string) — and `region` (unused here). See `dinocam/index.html`'s `runPlateModel()` /
`decodePlateOutput()` for the exact preprocessing/decoding this app applies, mirroring
`fast_plate_ocr/core/process.py` in the upstream project.

Measured on 10 real, unconstrained photos from the `openalpr/benchmarks` test set (not
bundled with the app): 8/10 exact plate reads, vs. 1/10 for the app's existing generic
Tesseract path on the same photos and same ground-truth crop. See
`dinocam/test/README.md` for the full comparison.
