import { openCamera, closeCamera, captureSnapshot } from './camera.js';
import { bindGestures } from './gestures.js';
import { bindKeyboard } from './keyboard.js';
import { createCropPicker } from './crop.js';

const icons = {
  scan: '<path d="M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m8 0h3a2 2 0 0 0 2-2v-3"/><circle cx="12" cy="12" r="3"/>',
  video: '<rect x="3" y="6" width="12" height="12" rx="2"/><path d="m15 10 6-3v10l-6-3"/>',
  pin: '<path d="m16 3 5 5-3 1-3 4v3l-2 2-7-7 2-2h3l4-3zm-6 12-6 6"/>',
  close: '<path d="m6 6 12 12M18 6 6 18"/>',
  shuffle: '<path d="M3 6h3c4 0 6 12 10 12h5m-3-3 3 3-3 3M3 18h3c1.4 0 2.6-1.5 4-4m4-4c1-2 2-4 4-4h3m-3-3 3 3-3 3"/>',
};
function icon(name) {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + icons[name] + '</svg>';
}

const byId = id => document.getElementById(id);
const video = byId('video');
const viewfinder = byId('viewfinder');
const picker = byId('crop-picker');
const crop = createCropPicker(viewfinder, byId('guide'), picker);
const selectArea = byId('select-area');
const resetArea = byId('reset-area');
const draftImage = byId('draft-image');
const toggle = byId('camera-toggle');
const cameraDevice = byId('camera-device');
const capture = byId('capture');
const discard = byId('discard');
const pinButton = byId('pin');
const random = byId('random');
const layer = byId('pin-layer');
const notice = byId('notice');

for (const element of document.querySelectorAll('[data-icon]')) element.innerHTML = icon(element.dataset.icon);

let draft;
let camera = false;
let connecting = false;
let saving = false;
let boardReady = false;
let samples = [];
let noticeTimer;
let selectedId;
const cards = new Map();

