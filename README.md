# L-Gesture

A local camera studio for taking snapshots and pinning them over the live video feed.

## Getting started

Requires Node.js 22 or later. Run `npm start` and open [localhost:3000](http://localhost:3000). Allow camera access when prompted. Click **Take photo** or **Random photo**, then click **Pin photo**.

Click **Select area** and drag a rectangle over the camera feed. Click **Take photo** to capture that rectangle. **Reset area** restores the centered square. When selecting an area with the keyboard, use the arrow keys to move it, Shift+arrow keys to resize it, and Enter to confirm. The camera feed stays live while you review a snapshot. Drag pinned photos with a mouse or on a touchscreen to move or overlap them. Drag the lower-right corner handle to resize a photo while keeping its proportions.

With a photo focused, press the arrow keys to move it or Delete to remove it. With its resize handle focused, use the arrow keys to resize it. Hold Shift for larger steps.

Share the app window or browser tab during a meeting. The live video stays in the browser, and the server saves a snapshot only when you pin it. Pins are stored in `.data/board.json`. Set `DATA_DIR` to use a different data directory or `PORT` to change the server port.

## Keyboard and keypad

With the app tab focused, assign these shortcuts through [Logi Options+](https://www.logitech.com/en-us/shop/p/buy-mx-creative-console.920-012660) or send them from another programmable keypad.

| Shortcut | Action |
| --- | --- |
| Shift+N / Shift+B | Select the next / previous photo, including photos covered by others |
| Arrow keys | Move the selected photo |
| Shift+arrow keys | Move in larger steps |
| + / − | Enlarge / shrink the selected photo |
| Delete | Remove the selected photo |
| Shift+V | Toggle the camera |
| Shift+A | Enter or cancel capture area selection |
| Shift+C / Shift+R | Capture a photo / choose a random photo |
| Shift+P / Escape | Pin / discard the draft |

When the resize handle has keyboard focus, the arrow keys resize the photo. Use Shift+N or Shift+B to return focus to a photo and use the arrows for movement.

## Input adapters

A same-page adapter can import `dispatchAction` and `getInteractionState` from `/app.js`. The state includes the selected photo ID, preview bounds, and each photo's ID, position, and bounds. Bounds use viewport CSS pixels. Coordinates passed to `photo.selectAt` use the same units and select the topmost visible photo at that point.

```js
import { dispatchAction, getInteractionState } from '/app.js';

const { preview } = getInteractionState();
const selected = dispatchAction('photo.selectAt', { x: preview.x + 80, y: preview.y + 80 });
if (selected) dispatchAction('photo.move', { dx: 24, dy: -12 });
```

Use `photo.select` with an `id` to target a specific photo, or `photo.next` and `photo.previous` to cycle selection. `photo.move` accepts signed `dx` and `dy` in CSS pixels, and `photo.resize` accepts a signed `delta` in CSS pixels. Both target the current selection by default and accept an explicit `id`. `photo.remove` follows the same targeting rule. Use `crop.set` with normalized `x`, `y`, `width`, and `height` relative to the visible camera feed, or `crop.reset` to restore the default square. Read the current rectangle from `getInteractionState().captureArea`. Camera and draft actions are `camera.toggle`, `draft.capture`, `draft.random`, `draft.pin`, and `draft.discard`. Commands return a boolean or a promise of a boolean for asynchronous operations. For movement and resizing, `true` means the change was accepted locally and queued for persistence.

## API

| Method | Path | Behavior |
| --- | --- | --- |
| GET | `/api/samples` | Lists the sample photos. Each entry has an `id`, `title`, and `image`. |
| GET | `/api/pins` | Lists pinned photos. |
| POST | `/api/pins` | Accepts a `sampleId` or an `image` as a JPEG data URL, plus optional `x`, `y`, `size`, and `title` fields. Returns the new pin with status 201. |
| PATCH | `/api/pins/{id}` | Updates any supplied `x`, `y`, or `size` fields and returns the updated pin. |
| DELETE | `/api/pins/{id}` | Removes the pin and returns status 204. |

Coordinates from 0 to 1 describe where the entire pin fits inside the preview. The `size` field is the photo width as a fraction of the preview's shorter side. It must be greater than 0 and at most 1. Error responses contain an `error` field.

The browser module at `/camera.js` exports `openCamera`, `captureSnapshot`, and `closeCamera`.

## Sample photos

- [Camera](https://images.unsplash.com/photo-1516035069371-29a1b244cc32)
- [Notes](https://images.unsplash.com/photo-1531346878377-a5be20888e57)
- [Plant](https://images.unsplash.com/photo-1485955900006-10f4d324d411)
