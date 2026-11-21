const clamp = (value, max = 1) => Math.max(0, Math.min(max, value));
const minSide = 20;

export function createCropPicker(viewfinder, guide, picker) {
  let area;
  let pending;
  let drag;

  function defaultArea() {
    const { width, height } = viewfinder.getBoundingClientRect();
    const side = Math.min(width * 0.75, height * 0.6);
    const w = side / width;
    const h = side / height;
    return { x: (1 - w) / 2, y: (1 - h) / 2, width: w, height: h };
  }

  function render() {
    const frame = pending ?? area;
    viewfinder.classList.toggle('crop-editing', !!pending);
    viewfinder.classList.toggle('crop-selected', !!area);
    guide.classList.toggle('custom', !!frame);
    picker.hidden = !pending;
    for (const [property, axis] of [['left', 'x'], ['top', 'y'], ['width', 'width'], ['height', 'height']]) {
      guide.style[property] = frame ? frame[axis] * 100 + '%' : '';
    }
  }

  function cancel() {
    pending = undefined;
    drag = undefined;
    render();
  }

  function set(next) {
    if (!next || ![next.x, next.y, next.width, next.height].every(Number.isFinite) ||
        next.x < 0 || next.y < 0 || next.width <= 0 || next.height <= 0 ||
        next.x + next.width > 1 || next.y + next.height > 1) return false;
    area = { x: next.x, y: next.y, width: next.width, height: next.height };
    cancel();
    return true;
  }

  function start() {
    pending = { ...(area ?? defaultArea()) };
    render();
    picker.focus({ preventScroll: true });
  }

  function reset() {
    area = undefined;
    cancel();
    return true;
  }

  function point(event) {
    const rect = picker.getBoundingClientRect();
    return { x: clamp((event.clientX - rect.left) / rect.width), y: clamp((event.clientY - rect.top) / rect.height) };
  }

  function updatePointer(event) {
    const end = point(event);
    pending = {
      x: Math.min(drag.x, end.x), y: Math.min(drag.y, end.y),
      width: Math.abs(end.x - drag.x), height: Math.abs(end.y - drag.y),
    };
    render();
  }

  picker.addEventListener('pointerdown', event => {
    if (event.button !== 0 || drag) return;
    event.preventDefault();
    drag = { id: event.pointerId, previous: pending, ...point(event) };
    picker.setPointerCapture(event.pointerId);
  });
  picker.addEventListener('pointermove', event => {
    if (drag?.id === event.pointerId) updatePointer(event);
  });
  function finishPointer(event) {
    if (drag?.id !== event.pointerId) return;
    const previous = drag.previous;
    if (event.type === 'pointerup') updatePointer(event);
    drag = undefined;
    if (event.type === 'pointerup' &&
        pending.width * picker.clientWidth >= minSide && pending.height * picker.clientHeight >= minSide &&
        set(pending)) {
      picker.dispatchEvent(new Event('cropchange'));
      return;
    }
    pending = previous;
    render();
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) picker.addEventListener(type, finishPointer);

  picker.addEventListener('keydown', event => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Escape' || event.key === 'Enter') {
      event.preventDefault();
      if (event.key === 'Escape') cancel();
      else set(pending);
      picker.dispatchEvent(new Event('cropchange'));
      return;
    }
    const delta = { ArrowLeft: [-1, 0], ArrowUp: [0, -1], ArrowRight: [1, 0], ArrowDown: [0, 1] }[event.key];
    if (!delta || drag) return;
    event.preventDefault();
    const dx = delta[0] * 12 / picker.clientWidth;
    const dy = delta[1] * 12 / picker.clientHeight;
    if (event.shiftKey) {
      pending.width = Math.max(Math.min(minSide / picker.clientWidth, 1 - pending.x), clamp(pending.width + dx, 1 - pending.x));
      pending.height = Math.max(Math.min(minSide / picker.clientHeight, 1 - pending.y), clamp(pending.height + dy, 1 - pending.y));
    } else {
      pending.x = clamp(pending.x + dx, 1 - pending.width);
      pending.y = clamp(pending.y + dy, 1 - pending.height);
    }
    render();
  });

  return {
    start, cancel, reset, set,
    confirm: () => pending && !drag && set(pending),
    get area() { return { ...(area ?? defaultArea()) }; },
    get editing() { return !!pending; },
    get custom() { return !!area; },
  };
}