async function api(path, method = 'GET', body) {
  const response = await fetch('/api/' + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return;
  const result = await response.json();
  if (!response.ok) throw new Error(result.error);
  return result;
}

function announce(message, error = false) {
  clearTimeout(noticeTimer);
  notice.textContent = message;
  notice.classList.toggle('error', error);
  notice.hidden = false;
  if (!error) noticeTimer = setTimeout(() => { notice.hidden = true; }, 2600);
}
function showError(error) {
  announce(error.message === 'Failed to fetch' ? 'Could not reach the local server. Try again.' : error.message, true);
}

function updateSource() {
  if (!camera && crop.editing) crop.cancel();
  video.hidden = !camera;
  byId('draft').hidden = !draft;
  if (draft) draftImage.src = draft.image;
  else draftImage.removeAttribute('src');
  byId('camera-empty').hidden = camera;
  byId('camera-empty').lastElementChild.textContent = connecting ? 'Starting camera…' : 'Camera is off';
  viewfinder.classList.toggle('live', camera);
  toggle.textContent = connecting ? 'Starting…' : camera ? 'Turn off camera' : 'Turn on camera';
  toggle.setAttribute('aria-pressed', String(camera));
  toggle.disabled = connecting;
  cameraDevice.disabled = connecting;
  capture.disabled = !camera || saving;
  selectArea.disabled = !camera || saving;
  selectArea.setAttribute('aria-pressed', String(crop.editing));
  selectArea.textContent = crop.editing ? 'Cancel selection' : 'Select area';
  resetArea.hidden = !camera || !crop.custom;
  discard.disabled = saving;
  pinButton.disabled = !draft || saving || !boardReady;
  random.disabled = !samples.length || saving;
}

picker.addEventListener('cropchange', () => {
  updateSource();
  (crop.custom ? capture : selectArea).focus({ preventScroll: true });
});

function selectSample(sample) {
  draft = { sampleId: sample.id, image: sample.image };
  updateSource();
  if (!pinButton.disabled) pinButton.focus();
}

async function toggleCamera() {
  if (!camera) {
    return startCamera();
  }
  closeCamera(video);
  camera = false;
  updateSource();
  return true;
}

async function refreshCameraDevices() {
  const devices = await navigator.mediaDevices?.enumerateDevices?.().catch(() => []);
  if (!devices) return;
  const selected = cameraDevice.value;
  const cameras = devices.filter(device => device.kind === 'videoinput' && device.deviceId);
  const activeId = video.srcObject?.getVideoTracks()[0]?.getSettings().deviceId;
  const options = cameras.map((device, index) => new Option(
    device.label || 'Camera ' + (index + 1), device.deviceId,
  ));
  cameraDevice.replaceChildren(new Option('Default camera', ''), ...options);
  const preferred = selected || activeId;
  if (cameras.some(device => device.deviceId === preferred)) cameraDevice.value = preferred;
}

cameraDevice.addEventListener('change', () => {
  if (camera) {
    closeCamera(video);
    camera = false;
    startCamera();
  }
});
navigator.mediaDevices?.addEventListener('devicechange', refreshCameraDevices);

async function startCamera() {
  connecting = true;
  updateSource();
  try {
    await openCamera(video, () => {
      closeCamera(video);
      camera = false;
      updateSource();
      announce('The camera disconnected.', true);
    }, cameraDevice.value);
    camera = true;
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    connecting = false;
    updateSource();
    refreshCameraDevices();
  }
}

function takePhoto() {
  try {
    if (crop.editing && !crop.confirm()) return false;
    draft = { image: captureSnapshot(video, crop.area) };
    updateSource();
    if (!pinButton.disabled) pinButton.focus();
    return true;
  } catch (error) {
    showError(error);
    return false;
  }
}
function discardPhoto() {
  draft = undefined;
  updateSource();
  (camera ? capture : toggle).focus();
  return true;
}
function randomPhoto() {
  const alternatives = samples.filter(sample => sample.id !== draft?.sampleId);
  const options = alternatives.length ? alternatives : samples;
  selectSample(options[Math.floor(Math.random() * options.length)]);
  return true;
}
window.addEventListener('pagehide', () => {
  closeCamera(video);
  camera = false;
  updateSource();
});

const clamp = value => Math.max(0, Math.min(1, value));
const stageSize = () => Math.min(layer.clientWidth, layer.clientHeight);

function photoRatio(card) {
  const image = card.querySelector('img');
  return image.naturalWidth / image.naturalHeight || 1;
}

function photoWidthLimit(card) {
  return Math.min(stageSize(), 2 + Math.max(0, layer.clientHeight - 2) * photoRatio(card));
}

function availableSpace(card) {
  return {
    width: Math.max(0, layer.clientWidth - card.offsetWidth),
    height: Math.max(0, layer.clientHeight - card.offsetHeight),
  };
}
function place(card, { x, y, size }) {
  const limit = photoWidthLimit(card);
  card.style.setProperty('--photo-width-limit', limit + 'px');
  card.style.width = size === undefined ? '' : Math.min(limit, Math.max(56, size * stageSize())) + 'px';
  const space = availableSpace(card);
  card.style.left = x * space.width + 'px';
  card.style.top = y * space.height + 'px';
}
function selectPhoto(id) {
  const entry = cards.get(id);
  if (id !== undefined && !entry) return false;
  cards.get(selectedId)?.card.classList.remove('active');
  selectedId = id;
  entry?.card.classList.add('active');
  byId('selection-status').textContent = entry ? 'Selected: ' + entry.title : '';
  return true;
}

function selectAdjacent(direction) {
  const ids = [...cards.keys()];
  if (!ids.length) return false;
  const index = ids.indexOf(selectedId);
  const next = index < 0 ? (direction < 0 ? ids.length - 1 : 0) : (index + direction + ids.length) % ids.length;
  cards.get(ids[next]).move.focus({ preventScroll: true });
  return selectPhoto(ids[next]);
}

function movedPosition(origin, { width, height }, dx, dy) {
  return {
    ...origin,
    x: width ? clamp(origin.x + dx / width) : origin.x,
    y: height ? clamp(origin.y + dy / height) : origin.y,
  };
}

export function getInteractionState() {
  return {
    selectedId,
    captureArea: crop.area,
    preview: layer.getBoundingClientRect().toJSON(),
    photos: Array.from(cards, ([id, { card, title, position }]) => ({
      id, title, ...position, bounds: card.getBoundingClientRect().toJSON(),
    })),
  };
}

export function dispatchAction(action, options = {}) {
  const entry = cards.get(options.id ?? selectedId);
  switch (action) {
    case 'crop.set': {
      if (!crop.set(options)) return false;
      updateSource();
      return true;
    }
    case 'photo.select':
      return selectPhoto(options.id);
    case 'photo.selectAt': {
      if (![options.x, options.y].every(Number.isFinite)) return false;
      const card = document.elementFromPoint(options.x, options.y)?.closest('.card');
      return card?.parentElement === layer ? selectPhoto(card.dataset.pinId) : false;
    }
    case 'photo.next':
      return selectAdjacent(1);
    case 'photo.previous':
      return selectAdjacent(-1);
    case 'photo.move':
      return entry?.moveBy(options.dx, options.dy) ?? false;
    case 'photo.resize':
      return entry?.resizeBy(options.delta) ?? false;
    case 'photo.remove':
      return entry?.remove() ?? false;
    default: {
      const source = sourceActions.get(action);
      return source?.enabled() ? source.run() : false;
    }
  }
}

function addCard(pin, focus = false) {
  const card = document.createElement('article');
  card.className = 'card';
  card.dataset.pinId = pin.id;
  const move = document.createElement('button');
  move.className = 'move';
  move.type = 'button';
  move.setAttribute('aria-label', pin.title + '. Use the arrow keys to move. Press Delete to remove.');
  const image = new Image();
  image.src = pin.image;
  image.alt = '';
  image.draggable = false;
  move.append(image);
  const remove = document.createElement('button');
  remove.className = 'remove';
  remove.type = 'button';
  remove.setAttribute('aria-label', 'Remove photo: ' + pin.title);
  remove.title = 'Remove photo';
  remove.innerHTML = icon('close');
  const resize = document.createElement('button');
  resize.className = 'resize';
  resize.type = 'button';
  resize.setAttribute('aria-label', 'Resize photo: ' + pin.title + '. Use the arrow keys.');
  resize.title = 'Drag to resize';
  card.append(move, remove, resize);
  const entry = {
    card, move, title: pin.title, moveBy, resizeBy, gestureDrag, remove: deletePin,
    position: { x: pin.x, y: pin.y, size: pin.size },
  };
  cards.set(pin.id, entry);
  layer.append(card);
  image.addEventListener('load', () => {
    card.style.setProperty('--photo-ratio', photoRatio(card));
    place(card, entry.position);
  });
  place(card, entry.position);

  let deleting = false;
  let drag;
  let persisted = entry.position;
  let desired = persisted;
  let writes = Promise.resolve();
  function showPosition(position) {
    entry.position = position;
    place(card, position);
  }
  function persist(position) {
    desired = position;
    showPosition(position);
    writes = writes.then(async () => {
      if (position !== desired ||
          (position.x === persisted.x && position.y === persisted.y && position.size === persisted.size)) return;
      try {
        const updated = await api('pins/' + pin.id, 'PATCH', position);
        persisted = { x: updated.x, y: updated.y, size: updated.size };
      } catch (error) {
        if (desired === position) {
          desired = persisted;
          if (!drag) showPosition(persisted);
        }
        showError(error);
      }
    });
  }
  async function deletePin() {
    if (deleting || drag) return;
    deleting = true;
    try {
      await writes;
      await api('pins/' + pin.id, 'DELETE');
      const hadFocus = card.contains(document.activeElement);
      card.remove();
      cards.delete(pin.id);
      if (selectedId === pin.id) selectPhoto(undefined);
      if (hadFocus) (layer.querySelector('.move') || (pinButton.disabled ? toggle : pinButton)).focus();
      announce('Photo removed.');
      return true;
    } catch (error) {
      showError(error);
    } finally {
      deleting = false;
    }
    return false;
  }

  card.addEventListener('focusin', () => dispatchAction('photo.select', { id: pin.id }));
  function startDrag(event) {
    if (event.button !== 0 || deleting || drag) return;
    event.preventDefault();
    const handle = event.currentTarget;
    handle.focus({ preventScroll: true });
    drag = {
      id: event.pointerId, x: event.clientX, y: event.clientY, handle,
      origin: entry.position, ...availableSpace(card),
      cardWidth: card.offsetWidth,
    };
    handle.setPointerCapture(event.pointerId);
    card.classList.add('dragging');
  }
  function resizedPosition(origin, width, space, delta) {
    const limit = photoWidthLimit(card);
    if (!delta || !limit) return origin;
    const nextWidth = Math.min(limit, Math.max(Math.min(56, limit), width + delta));
    if (nextWidth === width) return origin;
    const remainingX = layer.clientWidth - nextWidth;
    const nextHeight = 2 + (nextWidth - 2) / photoRatio(card);
    const remainingY = Math.max(0, layer.clientHeight - nextHeight);
    return {
      x: remainingX ? clamp(origin.x * space.width / remainingX) : origin.x,
      y: remainingY ? clamp(origin.y * space.height / remainingY) : origin.y,
      size: nextWidth / stageSize(),
    };
  }
  function positionAt(event) {
    const dx = event.clientX - drag.x;
    const dy = event.clientY - drag.y;
    if (drag.handle === resize) {
      const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy;
      return resizedPosition(drag.origin, drag.cardWidth, drag, delta);
    }
    return movedPosition(drag.origin, drag, dx, dy);
  }
  function finishDrag(event) {
    if (drag?.id !== event.pointerId) return;
    const position = event.type === 'pointerup' ? positionAt(event) : entry.position;
    drag = undefined;
    card.classList.remove('dragging');
    if (event.type === 'pointercancel') showPosition(desired);
    else persist(position);
  }
  for (const handle of [move, resize]) {
    handle.addEventListener('pointerdown', startDrag);
    handle.addEventListener('pointermove', event => {
      if (drag?.id === event.pointerId) showPosition(positionAt(event));
    });
    for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) handle.addEventListener(type, finishDrag);
  }
  function gestureDrag(x, y) {
    if (deleting || drag) return;
    const id = Symbol();
    drag = { id, x, y, origin: entry.position, ...availableSpace(card) };
    card.classList.add('dragging');
    return {
      move(clientX, clientY) {
        if (drag?.id !== id) return;
        const position = positionAt({ clientX, clientY });
        entry.position = position;
        card.style.left = position.x * drag.width + 'px';
        card.style.top = position.y * drag.height + 'px';
      },
      finish() {
        finishDrag({ pointerId: id });
      },
    };
  }
  function moveBy(dx, dy) {
    if (deleting || drag || ![dx, dy].every(Number.isFinite)) return false;
    persist(movedPosition(entry.position, availableSpace(card), dx, dy));
    return true;
  }
  function resizeBy(delta) {
    if (deleting || drag || !Number.isFinite(delta)) return false;
    persist(resizedPosition(entry.position, card.offsetWidth, availableSpace(card), delta));
    return true;
  }
  remove.addEventListener('click', () => dispatchAction('photo.remove', { id: pin.id }));
  if (focus) move.focus({ preventScroll: true });
}

