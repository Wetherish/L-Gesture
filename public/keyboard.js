const shortcuts = new Map([
  ['KeyV', 'camera.toggle'],
  ['KeyA', 'crop.toggle'],
  ['KeyC', 'draft.capture'],
  ['KeyR', 'draft.random'],
  ['KeyP', 'draft.pin'],
  ['KeyN', 'photo.next'],
  ['KeyB', 'photo.previous'],
]);

const arrows = new Map([
  ['ArrowLeft', [-1, 0]],
  ['ArrowUp', [0, -1]],
  ['ArrowRight', [1, 0]],
  ['ArrowDown', [0, 1]],
]);

export function bindKeyboard(dispatch) {
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey ||
        event.target.closest?.('input, textarea, select, [contenteditable]')) return;

    const shortcut = event.shiftKey && shortcuts.get(event.code);
    const direction = arrows.get(event.key);
    const step = event.shiftKey ? 40 : 12;
    let handled = false;

    if (shortcut && !event.repeat) {
      handled = dispatch(shortcut);
    } else if (direction) {
      const [x, y] = direction;
      handled = event.target.closest?.('.resize')
        ? dispatch('photo.resize', { delta: (x + y) * step })
        : dispatch('photo.move', { dx: x * step, dy: y * step });
    } else if (event.key === '+' || event.key === '-' || event.code === 'NumpadAdd' || event.code === 'NumpadSubtract') {
      const sign = event.key === '-' || event.code === 'NumpadSubtract' ? -1 : 1;
      handled = dispatch('photo.resize', { delta: sign * 12 });
    } else if (!event.repeat && (event.key === 'Delete' ||
        (event.key === 'Backspace' && event.target.closest?.('.move')))) {
      handled = dispatch('photo.remove');
    } else if (event.key === 'Escape') {
      handled = dispatch('draft.discard');
    }

    if (handled) event.preventDefault();
  });
}
