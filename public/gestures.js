import { trackCamera } from './hand-tracking.js';

const pressDistance = 0.05;
const releaseDistance = 0.08;

function readHand(hand) {
  const point = hand?.index_thumb_midpoint;
  const distance = hand?.index_thumb_distance;
  if (!['Left', 'Right'].includes(hand?.handedness) ||
      ![point?.x, point?.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      !Number.isFinite(distance) || distance < 0) return null;
  return { label: hand.handedness, x: 1 - point.x, y: 1 - point.y, distance };
}

export function bindGestures({ button, status, cursor, layer, video, source, blocked, grab }) {
  let socket;
  let controller;
  let staleTimer;
  let label;
  let pressed = false;
  let drag;

  function showStatus(message) {
    if (status.textContent !== message) status.textContent = message;
  }

  function reset(message) {
    clearTimeout(staleTimer);
    drag?.finish();
    drag = undefined;
    label = undefined;
    pressed = false;
    cursor.hidden = true;
    showStatus(message);
  }

  function receive(event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame?.type !== 'hand_telemetry' || !Array.isArray(frame.hands) || frame.hands.length > 2) return;
    const hands = frame.hands.map(readHand).filter(Boolean);
    handleHands(hands, pressDistance, releaseDistance);
  }

  function handleHands(hands, press, release) {
    const unique = hands.filter(hand => hands.filter(other => other.label === hand.label).length === 1);
    const hand = label ? unique.find(hand => hand.label === label) : unique[0];
    if (blocked()) {
      reset('Gestures paused during crop selection.');
      return;
    }
    if (!hand) {
      if (!label) showStatus('Show an open hand to the tracker camera.');
      return;
    }
    clearTimeout(staleTimer);
    staleTimer = setTimeout(() => reset('Show an open hand to the tracker camera.'), 500);

    const bounds = layer.getBoundingClientRect();
    const x = bounds.left + hand.x * bounds.width;
    const y = bounds.top + hand.y * bounds.height;
    cursor.style.left = hand.x * 100 + '%';
    cursor.style.top = hand.y * 100 + '%';
    cursor.hidden = false;

    if (!label) {
      label = hand.label;
      // Wait for an open hand before grabbing after a tracking interruption.
      pressed = hand.distance <= release;
    } else if (pressed && hand.distance > release) {
      drag?.finish();
      drag = undefined;
      pressed = false;
    } else if (!pressed && hand.distance < press) {
      pressed = true;
      drag = grab(x, y);
    } else {
      drag?.move(x, y);
    }
    cursor.classList.toggle('grabbing', Boolean(drag));
    showStatus(drag ? 'Photo grabbed. Open your fingers to drop it.'
      : pressed ? 'Open your fingers before pinching again.'
      : 'Pinch over a photo or select a photo first.');
  }

  function stop(message = '') {
    controller?.abort();
    controller = undefined;
    socket?.close();
    socket = undefined;
    reset(message);
    delete status.dataset.metrics;
    status.hidden = !message;
    button.textContent = message ? 'Retry gestures' : 'Turn on gestures';
    button.setAttribute('aria-pressed', 'false');
  }

  function ready() {
    button.textContent = 'Turn off gestures';
    button.setAttribute('aria-pressed', 'true');
    showStatus('Show an open hand to the tracker camera.');
  }

  button.addEventListener('click', async () => {
    if (socket || controller) {
      stop();
      return;
    }
    status.hidden = false;
    button.textContent = 'Cancel gesture startup';
    if (source.value === 'camera') {
      if (!video.srcObject) {
        stop('Turn on the studio camera to use camera gestures.');
        return;
      }
      controller = new AbortController();
      const { signal } = controller;
      showStatus('Loading camera gestures…');
      const fail = () => stop('Camera tracking failed. Retry or choose Logitech Hand Tracker.');
      try {
        await trackCamera({
          video, layer, signal,
          onHands: hands => handleHands(hands, 0.28, 0.42),
          onMetrics: metrics => { status.dataset.metrics = JSON.stringify(metrics); },
          onError: fail,
        });
        if (!signal.aborted) ready();
      } catch {
        if (!signal.aborted) fail();
      }
      return;
    }

    showStatus('Connecting to Hand Tracker…');
    const connection = new WebSocket('ws://127.0.0.1:9000');
    socket = connection;
    connection.addEventListener('open', () => {
      if (socket === connection) ready();
    });
    connection.addEventListener('message', event => {
      if (socket === connection) receive(event);
    });
    connection.addEventListener('close', () => {
      if (socket === connection) stop('Hand Tracker disconnected. Start it and retry gestures.');
    });
  });

  source.addEventListener('change', () => stop());
  window.addEventListener('pagehide', () => stop());
}
