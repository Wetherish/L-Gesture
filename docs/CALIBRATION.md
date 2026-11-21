# Gesture timing calibration

Keep the official Hands Tracker running, then launch the standard-library-only recorder:

```powershell
python examples/record_calibration.py
```

It tries local ports 8765 and 9000; use `--port 9001` for another port.
This does not open the camera, record video, run another model, or inject OS input.

Before starting, move only your actual right thumb and index finger. Choose the
tracker label whose distance responds. Keep this recorder window focused.

The large prompt announces SINGLE or DOUBLE before each capture:

1. **Hold Space** with your left hand while performing the requested right-hand gesture.
2. **Release Space** to stop and freeze the resulting distance-versus-time pattern.
3. Click **Accept and next** to keep it, or **Retry this trial** to repeat the same prompt.
4. Rest as long as needed before holding Space for the next capture.

There are six single and six double captures. There is no countdown or time limit.
Only the period while Space is held is captured. Losing window focus stops the capture.
Rejected attempts are retained for inspection, marked `decision: rejected` in the
summary's capture windows. Analyze only `accepted` windows; `pending` means unreviewed.

Keep both fingertips visible and use the intended working distance.

Each run gets a unique folder under `captures/calibration/` (ignored by Git):

- `telemetry.jsonl`: every received tracker message, both hands, source timestamp,
  local receipt time, and instructed phase/trial.
- `distances.csv`: selected-hand distance, both labels' distances, and validity.
- `summary.json`: completion status, timing statistics, and missing/ambiguous counts.

Only samples inside the manually marked capture windows are saved. Window boundaries
are included in the summary; session-wide gap statistics include deliberate pauses.

Closing the window or pressing **Stop and save partial** saves an aborted session.
The original tracker smoothing is preserved. No resampling, interpolation or
five-sample reduction is done here. Prompt labels are intended actions, not verified
ground truth; inspect each trace before fitting a detector. Use tracker timestamps
for gesture timing and receipt timestamps for transport-gap diagnostics. A five-point
window spans four sampling intervals. Choose intervals and single/double timeouts
after measuring actual closure durations and gaps; evaluate on held-out recordings.

Physical-object detection is deliberately outside this calibration tool.
