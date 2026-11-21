const pressDistance = 0.05;
const releaseDistance = 0.08;

function readHand(hand) {
  const point = hand?.index_thumb_midpoint;
  const distance = hand?.index_thumb_distance;
  if (!['Left', 'Right'].includes(hand?.handedness) ||
      ![point?.x, point?.y].every(value => Number.isFinite(value) && value >= 0 && value <= 1) ||
      !Number.isFinite(distance) || distance < 0) return null;
  return { label: hand.handedness, x: point.x, y: 1 - point.y, distance };
}

export function bindGestures({ button, cursor, layer, blocked, grab }) {
  let socket;
  let staleTimer;
  let label;
  let pressed = false;
  let drag;

  function reset() {
    clearTimeout(staleTimer);
    drag?.finish();
    drag = undefined;
    label = undefined;
    pressed = false;
    cursor.hidden = true;
  }

  function receive(event) {
    let frame;
    try {
      frame = JSON.parse(event.data);
    } catch {
      return;
    }
    if (frame?.type !== 'hand_telemetry' || !Array.isArray(frame.hands) || frame.hands.length > 2) return;
    clearTimeout(staleTimer);
    staleTimer = setTimeout(reset, 500);
    const hands = frame.hands.map(readHand).filter(Boolean);
    const unique = hands.filter(hand => hands.filter(other => other.label === hand.label).length === 1);
    const hand = label ? unique.find(hand => hand.label === label) : unique[0];
    if (!hand || blocked()) {
      reset();
      return;
    }

    const bounds = layer.getBoundingClientRect();
    const x = bounds.left + hand.x * bounds.width;
    const y = bounds.top + hand.y * bounds.height;
    cursor.style.left = hand.x * 100 + '%';
    cursor.style.top = hand.y * 100 + '%';
    cursor.hidden = false;

    if (!label) {
      label = hand.label;
      // Wait for an open hand before grabbing after a tracking interruption.
      pressed = hand.distance <= releaseDistance;
    } else if (pressed && hand.distance > releaseDistance) {
      drag?.finish();
      drag = undefined;
      pressed = false;
    } else if (!pressed && hand.distance < pressDistance) {
      pressed = true;
      drag = grab(x, y);
    } else {
      drag?.move(x, y);
    }
    cursor.classList.toggle('grabbing', Boolean(drag));
  }

  button.addEventListener('click', () => {
    if (socket) {
      socket.close();
      return;
    }
    const connection = new WebSocket('ws://127.0.0.1:9000');
    socket = connection;
    button.textContent = 'Connecting…';
    connection.addEventListener('open', () => {
      button.textContent = 'Turn off gestures';
      button.setAttribute('aria-pressed', 'true');
    });
    connection.addEventListener('message', receive);
    connection.addEventListener('close', () => {
      const connected = button.getAttribute('aria-pressed') === 'true';
      socket = undefined;
      reset();
      button.textContent = connected ? 'Turn on gestures' : 'Retry gestures';
      button.setAttribute('aria-pressed', 'false');
    });
  });
}
