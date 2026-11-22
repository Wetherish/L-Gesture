# Roofcat

A local camera and capture workspace. Roofcat opens with your camera, occupied captures and icon controls. **Developer mode** reveals the physical keypad layout, advanced navigation, device metadata, browser tracking and hand graphs.

**Hosted app:** [aperture-camera-lab.batikanor.chatgpt.site](https://aperture-camera-lab.batikanor.chatgpt.site)

**Download the current source and local launchers:** [aperture-local.zip](https://aperture-camera-lab.batikanor.chatgpt.site/downloads/aperture-local.zip). Extract the entire ZIP before running a launcher. `KIT-VERSION.txt` identifies the release.

The hosted app link is publicly accessible. Every visitor gets their own browser-local workspace. Camera feeds, selected files, screen captures, landmark inputs and recordings are processed locally by default. If you enter your own OpenAI key in the eye menu, a failed gaze-pin selection can send one frozen scene image directly to OpenAI to locate a desk object. The continuing pin footage stays local. The key lives only in this tab’s memory, is never logged or saved, and clears on reload or Forget key. Snapshots and saved pin previews use this browser’s local IndexedDB storage. Screen, camera, microphone and first-time keypad access each require the relevant explicit action and browser/operating-system permission.

## Open the full app for hardware access

Open the HTTPS app URL directly in **desktop Chrome or Edge**. An embedded preview can block WebHID, screen sharing or camera access through its parent’s Permissions Policy even when those APIs exist. Roofcat detects that restriction before requesting a device and offers **Open full app**; JavaScript inside an iframe cannot override the parent’s policy. Other browsers retain the features they support, including local image import and saved captures, but Safari and Firefox do not provide WebHID for physical keypad displays.

The browser readiness panel inside **?** checks actual API availability and the effective policy independently. “Available” means the browser supports the request, not that a device has been selected or OS permission has been granted. The **Share app** button copies a clean link without authentication query parameters. Permissions and captures belong to each browser context; a separate browser/profile or partitioned embed can have a separate board.

For hosting elsewhere, serve `dist/` over HTTPS without a restrictive `hid`, `camera`, `microphone` or `display-capture` policy. These features normally allow the top-level origin. If setting the header explicitly, use `Permissions-Policy: hid=(self), camera=(self), microphone=(self), display-capture=(self)`. A cross-origin embed also requires parent delegation and `allow="hid; camera; microphone; display-capture"` on the iframe. All ancestors must permit those features.

## Normal Call view and Developer mode

The app opens in normal **Call** view without requesting camera or microphone permission. The view keeps the camera and occupied captures visible, with no page headings, navigation tabs, device-name labels, FPS readouts or capture-type text. Camera and microphone controls use icons with accessible names and tooltips.

Every saved capture appears in the normal view, in board order. The first nine occupied captures map to the physical keypad from left to right, row by row; additional captures remain fully usable in the app. Removing or reordering a capture updates that projection immediately. There is no nine-capture software limit; available browser storage and active-source performance remain practical limits. A pin icon identifies a live pin; a camera icon identifies a snapshot. Select a capture to present it on the main stage while the camera remains in a smaller preview. Live pins keep updating; the camera-view action returns to the camera.

Each occupied tile has a **trash icon** beside its settings gear. Trash removes that capture immediately and offers **Undo**. It also releases that pin's source ownership without stopping other pins that share the camera. Paper and notebook captures additionally have a **magic-wand icon**: lit means scan enhancement is on; click to restore original colors, and click again to reapply it. Developer mode and Board show additional captures below the physical nine-key preview, with the same selection, reorder, settings, filtering and deletion actions.

The camera icon connects or stops the selected visual input. The microphone icon connects the selected microphone, then mutes or unmutes the same audio track. The meter reads the microphone without playing it through your speakers. Muting also silences audio already used by a recording. **End preview** releases camera and microphone, preserves saved captures, and leaves independent screen pins under their own sharing controls.

Click the **bug icon** to turn on Developer mode and restore the nine-slot keypad, capture tools and settings, workspace navigation, device names, FPS and other metadata, and the advanced camera, footage and SDK controls. **Devices** selects camera and microphone inputs; **Board** provides capture management. Pick, Remove, Reorder and physical left/right mode navigation keep the same underlying capture state.

Developer mode also enables Face, Hands and Body tracking together and reveals two graphs beneath the camera:

- **Fingertips:** all observed thumb, index, middle, ring and pinky tips, colored by finger. Left points are outlined; Right points are filled. Select a finger or a plot point to inspect source-image pixel coordinates, normalized x/y and the supplied wrist-relative z. Source-image coordinates start at the top-left; mirroring changes the display, not the numeric readings. The plot scales its two axes independently to keep portrait and landscape footage readable.
- **Right pinch:** a rolling 20-second graph of the distance between the explicitly classified Right thumb and index tips. **px** is the aspect-correct image-plane distance. **cm est.** uses the model's 3D world landmarks when available and is an uncalibrated estimate. It is not a depth-sensor or ruler measurement.

The overlay labels the subject's Left/Right hand and each observed finger. Missing handedness stays **Unknown**; a Left hand never substitutes for the Right pinch. Low confidence, duplicate Right classifications, lost hands and stale frames create gaps. Switching sources resets graph history. Sparse Logitech tracker results label only the actual supplied thumb/index tips. The graphs do not infer the other fingers from a midpoint.

All measurements are calculated locally. This is a **local call simulation**: it does not connect another participant, transmit microphone/video to a call service or start recording automatically. Detailed controls and measurement semantics are under **?**. The advanced controls described below are available with **Developer mode** enabled.

## Start with pins and snapshots — no camera needed

1. Open the app in desktop **Chrome or Edge**. The pin and camera icons work without Developer mode, a camera, landmark producer, Logitech camera SDK or Python bridge.
2. Click the **pin icon**, choose a tab, application window or screen in the browser picker, and confirm sharing. The whole source is pinned immediately, with no crop confirmation. The app requests that Roofcat keep focus using CaptureController when available; browsers without that API control their own focus behavior.
3. Use the **gear at the top right of a capture** to configure it. Crop an active pin without requesting screen sharing again, rename it, change its update rate, pause/resume it or end sharing. Crop replaces a saved photo only when you press **Apply crop**.
4. For a **snapshot**, click the camera capture icon, choose a source, select the region in the frozen preview and press **Capture snapshot**. New captures append to the board. The first nine appear on the physical keypad; adding more never overwrites an existing capture.
5. **Green pins** refresh at **10 fps by default**. Choose a different new-pin rate before capture, or change an existing pin from **0.2 to 10 fps**, including decimal values such as 2.5. **Red snapshots** preserve the frozen frame shown in the selector and release their temporary screen-sharing stream immediately.

Each capture has a large preview, editable name and PNG download. A pin also offers **Pause/Resume**, **Snapshot this pin**, and **End sharing**. Pausing keeps the source connected; ending sharing releases it and retains the last frame. **End all screen sharing** releases every screen source. Camera pins follow the main feed independently of screen pins; stopping or switching the main source pauses its pins immediately.

**Import image** accepts PNG, JPEG, WebP, AVIF or GIF images up to 20 MB and puts the decoded image on a red snapshot key. Captures retain their aspect ratio. Stored/exported previews fit within 1600 × 1200; physical-key images are 118 × 118 with an uncropped, contained thumbnail and a colored title/status area.

Snapshots save immediately; live pins checkpoint their preview approximately every five seconds and when paused. After reload, saved images and rates return, and pins restore **paused**. Click **Choose source again** to resume one. Browser screen-sharing permission cannot be reused silently. Captures are scoped to the browser and site origin; switching from the hosted site to localhost uses a separate board. Clearing site data clears local captures, so download images you want to keep outside this browser.

On macOS, allow the browser in **System Settings → Privacy & Security → Screen & System Audio Recording** if screen sharing is blocked. The app requests screen video with audio disabled. It never enumerates arbitrary tabs or bypasses the browser’s source picker. Background tabs and operating systems may lower the requested sampling rate.

## Two gestures: double pinch for a snapshot, two raised fingers for a pin

Hold one object in your **left hand**, clearly visible in the camera selected for **Object snapshots** (main RGB by default). Start with an open right hand, then bring the right thumb and index together and separate them **twice**. The first dot lights after the first complete pinch and release. Both dots light only after the second release completes an accepted double pinch; holding the second pinch closed is still pending. Roofcat then freezes the current camera image and saves a cropped snapshot of the detected held object, or a focused region **above** the visible left hand. When no usable left hand is present, one clearly dominant object can qualify instead. The live camera stays visible. There is no sharing picker or confirmation click on this path. The **Pin** and **Snapshot** screen-sharing buttons retain their existing tab/window/screen flows.

The brief HUD shows **Finding object…**, followed by the saved result or a clear failure, cancellation or blocked-action message. Both lit dots acknowledge the accepted gesture; the result message confirms its outcome. If no object is recognized but a confident left hand is visible, Roofcat saves a focused crop above the hand, where an object supported from below should be. Its lower edge stops at the base of the left index finger, excluding the lower palm and wrist. This hand-region fallback takes priority over an unrelated prominent object and also handles ambiguous object classes. If no left hand is visible, the existing conservative prominent-object check can still save one clear object. A double pinch **always follows the snapshot path** and never creates a pin. If neither a usable hand region nor object is visible, a short message explains why nothing was saved. Escape cancels the action; Developer mode can be off or on.

**To create a pin, hold the right index and middle fingers above the thumb, ring and little fingertips for 1.5 seconds.** Both raised fingers must be extended and visible. A compact green ring fills during the hold. Fresh, confident full-hand observations must continuously support the pose; duplicate display ticks, stale results, tracking gaps, replay data and source changes cannot complete it. One held pose creates one pin. Lower the fingers to rearm, including after an error or cancellation. The pin gesture tries the gaze path below and, when configured, the OpenAI desk-object fallback. The normal screen-sharing buttons keep their Chrome tab/window/screen behavior.

The on-demand worker uses the vendored **MediaPipe ObjectDetector with EfficientDet-Lite2 FP16 v1**. This model recognizes 80 common COCO categories, including cups, bottles, books and phones; it does not recognize arbitrary objects. See Google's [Object Detector documentation](https://developers.google.com/edge/mediapipe/solutions/vision/object_detector) and the model provenance in `dist/vendor/mediapipe/manifest.json`. Crops are padded rectangles around detected objects, not background-removed cutouts or calibrated evidence of physical contact.

**Hands and objects are inferred from the same frozen image.** The streaming right-hand landmarks only trigger the action; their older left-hand coordinates are never reused for the crop. The worker runs an IMAGE-mode HandLandmarker on the exact same bitmap as ObjectDetector. The selector requires a unique confident Left hand, usable palm geometry, contact/proximity from multiple fingers, plausible object size, and stronger association with that hand than another. It excludes people, hands and large background classes. A second pass on a bounded left-hand region can resolve small objects, with its detections mapped back into the original image. A box cut off by an artificial search-region edge is rejected.

When object selection fails, the separately identified **left-hand-region** fallback keeps the tighter footprint derived from the hand bounds plus 0.6 palm spans on each side, then shifts it upward. Its bottom ends at the trusted **left index base (MCP5)**, rounded inward to the last whole source pixel. If the crop reaches the top of the image, its height shrinks; the bottom never moves down below the index base. Missing, duplicate, low-confidence or off-image index-base data cannot produce a guessed fallback. If no other object qualifies, the message asks you to show that base or move the hand lower. No object identity or object-confidence score is fabricated. The detector retains its broader 1.5-palm search border, and recognized objects retain their complete padded crops. All geometry uses the original unmirrored image; preview mirroring does not swap anatomical Left/Right.

The dominant-object fallback does not need a visible left hand. It requires a confident object (at least 0.65 model score) covering 12–60% of the image, at least 18% on each axis, fully inside a 1% edge margin, and containing the image center. Its center must be within a quarter of the image’s shorter side from the image center. People, body parts, furniture, background and large fixed structures are excluded. Significant competing objects must be less than half its area and half its score-weighted area; different large overlapping classifications remain ambiguous. These are image-prominence checks, not depth or foreground measurements. This prominence path is used only when no usable left-hand region is available; a detected left-hand object or the focused left-hand crop retains priority.

Only one object job runs at a time. Source changes, cancellation and obsolete worker generations discard pending results. Camera pixels are frozen synchronously before model loading; output always comes from that same frame. The board is checked before capture and immediately before saving, so filled slots are never overwritten. Temporary canvases and transferred bitmaps are released, model startup/inference have timeouts, and a failed GPU run retries the same frozen image using CPU computation. The object worker warms once after live hands tracking starts and does no continuous object inference. The model, runtime and hand model are served from this app; camera images and results are not uploaded.

Gesture hands tracking targets **60 fresh frames per second** while a camera is active. The camera's actual frame rate and inference time bound the achieved rate: a 30 fps camera cannot supply 60 different images, and slower computation reduces throughput. One camera frame is processed at a time, with no stale-frame queue. A completed hand result reaches gesture recognition immediately, before any due face/body work finishes, and its later complete packet cannot count as a second hand observation. The next eligible frame does not wait for a display-animation tick. Developer face/body tracking retains its selected rate. Progress feedback updates as soon as recognition changes, independently of the slower gallery/layout refresh. Normal mode tracks hands on the selected **Landmarks & gaze** camera. A live gaze-pin capture source, the eye dialog or an accepted calibration enables face/iris inference on that same camera. Developer mode controls the visible overlays independently. The separate object worker runs on demand.

The pinch detector uses thumb–index distance relative to palm size, with separate close/open thresholds. Initial arming and ordinary transitions require **two distinct observations spanning at least 12 ms**, so two real 60 fps samples can confirm an edge. The ordinary close/open ratios are 0.28 and 0.55 palm spans. Once armed, a strong close at or below 0.21 or release at or above 0.62 can confirm on one fresh frame when both current and previous hand confidence are at least 90%, sampling is recent, and the palm remains stable. Borderline positions keep the two-observation check. Two complete observed close–release cycles are always required; a close or release that occurs entirely between camera samples cannot be reconstructed. The 900 ms cooldown and fresh-open rearming remain in place.

It requires a unique, confident Right hand, fresh timestamps and an initial open hand. Tracking loss, ambiguous handedness, a changed camera/hand, an incomplete sequence longer than three seconds or stale input reset progress. A cooldown prevents duplicate captures; result feedback does not delay a fresh gesture after cooldown. Imported, synthetic and replay frames cannot trigger actions. Sparse thumb/index data without independent palm points is not sufficient; live browser inference supplies the full hand.

## CPD / wide scene camera and multiple fixed live pins

The **eye icon** opens scene-camera settings. Every browser-exposed video input can be chosen independently of the main camera. Automatic mode attempts a distinct input whose observed label suggests CPD, infrared or wide; it does not invent a missing sensor or select a different resolution as if it were a second lens. The main RGB preview remains open. Devices are keyed by exact video-device ID, not a shared label or USB group ID.

Logitech documents **LVNext CPD Camera** as a separate monochrome near-infrared input. Its presence and concurrent readability depend on the OS, drivers, firmware and camera permissions. Browser pixel formats are negotiated by the driver. If two UVC readers compete for a hardware encoder, the optional native bridge can explicitly request suitable formats. Windows native discovery now reads actual DirectShow names and unique DevicePath identities, preserving index order and validating identity before opening; it never applies DirectShow identities to MSMF indexes. See [Logitech's stream API](https://logitech.github.io/hackathons/logiinsight/API) and `bridge/README.md`.

The **1.5-second right index-and-middle hold** starts pinning. Roofcat first uses fresh eye observations from **Landmarks & gaze** to search the independently selected **Gaze pins** feed. Defaults are main RGB for eyes and snapshots, and scene for pins, with main as the automatic fallback when no scene camera is present. The capture pixels and eye observation freeze **at gesture time**. Automatic aim uses a coarse seated estimate without a calibration setup; a valid saved calibration takes precedence. An invalid saved fit does not silently become a seated estimate.

If gaze or its object model cannot provide a usable region, a configured OpenAI fallback analyzes the same frozen scene image for the separate object in front of the laptop keyboard. With a key configured, a 12-second total local-gaze budget prevents model loading or retries from delaying the cloud fallback indefinitely. Without a key, the local models retain their normal loading deadlines, and a failed attempt explains how to enable the fallback. If OpenAI also finds no object, no pin is created. A gesture never opens a crop selector. **Pin region** remains an explicit manual option. Existing pins continue to update from their own fixed crops without repeating gaze or object inference.

### Gaze-guided object boundaries

The default browser gaze model is Google's **MagicTouch v2**, used through MediaPipe's stateful `InteractiveSegmenter` API. It segments the object at a positive point instead of requiring a match to the detector's 80 named categories. See Google's [Interactive Image Segmentation documentation](https://developers.google.com/edge/mediapipe/solutions/vision/interactive_segmenter) and the pinned model revision, license, byte counts and SHA-256 hashes in `dist/vendor/mediapipe/manifest.json` and `NOTICE.md`.

Each attempt uses a pixel-aligned search region covering **75% of the source width and height**, shifted to remain inside the frame. The mapped gaze becomes the model's point within that region. Actual returned masks select the connected region at or close to the gaze. Empty, invalid, tiny or nearly whole-frame masks are rejected. A low-contrast retry can stretch the actual pixel luminance; it does not invent image content. If the selected mask reaches an artificial search boundary, the model checks the **same full frozen image** before accepting a crop, avoiding a clipped object. There are at most three segmentation passes and one existing EfficientDet fallback. The detector fallback ranks real nearby boxes by gaze proximity, containment and model score, with a lower acceptance threshold than the conservative RGB snapshot flow. An explicitly selected GPU model that fails does not silently use another local detector. The separately configured OpenAI fallback may still handle that failed attempt. Neither path converts an absent result into an arbitrary crop.

The browser models are loaded lazily from this app and run in a background worker on this device. GPU initialization or inference failure retries the same pixels on CPU. The 30.5 MB MagicTouch bundle is served as two verified chunks; the complete reconstructed hash is checked before execution. A request has bounded loading/inference deadlines, and cancellation terminates only its worker. Source, role, session and calibration changes invalidate pending results. These local models do not upload camera images; the optional OpenAI fallback is a separate cloud stage. Grayscale inputs are supported as ordinary image pixels, but no measured accuracy on the physical CPD/IR sensor is claimed. Segmentation also cannot correct a wrongly calibrated gaze point.

With the **bug icon on**, **Gaze crop** shows the latest attempt's **Frozen image → Search region → Model output → Final crop**. The actual gaze point, search outline, returned mask or boxes, and selected crop are visible. The `?` reveals model/delegate, elapsed time and source details. Mask probabilities and SAM's predicted mask quality are not object confidence or gaze accuracy. Previews are bounded, memory-only copies; leaving Developer mode, changing cameras or cancelling clears them. The normal call view remains unchanged.

### Optional stronger models on an NVIDIA laptop

Open the **eye icon → Gaze model** to choose the model used to find a gaze pin's object boundary. This changes gaze segmentation only: landmarks, double-pinch recognition, RGB object snapshots and continuous pin playback retain their existing paths. Model changes preserve the camera calibration and cancel obsolete in-flight selections.

| Choice | Runs in | Intended use | Model weights |
| --- | --- | --- | --- |
| Automatic | Browser, or local CUDA after **Check GPU** succeeds | Uses installed Base+, then Large, then Tiny; otherwise the browser model. An actual local failure is reported when falling back. | Depends on the selected engine |
| Browser · MagicTouch v2 | Browser worker | MacBook or no local service | About 30.5 MB |
| SAM 2.1 Tiny | Local CUDA service | Smallest SAM option for comparison | 156 MB |
| SAM 2.1 Base+ | Local CUDA service | Recommended starting point on the RTX 4060 | 323 MB |
| SAM 2.1 Large | Local CUDA service | Largest included option; compare actual crops and latency | 898 MB |

These are official Meta point-prompt segmentation models, using public Apache-2.0 weights. See [Meta's SAM 2 repository](https://github.com/facebookresearch/sam2), the [official Large model card](https://huggingface.co/facebook/sam2.1-hiera-large), and [Transformers 4.57.3 image API](https://huggingface.co/docs/transformers/v4.57.3/model_doc/sam2). Exact repository revisions and SHA-256 hashes are pinned in `bridge/gpu_models.py`. A larger model is an option to evaluate, not a guarantee of better results on your physical infrared camera. None can repair an incorrect gaze calibration.

On the **Windows laptop with the NVIDIA GPU**:

1. Download and extract the complete ZIP linked above. Install 64-bit Python **3.11, 3.12 or 3.13** if necessary, including the Python launcher.
2. Double-click **`aperture-camera-lab/bridge/start-gpu-windows.cmd`**. Leave its window open. It creates `.venv-gpu`, installs the pinned PyTorch CUDA runtime and Transformers, checks actual CUDA availability, then downloads and verifies all three SAM models. The model weights total about **1.38 GB**; Python and CUDA packages need several additional gigabytes. No Hugging Face account, API key, WSL or separate CUDA toolkit installation is required by this workflow; a compatible NVIDIA driver is required.
3. Return to the live Roofcat tab. Click the **eye icon**, then **Check GPU**. Allow Chrome's local-network permission if prompted. The status reports the GPU actually detected by the service and available models.
4. Choose **SAM 2.1 Base+** to start, or **SAM 2.1 Large** to compare. This explicit preference is saved in this browser. Automatic requires a successful GPU check in the current page session; it does not probe localhost on normal startup.
5. Keep the camera roles and gaze calibration appropriate for your setup. Hold the right index and middle fingers up for 1.5 seconds to run gaze pinning. Turn on the bug icon to inspect the intermediate images and actual model used.

The standalone GPU service uses **`127.0.0.1:9041`**, separate from the optional camera bridge on port 9040. It never opens a camera. It receives only frozen images for requested segmentation, keeps them in memory, and returns masks to the same browser. It accepts the exact live-app origin and loopback app origins, with no wildcard CORS. Network requests cannot download models; inference uses verified local safetensors in offline mode. One model and one image job run at a time. Cancellation and HTTP timeouts keep a still-running GPU worker reserved until it finishes. Memory exhaustion unloads the model and reports a recovery action; explicit GPU choices never silently run on CPU. If the browser blocks HTTPS-to-loopback access, use the local app served by the camera bridge; that origin has separate saved captures.

The MacBook browser workflow needs none of this setup. The optional Mac GPU launcher explains that this service requires NVIDIA CUDA and does not attempt to install CUDA on macOS. For manual setup, selective model downloads, service flags and verification, see [bridge/README.md](bridge/README.md).

### Optional OpenAI desk-object fallback

1. Open the **eye icon** and find **Gaze fallback pin model**.
2. Choose **GPT-6.2 Sol** (default), **GPT-6.2 Astra**, or **GPT-5.4**, paste your own OpenAI API key, and press **Use key**. The key is configured immediately and checked by OpenAI on the first fallback request. It is not an app-provided shared key.
3. Ensure the **Gaze pins** camera can see the desk object in front of the keyboard. When a scene camera is connected, Automatic uses it; choose a specific source if needed.
4. Close the eye menu and hold your **right index and middle fingers up for 1.5 seconds**. Keep them above the other fingertips until the ring completes, then lower them.
5. If gaze cannot select a region, OpenAI analyzes **one frozen frame**. The model locates the visible bounds of one desk object immediately in front of the keyboard and explicitly identifies whether it is paper, a notebook, or another object. For paper and notebooks it always attempts to find the four outer corners and the upright direction of text or an illustration. Subsequent live frames apply the same fixed crop and transform locally, with no continuous API calls or tracking. Invalid geometry, refusals, timeouts and absent objects produce a short failure message instead of an invented crop.

For a flat page or notebook, four real visible corners drive a perspective transform into a rectangle. A bounded local edge check refines the model corners only when all four long image edges support a coherent correction. Ambiguous or partly hidden edges retain the validated model geometry. Corners are ordered in the document's reading or illustration direction, correcting perspective and slant together, including a notebook facing exactly **180°** away from the camera. When four corners are unavailable but document content supplies a direction, a fixed angle rotates the bounded document crop instead. These paths are alternatives, so a page is not rotated twice. All output uses actual camera pixels.

Content orientation is a model estimate. Clear text takes precedence; recognizable illustrations can also supply an upright direction. Blank or ambiguous paper can still be straightened geometrically, but the app does not invent a 180° reading flip. Other objects do not receive document content rotation or automatic scan filtering. Existing captures retain their saved geometry; newly created document pins use the improved selection.

Paper and notebook captures start with a local **scan enhancement** that evens broad shadows, brightens paper and deepens ink while retaining pencil shades and colored illustrations. The **wand** toggles only this filter; the corrected crop stays in place. Original pixels are saved losslessly with the preference, so toggling off works on paused pins, snapshots and after reload. The selected preview and keypad use the same displayed frame. Snapshots taken from a document pin inherit its reversible filter. Live updates run the filter locally at the pin's configured rate, bounded by device performance; they do not make more API calls.

The **bug icon → Gaze crop** panel shows the frozen image, model output with the accepted four-corner outline, and corrected scan preview. Its **?** details report the document type, text/illustration orientation, angle, corner method and filter state. Local edge support is a geometry check, not a model-confidence or gaze-accuracy claim.

The optional request uses the [Responses API image-input format](https://developers.openai.com/api/docs/guides/images-vision), [Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs), high image detail and `store: false`. [GPT-6.2 Sol](https://developers.openai.com/api/docs/models/gpt-6.2-sol) supports image input and structured output; [Astra](https://developers.openai.com/api/docs/models/gpt-6.2-astra) is a more capable option. Model access, API billing and rate limits depend on the entered key. There are no automatic paid retries. Frame/key requests go directly to the fixed OpenAI HTTPS endpoint, not through a Roofcat server. `store: false` disables response storage for this request; it is not a promise about every aspect of OpenAI service retention. The key is never saved in localStorage, IndexedDB, URLs, logs, diagnostics or the downloadable code. **Forget key** or reload clears it.

The bug view distinguishes a **Seated estimate**, a **Calibrated** result and an object-only **Scene object** fallback. Model-proposed boundaries have no fabricated object-confidence score. The scene must contain the object; no model can see behind the camera or recover missing footage.

### Calibrating where you look

Logitech's [gaze tracker](https://logitech.github.io/hackathons/logi-gaze-tracker/sample-code/) reports calibrated **display coordinates**, not a ready-made point in another camera image. Browser iris landmarks likewise do not provide a calibrated physical gaze ray. Roofcat offers an approximate **Automatic · seated estimate** by default and an optional session-specific calibration. Upright office posture reduces variation but does not determine personal gaze offsets or the geometric relationship between two cameras. The amber estimate assumes the person faces the camera and the cameras are roughly aligned; it is not a precise gaze ray or an accuracy guarantee.

Open the eye menu. Choose **Landmarks & gaze**, **Object snapshots** and **Gaze pins** independently, leave **Gaze aim → Automatic · seated estimate** for no setup, or choose **Calibrate gaze** for optional refinement. The eye camera must see **your face and both eyes**. The capture camera must see **the physical targets and objects to pin**; it does not need to see your face. With no scene camera, the defaults use the existing main feed for all three roles. Choose the main physical camera from the call camera selector and the scene physical camera in the eye menu. Explicit scene-only role selections remain unavailable when that camera is disconnected instead of silently changing source.

For each of five marked points in the capture preview, look at its corresponding **physical location**, keep your seat and cameras steady, and press **Space**. Each point requires multiple fresh observations; a sixth target independently checks the mapping using aspect-correct image distances. The mapping is a calibrated estimate for that visible scene plane and working position, not a depth-aware gaze measurement. Missing eyes, blinks, poor fit, stale/repeated samples, source changes, movement outside the calibrated position and extrapolation are rejected. SDK and browser providers cannot silently replace one another mid-calibration. Recalibrate after changing a role, moving yourself or either camera. Calibration is kept only in the current session.

Live face/iris landmarks and camera readiness do not establish a calibrated gaze point. The eye dialog distinguishes calibration readiness from a usable mapped estimate, and preserves the specific reason when eye observations are unavailable. After calibration and its independent check succeed, a green gaze marker appears **inside that dialog** when a current estimate is valid. Ordinary camera landmark overlays do not draw this mapped point. Physical gaze accuracy depends on the actual camera, person and viewing setup and has not been established by the automated landmark-routing tests.

All enabled browser landmark tasks, gesture recognition and gaze features use the **Landmarks & gaze** role, defaulting to main RGB. The **Object snapshots** role independently supplies snapshot pixels and object detection, defaulting to main RGB. The **Gaze pins** role supplies gaze-based object-region detection and live pin pixels; its automatic default uses scene while connected and main otherwise. An explicitly selected but unavailable scene never borrows unrelated telemetry. Source/session or role changes cancel pending captures. Changes to the eye or gaze-pin source invalidate the fit; changing only the snapshot role does not change that mapping. Existing Logitech tracker telemetry remains inspectable in Signals, but unbound SDK display coordinates do not override the selected eye camera.

RGB snapshots use the local EfficientDet model, a focused visible-left-hand crop when object detection cannot select a box, or the conservative prominent-object path when no usable left hand exists. An object-model failure can still use the frozen-image hand model; an actual missing hand is never replaced with a guessed image half. Gaze pins use MagicTouch first, with EfficientDet as a fallback. A notebook does not need a **book** label for point-guided segmentation, although successful recognition on IR footage is not guaranteed. No object detection or tracking runs in the live pin loop; each successful pin keeps its rectangular crop fixed independent of subsequent gaze and starts at **10 fps**. Segmentation selects the bounds once; it is not a continuously tracked or background-removed cutout.

Click the **bug icon** to see both live previews together. The scene preview reuses the existing video or MJPEG element, so toggling Developer mode or changing pages does not request another camera reader. Landmarks are drawn only on their originating feed, and the hand graphs use that feed's dimensions and mirror state. Object snapshots and gaze pins use their independently chosen sources, while both camera readers remain shared.

### Shared footage, independent crops

All browser pins from the same auxiliary device share **one physical stream**. Each pin retains its own fixed normalized crop and update rate (0.2–10 fps, default 10 fps). Changing one pin's FPS never changes the shared camera's frame rate. Removing or ending one pin releases only that pin's reference; the remaining pins continue. Native MJPEG regions also crop one existing reader. The first nine occupied captures appear on the keypad in board order with their green/red styles; additional captures remain available in the app.

Main-camera region pins borrow the already-open main reader. They never open or stop a camera themselves and pause when the main source stops or changes. Existing pins retain their explicitly saved update rates; 10 fps is the default for new pins. Capture work does not overlap, and keypad updates remain paced and coalesced, so physical button refresh can be slower than the requested pin rate when several pins are active.

Pins restore as saved, paused previews after a page reload. Resume a scene pin from its gear; browser inputs are matched to their original device ID. For a native pin, first reopen the original scene reader. Its bridge-verified unique device identity and backend must match; a label or old numeric index is never enough. Native inputs without stable identity require a new explicit crop after reconnection. Source dimensions must still match the saved crop. No camera is silently reopened solely because stored captures exist. **End preview** releases both cameras and all live scene pins while keeping their last saved images.

## Connect the MX Creative Keypad

1. Connect the **MX Creative Keypad** to the same computer by USB.
2. Open the app in desktop **Chrome or Edge**, using HTTPS or localhost, and click **Connect keypad**.
3. Select the keypad in the browser’s HID device chooser and approve it. First-time access is required once per site/browser; already authorized compatible devices are detected and reconnected automatically while the app is open.
4. The app sends all nine slot images to the physical keypad, including existing captures. Green keys are pins; red keys are snapshots. Each shows the actual captured content. Pressing a physical key selects that capture in the app; an empty key selects the destination for the next capture.

A browser picker must be opened by an on-screen click. Physical HID events cannot silently authorize a new screen share. Keep the app tab open for live updates. Unplugging, disconnecting, or closing the tab can leave a last image on the keypad; it will refresh when connected again. The on-screen board stays usable without the hardware.

The adapter uses the experimental MIT WebHID implementation linked from Logitech’s hackathon resources. Normal LCD button input arrives on report `0x13`. HID++ `1B04` enables the advertised paging controls (`0x01A1` and `0x01A2`) and any advertised LCD controls, preserving and restoring prior reporting/remap settings on explicit disconnect. Navigation-only `1B04` firmware is supported; it does not have to advertise the nine LCD controls. If optional input setup fails, display uploads and normal key reports remain available; the **?** guide shows the actual input error. Abrupt tab termination or unplugging cannot guarantee a restoration exchange. It selects only the MX Creative Keypad (Logitech `046d:c354`) and uses the upstream contextual-display packet format.

**Mode and Pick-selection changes send the whole keypad in one image.** The nine 118 × 118 key canvases are composed at their physical offsets into one 457 × 440 JPEG and sent through the SDK’s full-display path. Reconnect, saved-board restoration, reorder and Undo use the same path. This removes the old eight 100-ms waits between the first and last keys; it does not claim simultaneous USB transfers or a measured hardware refresh rate. New mode frames replace older pending ones and take priority over queued individual live updates. An image already being transmitted finishes its ordered USB packets before the newest frame starts, so separate VLP image sequences cannot interleave. Activity records the accepted frame’s byte count, packet count and transport duration.

Individual live pin updates send only their changed 118 × 118 key area. All updates share one paced transport queue. Pending live images are bounded to one per key, newer frames replace older pending frames, and keys take fair turns after priority board updates. Nine fast pins therefore cannot each refresh their physical display at 10 fps. Actual transfer and display timing depends on the browser, USB connection and firmware.

Version 1.5.2 sends ordered packets for one complete image and waits for the device’s matching **final-image acknowledgement**, as well as completion of every USB write. Intermediate replies are recorded when present; they are not required. Captured replies from the attached keypad use response parts `0xC1`…`0xC7` rather than the reference’s expected final part `0x47` for a seven-packet image. The matcher accepts that observed response form and the documented form, correlates the final sequence, and requires status `0x0001`. Fragment status `0x0000` does not count as completed-image acceptance. The device can report acceptance, busy, or a protocol error. Busy responses use bounded retries; stale pending frames are replaced by the newest requested board. Missing or invalid responses stop the failing transport instead of silently claiming success. Encoded images are limited to 61,335 bytes (15 packets), a conservative application bound that avoids a packet-sequence disagreement between upstream implementations. This is not a claimed official device maximum.

## Keypad modes

Developer mode exposes the keypad modes and keeps instructions, connection details and diagnostics behind **?**, with capture name/FPS controls inside **Settings**. Normal view shows the occupied capture previews and their pin/camera icons.

| Control | Action | Visible feedback |
| --- | --- | --- |
| Physical or on-screen **>** | Advance **Pick → Remove → Reorder → Pick** | Current mode name and matching frame/keys |
| Physical or on-screen **<** | Move backward through the same three modes, wrapping | Current mode name and matching frame/keys |
| LCD key in **Pick** | Select its capture or an empty destination | Blue selection outline on screen and physical keypad |
| LCD key in **Remove** | Remove the capture on that key | Warm frame, orange borders and × badges; Undo becomes available |
| Two LCD keys in **Reorder** | Choose a filled key, then swap with another capture or move to an empty destination | Blue frame; first selected key turns cyan and says PICK NEXT |
| **Pick** or **Escape** | Return directly to Pick | Green pin / red snapshot artwork and blue selection |
| **Undo** | Reverse the most recent removal or reorder | Restored capture/positions |

Changing mode clears an unfinished reorder pair without moving captures. Arrow releases do nothing; a held button advances only once until released.

Reordering keeps each live pin’s existing screen source and refresh timer. Slot updates are committed together in one IndexedDB transaction. Removal releases its live source and keeps the last image for Undo; restoring a removed pin restores a paused preview and requires choosing its source again. A new capture replaces the previous Undo action. Mode overlays and the normal selection outline are sent to the physical LCD keys as well as the on-screen keypad, and leave the capture image visible. Changing selection clears the old highlight and draws the new one in one full-display image. Key-number captions are omitted from the button images; empty buttons show a centered plus and filled buttons retain their capture title and status.

**Connection help:** WebHID is unavailable in Safari and Firefox. If no keypad is listed, check the USB cable, open the app in Chrome/Edge, then reconnect. If another app owns the interface or overwrites the images, close Logi Options+ or that app and reconnect; exclusivity is not assumed when it works normally. USB and device-response errors are shown with the actual reason. “Confirmed” means the keypad acknowledged the complete image; the protocol provides no visible-pixel readback or presentation timestamp.

### Display recovery and stress testing

Open **? → MX Creative Keypad** for the following controls:

- **Check display** reads the device’s brightness and accepted-frame count through the same serialized transport used for image updates.
- **Refresh display** repaints the complete current board. If brightness is exactly zero, this explicit recovery restores a midpoint within the device’s reported range and verifies it; existing nonzero brightness is preserved. The refresh icon beside Keypad runs the same recovery. Captures remain saved.
- **Stress test** requests 1,200 rapid mode changes and Pick selections, then restores Pick and the original selection. It never invokes Remove/Reorder actions or edits captures. External key actions pause while it runs. **Stop test** or Escape cancels new requests and restores the final board. A pass requires a device-confirmed final frame and an increased accepted-frame count, with no observed transport error. Results and failures appear here and in Activity.

Brightness zero, device queue refusal, missing responses and USB disconnects are distinct diagnostic outcomes. A successful stress run exercises the attached device but does not establish that unrelated software can never overwrite the display.

## Start with a MacBook or USB camera

1. Open the hosted app in a current browser and click the camera icon.
2. Allow camera access. To choose another input or inspect formats, enable **Developer mode**, then select a device under **Devices** on Call or **Sources** on the Camera tab. Refresh Sources after connecting another camera.
3. Choose a **Requested format** and click **Apply**. Enable **Exact mode** to reject an unsupported resolution or frame rate instead of accepting a negotiated alternative.
4. Use **Device controls** to inspect the settings and image controls that your browser actually exposes.
5. **Controls → Camera extras** can inspect photo capabilities and take a native still where ImageCapture is supported. Native stills retain their actual decoded dimensions and omit preview mirroring/overlays. A separate, explicit **Enable pan / tilt / zoom** action requests browser access to any supported PTZ controls.
6. Use **Stop** to release the preview and microphone. Source switching also releases the previous visual source.

Ordinary MacBook video works without the bridge, kit credentials or a Logitech application. A built-in camera does **not** supply LogiInsight's on-device face results. Roofcat calculates live face, hand and body landmarks directly in the browser from the selected video; these estimates are clearly labeled separately from camera-generated data.

## Browser landmarks

On **Call**, open a camera or local video and enable **Developer mode** to start Face, Hands and Body together. Camera access is off on initial load. Once a live input is open, background hands tracking supports gestures even with the bug icon off. In the advanced Camera workspace, the mesh button starts or stops developer tracking; gesture hands remain active, and **Landmarks → Browser** offers the three signals independently. **Settings** selects the developer face/body limit from 5 to 30 fps; gesture hands independently target 60 fresh frames per second. Video capture retains its own frame rate. Slower computers process fewer frames rather than building a queue, and hand results are delivered before the same frame's optional face/body results.

- Face: 478 normalized 3D landmarks, including iris points, all 52 blendshape scores and the face transformation matrix.
- Hands: 21 landmarks for each detected hand (up to two by default), handedness and model-estimated world coordinates.
- Body: 33 normalized landmarks, visibility/presence and estimated world coordinates, using the lightweight pose model.
- **Data → Export full data** saves the latest full browser result, with every raw model field, input dimensions, capture/source timestamps and source identity. **Telemetry → Raw frame data** displays it. Expression scores are available under Data.
- Camera snapshots and pins include the selected overlay. Video recordings save the source video; landmark JSON exports separately.

These are **Browser inference · MediaPipe** results, calculated locally from the selected image. They are not Logitech's on-device AI, a depth-camera measurement or calibrated screen gaze. IR inference may be attempted on a readable infrared image, but the models are designed for ordinary color imagery. Imported browser JSON retains its provenance and will not be overlaid on an unrelated live source.

The pinned MediaPipe 1.2.3 runtime, WebAssembly and versioned FP16 models are served from this Site; first use downloads only the needed files. Call's Developer mode loads all three models when a visual source is available; advanced controls can request them independently. A dedicated worker keeps inference off the UI thread, permits one ImageBitmap in flight, drops obsolete generations on source changes, releases transferred bitmaps, adaptively paces slow devices, and falls back from GPU to CPU. Loading and inference have bounded timeouts and a retry action. WebAssembly SIMD and worker WebGL are required; CPU mode changes model computation but still uses WebGL for the SDK image transport. Unsupported graphics are detected before downloading models. The worker allows same-origin GETs only, preventing the upstream SDK's automatic usage logger from sending data externally. No camera pixels or results are sent to a server.

The official runtime and model licenses, upstream URLs and file hashes are in `dist/vendor/mediapipe/`. Verify them with `python3 scripts/vendor-mediapipe.py --check`. Restore absent assets from pinned upstream sources with `--fetch`.

The **Device** tab remains available for Logitech's original SDK output and separate Hands/Gaze Tracker applications. Their native connection is optional. Starting browser tracking clears imported/external telemetry; selecting external data stops browser inference so the output has one clear source. Browser-derived overlays match their current source ID; LogiInsight device overlays require an observed LVNext/LogiInsight RGB source or a paired snapshot.

### Run only the browser app locally

Python 3 is sufficient for the static app; no Python packages or Node build are required:

```bash
python3 -m http.server 8080 --bind 127.0.0.1 --directory dist
```

Open [http://127.0.0.1:8080](http://127.0.0.1:8080). Camera APIs require a secure browser context, such as HTTPS or localhost. Use a local server rather than double-clicking `index.html`, because the app uses JavaScript modules.

## Local footage, capture and playback

- **Open footage** accepts local video files. Playback depends on your browser's codecs; a recognized extension does not guarantee decoding.
- **Stream explorer → Open a stream URL** accepts browser-playable video, MJPEG/images and PNG polling endpoints. Cross-origin sources must allow browser access. Arbitrary RTSP feeds need a separate conversion service.
- **Record** saves source video, with the selected microphone if enabled. Landmark overlays and the preview's mirror transform are not baked into the video recording. The browser chooses a supported WebM or MP4 format.
- Video recordings are held in memory and saved when stopped, after 10 minutes, or at approximately 256 MB. Browser support varies for recording imported/remote footage. MJPEG/image sources are not offered as video-recording inputs.
- **Snapshot current feed** adds a red snapshot of the visible frame to the capture board and keypad, including the selected overlay and mirror settings when the source permits canvas access. **Pin current feed** creates a green live pin at the selected board rate. Download the resulting PNG from the board; export landmark JSON separately in the inspector.
- The example signal is explicitly marked **synthetic**. It demonstrates the interface and never represents a connected camera or live detection.

## Discover every exposed stream

Open **Camera → Discover**. The compact source list keeps every browser video device, then checks the optional native bridge. It requests exact device IDs, waits for decoded frames, and retains failed attempts with their real error and retry action. Active main and secondary readers are reused during discovery; only temporary probe tracks are released. Sources and the secondary selector share one browser inventory, including refreshed inputs and distinct devices with matching names.

The official LogiInsight guide describes the following LVNext interfaces:

| Interface | Documented footage | App behavior |
| --- | --- | --- |
| `LVNext Camera` | RGB sensor | Show and open the observed input. |
| `LVNext CPD Camera` | Separate near-infrared sensor; monochrome portrait frames | Show the actual input when exposed; otherwise retain an expected **Not exposed** row with Retry and Native actions. |
| `LVNext Hello Camera` | Restricted Windows Hello interface | Keep it visible and permit an explicit attempt if enumerated; report the actual result. |

Expected interfaces are shown separately from discovered hardware. The docs do not identify another separate wide RGB feed. Changing the requested dimensions does not switch physical sensors. IR/Hello-sized presets therefore appear as advanced dimension requests, and actual negotiated settings remain inspectable under **?**. Browser crop-and-scale is discouraged with `resizeMode: none` when supported; this does not establish a lens field of view or override hardware zoom.

On macOS, **native discovery** can read AVFoundation camera names, stable unique IDs, permission state and all advertised sizes, pixel subtypes and FPS ranges. Linux exposes its video nodes; unsupported inventory backends retain explicit numeric probes. Advertised modes are distinct from confirmed capture. A named macOS device's unique ID is checked again before opening its index; a known identity/index mismatch after hotplug is rejected and asks for fresh discovery. Native probes honor the selected backend/settings, and report requested settings, whether the driver accepted each setting, actual frame dimensions, driver-reported FPS/FOURCC, and mismatches. Sensor labels come from observed device identity, never requested size or grayscale processing.

**RGB + IR** keeps the observed Logitech RGB reader open and places the actual infrared stream in the second preview on Camera view. Browser IR and native MJPEG IR can use this secondary view. Ordinary **Open** selects the main preview. Native/unidentified tracker images do not inherit LogiInsight RGB face overlays; identified native IR and Hello are excluded. A paired SDK snapshot retains its timestamp-matched overlay path.

The native bridge must run on the camera's computer. If it is unreachable, the app exposes the local kit and retry route; it does not claim that hidden streams opened. The kit's `bridge/start-macos.command` creates an isolated environment, installs dependencies and starts the bridge with the hosted app's exact origin allowed. Return to the existing app tab and choose **Camera → Discover**. It does not open a duplicate tab by default, and does not request or store camera credentials. Native video discovery requires no kit credentials; on-device AI does.

RGB and IR can run together. Logitech recommends RGB NV12/YUY2 with IR MJPG; RGB MJPG shares an encoder with IR and can make IR much slower. The browser chooses codecs, while native controls can request them and report what the OS delivered. Discovery avoids a long warm-up that could falsely reject a working slow IR feed. Driver, browser and OS restrictions remain visible; no hidden device ID or synthetic footage is substituted.

## Run the full local bridge

The optional bridge requires **Python 3.10+** and runs on the computer with the cameras attached. The downloadable kit restores the optional object model on first setup and verifies its pinned SHA-256; the hosted app already serves this model directly. The macOS launcher performs this preparation automatically. Once the model is restored, local inference needs no model download. Keep `bridge/` and `dist/` beside one another, then run from this project directory:

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -r bridge/requirements.txt
python scripts/vendor-mediapipe.py --fetch
python bridge/bridge.py
```

Open [http://127.0.0.1:9040](http://127.0.0.1:9040). This serves the same app and makes bridge requests local to its origin. On Windows, create the environment with `py -m venv .venv` and activate `.venv\Scripts\activate` instead. Linux audio may require the PortAudio system library; see the [bridge guide](bridge/README.md).

On macOS, allow the terminal running Python under **System Settings → Privacy & Security → Camera** for native video, **Microphone** for native audio, and **Local Network** for the kit connection. The browser has its own permissions. A permission prompt may outlast a probe; grant access, then retry. Ctrl+C stops the bridge.

Native controls expose camera indexes, backend/codec selection, one-frame PNG and MJPEG capture, IR processing, AI settings, diagnostics, paired snapshots, and native multichannel WAV capture. Firmware inspection additionally needs the optional official SDK; other bridge features use the documented protocols directly. Complete endpoint and parameter tables are in [bridge/README.md](bridge/README.md).

### Connect LogiInsight face data

1. Attach the camera using USB 3. Its RGB/IR video and microphones use ordinary USB interfaces; AI data uses a separate USB network adapter.
2. Set that adapter to **192.168.1.20**, subnet mask **255.255.255.0**, leaving router and DNS empty. The documented camera address is **192.168.1.10**.
3. In the bridge terminal, set `LOGIWEBCAM_USER` and `LOGIWEBCAM_PASSWORD` using the kit-card values. Keep them out of source files and browser fields.
4. Before starting the bridge, establish trust in the physical camera's SSH host key with `sftp USER_FROM_KIT_CARD@192.168.1.10`. Verify and accept its key, then enter `bye`. The bridge checks `~/.ssh/known_hosts`; unknown or changed keys are reported. See the bridge guide for an alternate known-hosts file.
5. Start the bridge from that same terminal, open the local app and keep the camera's **RGB stream running**.
6. In **Device controls → Native SDK access**, inspect the bridge, choose **Read AI settings**, enable **Face detection** and **478-point face mesh**, then **Apply AI settings**. The camera's default mesh setting is **off**.
7. In the landmark inspector, select **LogiInsight SDK bridge** and connect to `ws://127.0.0.1:9040/ws`.

For macOS's default zsh, these prompts keep the entered values out of shell history:

```zsh
read -r "LOGIWEBCAM_USER?Kit username: "
read -rs "LOGIWEBCAM_PASSWORD?Kit password: "
export LOGIWEBCAM_USER LOGIWEBCAM_PASSWORD
sftp "$LOGIWEBCAM_USER"@192.168.1.10
# Enter bye after checking and accepting the camera host key.
python bridge/bridge.py
```

AI configuration writes take time to apply; inspect fresh output rather than treating a write response as confirmation of inference. Face mesh depends on detection and may be absent in some frames. AI timestamps belong to the camera's wrapping clock, not host UTC time. The app reports stale telemetry instead of leaving an old live face overlay indefinitely.

The live video and AI JSON arrive through different paths and can lag each other. **Capture paired snapshot** fetches a timestamp-matched image/JSON pair and restores the prior YUV-output setting. Continuous YUV mode consumes the camera's small storage; disable it after use. Logitech also documents heat-related freezes during long continuous AI runs; use short experiments and stop unused streams.

### Use the hosted page with the local bridge

Start the bridge with the exact allowed origin:

```bash
python bridge/bridge.py --allow-origin https://aperture-camera-lab.batikanor.chatgpt.site
```

The bridge remains bound to loopback and checks Host and Origin headers. Allow a browser local-network prompt if shown. If HTTPS-to-local HTTP/WebSocket access is blocked, open the app at `http://127.0.0.1:9040`. The native controls accept an editable loopback bridge URL. Changing it does not reconfigure already connected telemetry sockets.

## Landmark files and live trackers

**JSON input** accepts an individual frame, supported frame arrays, JSONL/NDJSON, raw Logitech API v2 data, SDK capture wrappers under `device_ai_data`, and supported MediaPipe landmark result shapes. Set the source width/height to the resolution the coordinates describe. Importing data validates it; it does not send landmarks back into the camera or modify its inference model.

| Input | Coordinates and behavior |
| --- | --- |
| LogiInsight faces | `bbox: [x,y,width,height]` and `landmarks: [[x,y,z],…]` use absolute RGB-frame pixels, top-left origin. Mesh points are not relative to the face box. An enabled mesh has 478 points when available; empty arrays are valid. |
| SDK capture wrapper | `device_ai_data` contains the original result; `image_resolution` provides its dimensions. Paired snapshots also identify a synchronized image. |
| MediaPipe results | Normalized landmark input is scaled using the supplied source dimensions. No inference is performed by importing the result. |
| Hands Tracker | Published thumb, index and midpoint coordinates are normalized and already mirrored; y increases upward. The app uses a separate tracker panel because its crop can differ from the full camera frame. It does not invent a complete 21-point skeleton. |
| Gaze Tracker | Gaze uses display coordinates in CSS/logical pixels, not camera pixels. The app displays it in a separate screen-coordinate panel. |

For a multi-frame import, use the frame slider or **Play landmarks**. **Sync to video** aligns relative recording time to local footage playback; it does not establish hardware synchronization between unrelated recordings. Import the matching landmark recording after selecting its video source. A source change clears existing overlays.

The Logitech tracker applications run separately on your Mac or Windows PC:

- **Hands:** select Logitech Hands Tracker and connect to `ws://127.0.0.1:8765`; no subscription message is required. **Try hand footage** requests `http://127.0.0.1:8765/api/frame` at a modest polling rate.
- **Gaze:** start and calibrate Logitech Gaze Tracker, then connect to `ws://127.0.0.1:8964`. Roofcat sends the documented `start_stream` request. An absent prediction appears as `gaze: null`.
- **Custom WebSocket:** enter a reachable endpoint that emits one of the supported JSON schemas. Connection status, invalid input and unavailable telemetry are surfaced in the interface/activity log.

## Practical limits and troubleshooting

- **Busy camera:** stop the browser/native preview or another app using that sensor, then retry. Native probing opens one index at a time and releases it afterward.
- **Second camera:** in Stream explorer, use **A second perspective** to open a different browser camera while the main RGB preview stays active. Stop releases both.
- **RGB plus IR:** try native RGB NV12/YUY2 first, then IR MJPG. RGB MJPG shares an encoder with IR and can substantially reduce IR FPS. AVFoundation/macOS may ignore FOURCC requests.
- **AI missing:** check credentials, known-host trust, the USB adapter address, local-network permission, and whether RGB remains open. A Wi-Fi network on the same subnet can route camera traffic incorrectly. Use the official connection checker linked below.
- **Audio channels:** browser settings may differ from the requested stereo 48 kHz. Native capture preserves requested supported PCM channels; in a six-channel LogiInsight listing, microphones occupy channels 1 and 4.
- **Unavailable controls:** the browser lists only capabilities returned by the active track. Native firmware requires the optional SDK. Unsupported formats, permissions and endpoints are reported rather than presented as successful captures.

## Development and verification

The frontend is buildless HTML/CSS/ES modules with no runtime package dependencies. Serve `dist/` to develop it. Python packages are confined to the optional bridge environment.

| Path | Purpose |
| --- | --- |
| `dist/index.html`, `dist/styles.css` | Application layout and styles |
| `dist/app.js` | Camera/file lifecycle, previews, recording and telemetry connections |
| `dist/call-workspace.js`, `dist/call-workspace.css` | Normal Call view, compact occupied captures and Developer mode presentation |
| `dist/pinch-gesture.js`, `dist/pin-gesture.js`, `dist/gesture-input.js`, `dist/capture-gesture-feedback.js` | Separate double-pinch snapshot and 1.5-second two-finger pin gestures, accepted-gesture feedback, live source selection and stale-data protection |
| `dist/object-capture.js`, `dist/held-object.js`, `dist/object-detector.js`, `dist/object-detector-worker.js` | Same-image hand/object detection, conservative left-hand selection and automatic cropped snapshots |
| `dist/camera-feed-pool.js`, `dist/scene-pins.js` | Shared auxiliary camera ownership, fixed-region pin lifecycle and gesture-time fallback |
| `dist/scene-gaze.js`, `dist/scene-region.js` | Strict observed-eye provenance, approximate seated aim, optional calibration and fixed scene crops |
| `dist/openai-scene.js` | Optional memory-only BYOK vision fallback, bounded Responses API requests, validated object boundaries and reading orientation |
| `dist/perspective-crop.js` | Fixed perspective rectification and reading rotation of actual live camera pixels without another camera reader |
| `dist/gaze-region.js`, `dist/gaze-segmenter.js`, `dist/gaze-segmenter-worker.js`, `dist/vision-worker-utils.js` | Generous gaze search regions, point-guided masks, local MagicTouch worker and shared SDK loading policy |
| `dist/gaze-debug-ui.js`, `dist/gaze-debug-ui.css` | Memory-only intermediate gaze crop previews in Developer mode |
| `dist/scene-pin-ui.js`, `dist/scene-pin-ui.css` | Compact eye menu, scene preview and validated calibration |
| `dist/call-microphone.js` | Microphone ownership, mute, input switching, cancellation and meter |
| `dist/hand-metrics.js`, `dist/hand-graphs.js`, `dist/hand-graphs.css` | Source-aware fingertip coordinates and bounded Right pinch history |
| `dist/capture-board.js`, `dist/capture-board.css` | Unbounded capture order, first-nine keypad projection, live scheduling and board UX |
| `dist/screen-capture.js`, `dist/screen-capture.css` | Native screen picker, frozen region selector and stream ownership |
| `dist/capture-store.js` | Local IndexedDB persistence and colored keypad image composition |
| `dist/keypad-hid.js`, `dist/vendor/mx-creative-console/` | Exact MX Keypad connection, image transport, button reports and MIT attribution |
| `dist/media-utils.js` | Media constraints, cancellation, frame readiness and error handling |
| `dist/landmarks.js` | Input normalization, validation, timeline and rendering |
| `dist/secondary-preview.js` | Optional second camera while the main RGB stream stays active |
| `dist/native-controls.js` | Explicit native bridge actions and settings |
| `bridge/bridge.py`, `bridge/requirements.txt` | Loopback Python bridge and dependencies |
| `bridge/README.md` | Complete native protocol/setup guide |
| `tests/`, `bridge/test_bridge.py` | JavaScript and no-hardware Python checks |

```bash
npm test
python -m unittest discover -s bridge -p 'test_*.py' -v
python -m py_compile bridge/bridge.py
```

At the original camera/bridge build verification, **24 JavaScript checks and 16 Python checks passed**. They cover landmark protocols, coordinate conversions, media lifecycle/error behavior, origin checks, parameter/config validation, and HTTP behavior. Native-control wiring also received a mocked DOM/HTTP smoke check. Browser QA verified synthetic preview/recording/download, real video-file playback, malformed JSON rejection, Logitech capture-wrapper overlays, sample-to-hand telemetry cleanup, and unavailable-camera/bridge error recovery. These checks do not establish real device compatibility: no physical MacBook, LogiInsight RGB/IR/Hello, microphone or on-camera inference was available in the build environment.

**The 1.4.1 release passed 139 JavaScript checks.** The capture/keypad update adds tests for capture coordinates and ownership, late grants, snapshot freezing, local persistence, field validation, real HID packet construction, exact device selection, press/release edges, bounded/fair queues, image encoding, cancellation, reconnects and transfer timeouts. Browser QA used a real tab-sharing picker with no cameras attached: cropped pin, custom 2.5-fps setting, pause/resume, snapshot-from-pin, independent screen snapshot, reload restoration, PNG export/import, synthetic camera/landmark pin, source-stop handling, and the real HID chooser/cancel flow. The cloud build browser has no physical keypad. The user’s connected browser separately detected the MX Keypad and completed image uploads over USB; that earlier version did not inspect device image acknowledgements.

Version 1.4 adds full-display geometry and packet reconstruction tests, one rate-limit interval per whole-board frame, latest-mode supersession during encoding and pacing, board priority over stale individual frames, later live-frame preservation, no packet interleaving, JPEG size guards, and disconnect/timeout cleanup.

**Version 1.5 passed 172 JavaScript checks**, including the 1,200-event mixed HID burst and the safe live-test runner. It adds cyclic mode navigation, correlated final-image acknowledgements, device-busy handling, conservative encoded-size bounds, brightness diagnostics/recovery, and a safe live stress runner. Tests cover rapid transitions, bounded queues, early/late/missing/error responses, cancellation and final selection restoration.

The 1.5.2 hardware check used the connected MX Keypad in the user’s Chrome session: **1,200 requests over 32.5 seconds produced 202 device-confirmed frames**, including 201 during load, with no busy retries or transport errors. The capture slots and original Pick selection were preserved. Brightness read 70% before and after; explicit refresh retained it. Both mode directions wrapped correctly. A second run stopped cleanly after 318 changes / 54 confirmed frames. These results establish image acceptance and state restoration on that device; they are not optical pixel readback or proof of the original blackout’s cause.

**Version 1.6 passed 193 JavaScript tests and 24 Python tests.** It adds complete camera inventory and paired RGB/IR previews. Its focused tests cover duplicate browser IDs, expected Logitech interfaces, observed identity, requested versus negotiated settings, cancellation, active-reader preservation, native identity changes, and native snapshots versus live streams. Physical native IR capture still requires the bridge running on the camera’s computer; an inventory entry alone is not evidence of received frames.

The downloadable local kit contains application source, bridge, tests, guides and the vendored MIT license. QA screen captures, local browser state, user-uploaded PDFs and footage are not bundled.

**Version 1.8 passed 294 JavaScript tests.** New checks cover microphone mute and switching, cancellation and late permission grants, unplugging and metering; fingertip topology and supplied handedness; source-specific metadata and confidence; aspect-correct pinch measurements, optional world estimates and stale/missing/ambiguous data; and bounded graph history and draw scheduling. The existing 1,200-event keypad burst tests remain passing. Browser preview checks cover default Call navigation, shared capture selection/presentation, mode cycling, returning to Camera/Board and the compact help/graph layout.

**Version 1.8.1 passed 298 JavaScript tests.** Actual Chrome testing found that the pinned Hand Landmarker runtime emits unused visibility fields as zero. A narrowly identified MediaPipe hand-result placeholder is now excluded from derived visibility confidence, preserving raw exports, meaningful custom/pose visibility, presence, and the supplied handedness confidence. Regression fixtures reproduce the observed 553-point face/two-hand/body result, all ten fingertip labels and both pinch units. A live MX Keypad run during Call tracking completed **1,200 changes in 32.3 seconds with 193 device-confirmed frames** and no reported transport error; saved captures and selection were preserved. The camera/keypad checks use the connected Mac browser. Live microphone access remains dependent on its browser/OS permission; the connection timed out before a stream was returned during this verification, so live microphone capture was not claimed as tested.

**Version 1.8.2 passed 300 JavaScript tests.** The fingertip plot now fills its available area with independent X/Y scales and adaptive tick density. Portrait inputs no longer compress the graph into a narrow strip. Pointer selection, source-coordinate readings and mirroring are covered; pinch distances still use the source image geometry. The Call camera stage leaves room for the graph readings on laptop displays.

**Version 1.10.1 passed 363 JavaScript tests and 24 Python bridge tests.** Gesture regression coverage includes rapid two-pinch sequences at 15 and 30 sampled frames per second, brief high-confidence transitions, borderline jitter, held pinches, source changes, stale/duplicate frames and cooldown. Runtime tests cover fresh hands on each sample, independent face/body cadence, bounded visual-result age, and rate changes without reopening the camera. The gesture pipeline uses the current host clock for incoming-frame freshness and updates progress independently of the layout refresh. These are automated checks; a 30 fps target is not a guarantee of camera or model throughput.

## Primary documentation

- [Logitech hackathon resources](https://logitech.github.io/hackathons/)
- [LogiInsight setup and connection troubleshooting](https://logitech.github.io/hackathons/logiinsight/)
- [LogiInsight SDK API, coordinates and hardware limits](https://logitech.github.io/hackathons/logiinsight/API)
- [Hands Tracker protocol and installation](https://logitech.github.io/hackathons/logi-hands-tracker/)
- [Gaze Tracker protocol and samples](https://logitech.github.io/hackathons/logi-gaze-tracker/sample-code/)
- [Browser camera access requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia)
- [MediaPipe Hand Landmarker output and coordinate definitions](https://developers.google.com/edge/mediapipe/solutions/vision/hand_landmarker)
- [Chrome local-network access behavior](https://developer.chrome.com/docs/modern-web-guidance/guides/security/local-network-access)

- [MX Creative Console WebHID library](https://github.com/mario-gutierrez/mx-creative-console-webhid)
- [Original MX Creative Console response-gated driver](https://github.com/Julusian/node-logitech-mx-creative-console/tree/82e66c7f5571dd2fd569733867fd29ae9823c94d)
- [OpenLogi accepted-ACK implementation](https://github.com/AprilNEA/OpenLogi/pull/1873)
- [MX Keypad Script Lab](https://github.com/mario-gutierrez/mx-cc-script)
- [Browser screen capture and permission requirements](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getDisplayMedia)
- [Chrome WebHID documentation](https://developer.chrome.com/docs/capabilities/hid)
- [Apple screen recording permissions](https://support.apple.com/guide/mac-help/mchld6aa7d23/mac)

**Version 1.11.0 passed 422 JavaScript tests.** The new object-capture checks cover same-image hand/object inference, raw unmirrored pixels, conservative left-hand association, empty/ambiguous detections, focused-region coordinate mapping, truncated-box rejection, repeated triggers, source cancellation, board capacity, and model/bitmap lifecycle failures. The vendored asset hashes and both workers’ privacy policies also pass verification. The cloud Chrome environment reports WebGL unavailable and correctly refuses model capture; this is an environment limitation, not evidence of real-model execution.


**Version 1.12.0 passed 509 JavaScript tests and 31 Python bridge tests.** Scene-pin coverage includes one exact-device stream shared by multiple leases, independent crop/FPS updates, aborts and late camera grants, unplugging, primary/secondary ownership, safe reconnect hints, and paused-pin resumption. Gaze tests reject stale or imported frames, off-session sources, missing/closed eyes, unstable calibration, changed geometry and extrapolated gaze; the scene picker is the fallback when a reliable mapped region is unavailable. The calibration UI was checked with synthetic signals, including an independent sixth-point validation. The full app was exercised in cloud Chrome with two explicitly synthetic RGB/CPD camera streams: three scene crops used one CPD acquisition, RGB kept advancing, one pin changed to 5 fps while another stayed at 1 fps, deletion preserved the reader, reload resumed the original scene camera without Chrome's sharing picker, and End released both streams. All 68 JavaScript files pass syntax checks; the privacy audit and all ten pinned vendor-asset hashes pass. These checks do not constitute a physical Windows CPD test or validation of desk-gaze accuracy; the latter requires calibration on the actual camera, desk and user.

**Version 1.12.1 passed 543 JavaScript tests and 35 Python bridge tests.** Tracking now uses the active scene camera for every enabled task and falls back to main only when no live scene input owns tracking. New integration tests exercise source-bound overlays, original graph coordinates, main-camera gaze fallback, scene gestures with independent RGB object capture, stale and empty detections, cancellation, and stopping main while scene inference continues. Camera lifecycle tests cover scene-first startup, a distinct default main input, late grants, reconnect generations and independent pin leases. Bridge 1.2.0 reports exact reader identity and actual frame progress; matching browser checks reject ended, replaced or stalled native streams while keeping older bridges usable with explicitly unverified progress. A full-app browser check used clearly labeled synthetic landscape RGB and portrait CPD feeds: opening scene first selected distinct main RGB, Developer off/on and Camera/Call navigation kept one acquisition per camera with advancing playback clocks, turning scene off selected main tracking, and End released both inputs. The cloud browser cannot run the WebGL-dependent vision models; routing and iris extraction are additionally covered by automated integration tests. Physical CPD image quality and gaze calibration still require the actual hardware and viewing setup.

**Version 1.12.2 passed 565 JavaScript tests.** New pins and screen-capture requests default to 10 fps, while explicit saved rates remain unchanged. Main-only gaze settings now borrow the live main feed for calibration and region capture; lifetime tests confirm that independent pin leases never acquire, reconfigure or stop that reader. The eye menu separates camera readiness, valid eye observations, missing calibration and a currently mapped estimate, retaining the real failure reason. Tests cover main face demand while the dialog or an accepted calibration needs it. In the full-app synthetic browser check, the main-only eye menu exposed calibration and the real WebGL availability error; a cropped main-camera pin saved at 10 fps with exactly one main acquisition and zero scene acquisitions, an older pin remained at 1 fps, and stopping main paused the new pin and released its sole track. These checks do not establish physical gaze accuracy; calibration math and sampling thresholds are unchanged.

**Version 1.12.3 passed 601 JavaScript tests.** Camera roles are independently selectable: main RGB for landmarks/gaze, main RGB for object snapshots, and scene-first automatic capture for gaze pins. Snapshot selection preserves left-hand priority and adds a conservative prominent-object fallback using the original full-frame detections. Automatic gaze pins require a real unique object box near the calibrated gaze, with at most one focused retry and no manual-picker or fixed-size fallback. Tests cover cross-camera mapping, role/session invalidation, object-only calibration preservation, cancellation and exact frame/lease release. Calibration-dialog lifecycle tests change only the eye camera between targets and close during sampling; its independent check now uses aspect-correct distances. Full-app browser QA with explicitly synthetic RGB and portrait CPD feeds verified all three role controls, default routing, scene-off main fallback, role switches without extra camera acquisitions, two advancing previews, 10 fps new-pin defaults and complete track shutdown. The cloud browser cannot perform the WebGL-dependent vision inference; model detections and calibrated gaze selection are tested with explicit fixtures, not claimed as physical-camera accuracy. The actual viewing setup still needs user calibration.


**Version 1.13.0 passed 659 JavaScript tests.** Gaze pinning now uses a generous 75% search region and the local MagicTouch v2 point-guided model, with useful low-contrast retries, full-frame rescue at artificial crop boundaries, and ranked EfficientDet fallback. Tests cover foreground component selection, malformed and oversized masks, 4K source geometry, exact original-image mapping, model integrity failures, GPU-to-CPU recovery, timeouts, cancellation at each stage, late callbacks, camera/calibration invalidation and bounded debug preview ownership. The production app modules pass syntax checks, the SDK privacy audit passes, and all 12 vendored assets verify against their pinned hashes. Fresh restoration of the two model chunks from the pinned upstream source also passed.

The actual shipped browser worker ran MagicTouch on a public Google cat-and-dog image in color, grayscale and low contrast. The production gaze-pin pipeline, with explicitly supplied test gaze/calibration and real model outputs, selected the dog in grayscale after a full-frame boundary rescue and selected the cat in low contrast from the initial ROI. The four production Developer previews and the original-pixel final crop were inspected visually. The remote browser used CPU fallback: one pass took about 9–10 seconds and the two-pass rescue about 19 seconds; these are observations on the test browser, not laptop performance guarantees. The model runs only when selecting a pin, while the resulting fixed crop updates independently at its chosen rate. These photo tests do not establish physical IR performance or gaze accuracy; the actual user/camera setup still requires calibration.


**Version 1.14.0 passed 698 JavaScript tests and 52 Python tests.** Captures now extend beyond the nine hardware keys, with direct trash icons and Undo, a compact first-nine hardware projection, overflow selection/reordering, and stable per-capture persistence. Lifecycle tests cover twelve saved and restored captures, deletion/promotion, cross-boundary swaps, per-pin lease release, and delayed-write cancellation. Actual browser checks imported twelve total captures, verified direct deletion and Undo, moved an overflow image onto key nine, and restored the changed order after a reload. Existing keypad burst tests remain passing; no physical keypad was attached to this build browser.

Optional SAM 2.1 Tiny, Base+ and Large use the isolated local CUDA service. Tests cover exact protocol/model/revision matching, image/mask bounds, loopback origin checks, corrupt installation receipts, timeout and cancellation ownership, memory-failure cleanup, explicit-model failure semantics, and separate predicted mask-quality reporting. The actual pinned Tiny model ran offline on CPU with the production processor/model/postprocessing and mask/RLE helpers, including a grayscale input. This verifies runtime compatibility and actual mask handling; it does not establish RTX 4060 latency, Windows driver behavior or physical infrared/gaze accuracy. Those require the testing laptop and its camera. All 43 top-level app modules parsed, the MediaPipe privacy audit passed, and all 12 vendored assets matched their hashes.

**Version 1.15.0 passed 805 JavaScript tests and 52 Python tests.** Double pinches now exclusively take snapshots; a visible, confident Left hand supplies a padded snapshot region when object selection fails. A separate three-second Right index-and-middle hold starts a pin and remains latched until an observed release. Tests cover full-hand pose geometry, advancing sample clocks, stale or missing hands, busy/canceled actions, feedback persistence, source changes, and independent gesture routing. Automatic seated gaze retains explicit approximate provenance; valid calibration remains authoritative.

The optional OpenAI scene fallback has mocked request/response coverage for memory-only keys, image bounds, fixed-endpoint requests, schema validation, refusals, incomplete responses, timeouts, response-size limits, cancellation, late results and invalid crop/quad geometry. A bounded local gaze attempt can fall through to the same frozen frame without allowing obsolete results to save a pin. Perspective pins retain one existing camera lease, use fixed original-image corners, and preserve their transform through save, crop, reload, resume and delete. The bug view renders the actual straightened frozen crop. All 46 top-level app modules parsed, the MediaPipe privacy audit passed, and all 12 vendored assets matched their pinned hashes.

Cloud Chrome checks verified the eye-menu key entry and clearing on reload. An isolated, explicitly synthetic browser fixture exercised the production snapshot, perspective and hold-detector modules: generous Left-hand fallback, upright corner orientation, changing pixels in two fixed pins sharing one source, one pin continuing after the other stops, a first trigger after three seconds, no repeat through seven additional held seconds, and a second trigger after release and another full hold. The browser used the Canvas2D perspective fallback. These checks do not establish physical handedness accuracy, desk-gaze accuracy, camera/GPU throughput, or a successful live OpenAI request. No real API key or paid API call was used in this release verification.


**Version 1.15.1 passed 814 JavaScript tests.** The two-finger pin gesture now requires two seconds: fresh observations at 1999 ms remain pending, and the first eligible observation at 2000 ms triggers once. Release-to-rearm, source/host clock agreement, tracking-loss resets and busy/cancellation latches remain covered. Current help and activity text use the new timing; the separate double-pinch sequence timeout remains unchanged.

The unrecognized Left-hand snapshot fallback now adds 0.6 palm spans per side instead of reusing the 1.5-palm detector search region. It retains the observed hand and nearby content while leaving object-search coverage independent. Final local segmentation and detector pin crops share a 2% border per side; OpenAI boxes use the same percentage with a two-source-pixel minimum. Perspective corners expand by a 1.02 radial scale instead of 1.04. The OpenAI prompt requests one object's tight visible edges immediately in front of the keyboard, without model-added margin or adjacent desk context. Automatic object-box paths reject the laptop, keyboard and display as targets.

Regression checks cover complete object containment, small objects across image sizes, edge clipping, unchanged broad search coverage, original-image geometry, preserved large notebooks, planar-corner bounds and existing cloud fallback/cancellation behavior. All eight changed application modules pass syntax checks. These are geometry, request-contract and gesture tests, not a new physical-camera or paid OpenAI inference measurement. The tighter defaults apply to new captures; saved captures retain their chosen regions.

**Version 1.15.2 changes:** The snapshot fallback keeps the 0.6-palm footprint but moves it above the Left hand, with its bottom at the observed index base (MCP5). Inward pixel rounding and top clipping keep the saved crop above that boundary. Missing or uncertain index-base data produces a useful failure message. Recognized-object crops and the broad detector search remain independent. Two lit pinch dots now acknowledge an accepted second release; each accepted attempt receives a saved, canceled or failure result.

Gesture hands target 60 fresh frames per second, bounded by source and compute throughput. Fresh hand results reach recognition before optional face/body work completes, and the later complete packet cannot become another hand observation. Ordinary edges require two observations over 12 ms; guarded high-confidence single-frame edges accept more natural fast close/release distances while retaining open-hand arming, two observed cycles and the 900 ms cooldown.

The OpenAI scene fallback requests text-upright output, using page corners in reading order or a fixed arbitrary-angle rotation, including 180°. Blank, ambiguous or unreadable text retains an explicit Unknown orientation. The same saved geometry is applied to continuing live camera frames; this adds no continuous model requests. Developer details expose the proposed orientation and final transformed preview. Existing saved captures retain their geometry.

**Version 1.15.2 passed 861 JavaScript tests.** Integration coverage includes per-observation gesture routing, duplicate early/final packets, accepted-only dot acknowledgement, terminal feedback for busy/cancelled/rejected captures, cancellation across repeated camera lifecycle events, above-index-base source-pixel crops, and upright transforms through scene selection, storage, Crop, reload, exact-camera resume, and Developer previews. All changed application modules parse; the MediaPipe privacy audit passes.

Cloud Chrome checks used explicitly generated images and simulated model replies to exercise the real parser and Canvas2D renderer. A 180° page, a 193.5° tilted upside-down page, a 13.5° page, and box-only rotation fallbacks all displayed upright text with preserved corner order; the fixed corrected pin continued to receive new source pixels. The production HUD renderer showed one filled dot plus an outline while the second pinch was held, then two filled dots alongside progress and saved/no-object/cancelled results. Real generated video streams, both visible and positioned offscreen like the scene camera, advanced through the production scheduler with one frame in flight, no duplicate source timestamps, newest-frame pickup after simulated slow inference, and rejected late results after stopping. Tracks, observers and timers were released. These checks do not establish physical camera/keypad throughput or live model accuracy; no real API key or paid OpenAI call was used. GPU-preferred rendering used the available Canvas2D fallback in this browser.


**Version 1.15.3 passed 862 JavaScript tests.** The Call capture gallery keeps one column for any capture count and scrolls independently within a bounded panel. The former count-based dense layout is removed. Browser verification with 12 saved test captures confirmed one column, access to the last capture, fresh painting of newly visible previews, and a stationary main camera area while the gallery scrolls.

The Right index-and-middle pin hold now requires 1.5 seconds. A shared duration drives the detector, progress ring, accessible range and countdown. Boundary tests keep 1499 ms pending and trigger once at the first eligible 1500 ms observation, preserving the observed-release requirement before another pin. Current help and activity text match the new duration. The double-pinch snapshot gesture is unchanged.


**Version 1.15.4 passed 908 JavaScript tests.** Document scanning: OpenAI explicitly classifies paper/notebooks before automatic upright correction and scan enhancement. Its four visible outer corners determine perspective and reading/illustration order; a bounded local edge check refines the crop only with support from all four image edges. Blank pages retain unknown content direction, and other objects receive no automatic document content rotation or filter. Actual source pixels continue through the fixed transform without more model calls.

The reversible scan filter smooths broad illumination changes, deepens ink and brightens paper while preserving pencil shades and colored illustrations. The icon-only wand works in the Call gallery, developer keypad preview and overflow captures. Raw document pixels are saved losslessly with the preference. Tests cover live updates, paused/restored pins, snapshots, crops, exact-source resume, reorder, delete/Undo, filter errors and rapid preference changes. Twenty-one quick wand changes share one in-flight image encoding and persist the final preference.

Cloud Chrome verification used generated skewed pages and simulated structured model replies. Text and illustrations appeared upright after a 180° input turn; all four supported corners refined, blank paper stayed semantically unknown, and non-documents skipped enhancement. The real Call gallery displayed the wand only on document captures, restored original colors without changing crop geometry, and retained its off preference after reload. Browser visual review also found and fixed faint diagonal seams in the Canvas2D perspective fallback by correcting triangle-edge overlap. No real camera, physical keypad, private API key or paid OpenAI inference was used in these checks.
