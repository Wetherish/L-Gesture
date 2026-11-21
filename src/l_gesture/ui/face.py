"""Face overlays adapted from Logitech SDK 1.5.2.

Copyright (c) 2026 Logitech Europe S.A.
SPDX-License-Identifier: MIT
"""

import cv2

# ── Face mesh landmark regions (MediaPipe 478-point indices) ────────────────
FACE_REGIONS = {
    "jaw":       (list(range(172, 200)) + [0],                   (180, 180, 180)),
    "l_eyebrow": (list(range(70, 80)),                           (180, 130, 255)),
    "r_eyebrow": (list(range(300, 310)),                         (180, 130, 255)),
    "l_eye":     (list(range(130, 160)),                          (255, 180, 100)),
    "r_eye":     (list(range(360, 390)),                          (255, 180, 100)),
    "nose":      (list(range(1, 20)),                             (0, 200, 255)),
    "lips":      (list(range(61, 96)) + list(range(185, 213)),    (80, 80, 255)),
    "l_iris":    (list(range(468, 473)),                          (80, 230, 80)),
    "r_iris":    (list(range(473, 478)),                          (80, 230, 80)),
}

def _lm_xy(lm):
    """Extract (x, y) from a landmark in either [x,y,z] or {"x":..} form."""
    if isinstance(lm, dict):
        return lm["x"], lm["y"]
    return lm[0], lm[1]


# ── Drawing helpers ─────────────────────────────────────────────────────────

def draw_face_bbox(frame, face, frame_w, frame_h):
    bbox = face.get("bbox", [])
    if len(bbox) < 4:
        return
    bx, by, bw, bh = bbox
    x1 = max(0, int(bx))
    y1 = max(0, int(by))
    x2 = min(frame_w - 1, int(bx + bw))
    y2 = min(frame_h - 1, int(by + bh))
    conf = face.get("confidence", 0)
    cv2.rectangle(frame, (x1, y1), (x2, y2), (0, 255, 0), 2)
    cv2.putText(frame, f"face {conf:.2f}", (x1, max(y1 - 8, 15)),
                cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 1)


def draw_face_landmarks(frame, landmarks, frame_w, frame_h):
    """Draw the face mesh. Landmarks are already absolute pixels of the
    stream (same space as `bbox`), so they are drawn without any mapping."""
    if not landmarks:
        return
    n = len(landmarks)
    for lm in landmarks:
        lx, ly = _lm_xy(lm)
        x, y = int(lx), int(ly)
        if 0 <= x < frame_w and 0 <= y < frame_h:
            cv2.circle(frame, (x, y), 1, (100, 100, 100), -1)
    for region_name, (indices, color) in FACE_REGIONS.items():
        for idx in indices:
            if idx >= n:
                continue
            lx, ly = _lm_xy(landmarks[idx])
            x, y = int(lx), int(ly)
            if 0 <= x < frame_w and 0 <= y < frame_h:
                r = 3 if "iris" in region_name else 2
                cv2.circle(frame, (x, y), r, color, -1)
    cv2.putText(frame, f"Face Mesh: {n} pts", (10, 30),
                cv2.FONT_HERSHEY_SIMPLEX, 0.7, (0, 255, 0), 2)


def draw_overlays(frame, ai_data, frame_w, frame_h, want_face_mesh):
    """Apply all enabled overlays on `frame` in-place.

    The firmware draws nothing on the video, so every box and landmark you
    see comes from the JSON and is drawn here. Both modes (live frame and
    --device-snapshot) therefore look the same.
    """
    if not ai_data:
        return
    for face in ai_data.get("faces", []):
        draw_face_bbox(frame, face, frame_w, frame_h)
        if want_face_mesh:
            draw_face_landmarks(frame, face.get("landmarks", []), frame_w, frame_h)
