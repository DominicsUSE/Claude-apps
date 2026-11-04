"""Vision assistant: camera frame + sensor readings -> Claude -> short spoken answer.

Optional: without an API key or network it answers from on-device data
(detector, distance, thermal). Images leave the device only when you ask a
question; nothing is sent in the background.
"""

from __future__ import annotations

import base64
import logging

import cv2
import numpy as np

from glasses.text import local_answer, sensor_context

log = logging.getLogger(__name__)

SYSTEM = """You are the voice assistant inside a pair of DIY smart glasses. The wearer hears your reply through a small speaker.

How to answer:
- At most two short sentences (under 40 words) unless the wearer asks for detail. Plain spoken English: no markdown, lists or emoji.
- The attached image is what the wearer is facing right now. Sensor readings come with each question; they are measurements that can be wrong, so say so when they disagree with the image.
- Describe people only generically ("a person about two metres ahead, on your left"). Never identify anyone or guess sensitive traits from appearance.
- For electricity, gas, structural, medical or road-safety questions, give the cautious answer and point to the proper tool or professional. The wall probe and radar give hints, not guarantees."""

FALLBACK_BETA = "server-side-fallback-2026-07-01"


def image_block(frame: np.ndarray, max_px: int) -> dict:
    """BGR frame -> base64 JPEG content block, downscaled to cut tokens/latency."""
    h, w = frame.shape[:2]
    scale = max_px / max(h, w)
    if scale < 1:
        frame = cv2.resize(frame, (int(w * scale), int(h * scale)), interpolation=cv2.INTER_AREA)
    ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
    if not ok:
        raise ValueError("JPEG encoding failed")
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.standard_b64encode(jpg.tobytes()).decode()}}


class Assistant:
    def __init__(self, cfg: dict):
        self.cfg = cfg
        self.client = None
        self.history: list[tuple[str, str]] = []  # (question, answer), text only
        if not cfg["enabled"]:
            return
        try:
            import anthropic
        except ImportError:
            log.warning("anthropic SDK not installed: assistant runs offline")
            return
        self.anthropic = anthropic
        # Credentials: ANTHROPIC_API_KEY (or an `ant auth login` profile).
        self.client = anthropic.Anthropic(timeout=30.0, max_retries=1)

    def _messages(self, question: str, frame, snapshot: dict) -> list[dict]:
        # Earlier turns are replayed as plain text (no images) to keep each
        # request small; only the current turn carries the camera frame.
        messages: list[dict] = []
        for q, a in self.history:
            messages += [{"role": "user", "content": q}, {"role": "assistant", "content": a}]
        content: list[dict] = []
        if frame is not None:
            content.append(image_block(frame, int(self.cfg["image_max_px"])))
        content.append({"type": "text", "text":
                        f"Sensor readings:\n{sensor_context(snapshot)}\n\nThe wearer asks: {question}"})
        messages.append({"role": "user", "content": content})
        return messages

    def ask(self, question: str, frame: np.ndarray | None, snapshot: dict) -> str:
        if self.client is None:
            return local_answer(snapshot)
        a = self.anthropic
        try:
            resp = self.client.beta.messages.create(
                model=self.cfg["model"],
                max_tokens=int(self.cfg["max_tokens"]),
                system=SYSTEM,
                messages=self._messages(question, frame, snapshot),
                output_config={"effort": self.cfg["effort"]},
                # If a safety classifier declines, retry server-side on the
                # recommended fallback model instead of failing.
                betas=[FALLBACK_BETA],
                fallbacks="default",
            )
        except a.AuthenticationError:
            return "My API key was rejected. Check ANTHROPIC_API_KEY."
        except a.RateLimitError:
            return "The AI service is busy. Try again in a minute."
        except a.APIStatusError as e:
            log.error("API error %s: %s", e.status_code, e.message)
            return f"The AI service returned error {e.status_code}."
        except a.APIConnectionError:
            return local_answer(snapshot) + " I'm offline, so that's from my own sensors."
        except Exception:  # noqa: BLE001 - e.g. no credentials configured
            log.exception("assistant request failed")
            return local_answer(snapshot)
        if resp.stop_reason == "refusal":
            return "I can't help with that one."
        answer = " ".join(b.text for b in resp.content if b.type == "text").strip()
        if not answer:
            return "I have no answer for that."
        self.history = (self.history + [(question, answer)])[-int(self.cfg["history_turns"]):]
        return answer