function nextPosition() {
  const coordinates = [0.04, 0.5, 0.96].flatMap(y => [0.04, 0.5, 0.96].map(x => ({ x, y })));
  const distance = ({ x, y }) => Math.min(...Array.from(cards.values(), ({ position }) => Math.hypot(x - position.x, y - position.y)));
  return coordinates.reduce((best, point) => distance(point) > distance(best) ? point : best);
}

async function pinPhoto() {
  saving = true;
  updateSource();
  try {
    const body = draft.sampleId ? { sampleId: draft.sampleId } : { image: draft.image };
    const pin = await api('pins', 'POST', { ...body, ...nextPosition() });
    draft = undefined;
    addCard(pin, true);
    announce('Photo pinned.');
    return true;
  } catch (error) {
    showError(error);
    return false;
  } finally {
    saving = false;
    updateSource();
  }
}

const sourceActions = new Map([
  ['camera.toggle', { button: toggle, enabled: () => !connecting, run: toggleCamera }],
  ['crop.toggle', { button: selectArea, enabled: () => camera && !saving, run: () => {
    if (crop.editing) crop.cancel();
    else crop.start();
    updateSource();
    return true;
  } }],
  ['crop.reset', { button: resetArea, enabled: () => crop.custom, run: () => {
    crop.reset();
    updateSource();
    selectArea.focus({ preventScroll: true });
    return true;
  } }],
  ['draft.capture', { button: capture, enabled: () => camera && !saving, run: takePhoto }],
  ['draft.random', { button: random, enabled: () => samples.length > 0 && !saving, run: randomPhoto }],
  ['draft.pin', { button: pinButton, enabled: () => draft && !saving && boardReady, run: pinPhoto }],
  ['draft.discard', { button: discard, enabled: () => draft && !saving, run: discardPhoto }],
]);
for (const [action, { button }] of sourceActions) {
  button.addEventListener('click', () => dispatchAction(action));
}
bindKeyboard(dispatchAction);
bindGestures({
  button: byId('gesture-toggle'),
  status: byId('gesture-status'),
  source: byId('gesture-source'),
  video,
  cursor: byId('hand-cursor'),
  layer,
  blocked: () => crop.editing,
  grab(x, y) {
    dispatchAction('photo.selectAt', { x, y });
    return cards.get(selectedId)?.gestureDrag(x, y);
  },
});

new ResizeObserver(() => {
  for (const { card, position } of cards.values()) place(card, position);
}).observe(layer);

updateSource();
startCamera();
api('pins').then(pins => {
  for (const pin of pins) addCard(pin);
  boardReady = true;
  updateSource();
}).catch(showError);
api('samples').then(result => {
  samples = result;
  updateSource();
}).catch(showError);
