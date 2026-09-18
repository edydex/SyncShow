'use strict';

(function exposeShowAccessibility(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SyncShowShowAccessibility = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  const GLOBAL_SHORTCUT_KEYS = new Set([
    'ArrowRight',
    'ArrowLeft',
    'Home',
    'End',
    'Escape',
    ' '
  ]);
  const NATIVE_ACTIVATION_KEYS = new Set(['Enter', ' ']);
  const SHOW_TRANSPORT_BUTTON_IDS = new Set([
    'btnPrevSlide',
    'btnNextSlide',
    'btnShowDisplays',
    'btnClearDisplays'
  ]);

  function elementTagName(element) {
    return String(element?.tagName || '').toUpperCase();
  }

  function parentElement(element) {
    return element?.parentElement || element?.parentNode || null;
  }

  function closestElement(target, predicate) {
    let current = target || null;
    while (current) {
      if (predicate(current)) return current;
      current = parentElement(current);
    }
    return null;
  }

  function isEditableElement(element) {
    const tagName = elementTagName(element);
    if (tagName === 'INPUT' || tagName === 'SELECT' || tagName === 'TEXTAREA') return true;
    if (element?.isContentEditable === true) return true;
    return String(element?.getAttribute?.('contenteditable') || '').toLowerCase() === 'true';
  }

  function isInteractiveElement(element) {
    const tagName = elementTagName(element);
    if (tagName === 'BUTTON') return true;
    if (tagName === 'A' && Boolean(element?.getAttribute?.('href'))) return true;
    const role = String(element?.getAttribute?.('role') || '').toLowerCase();
    return role === 'button' || role === 'link';
  }

  function shouldHandleGlobalShowShortcut(event, { dialogOpen = false } = {}) {
    const key = String(event?.key || '');
    if (dialogOpen || !GLOBAL_SHORTCUT_KEYS.has(key)) return false;
    if (closestElement(event?.target, isEditableElement)) return false;

    // Clear is the emergency Show escape hatch. A focused setup or live-tool
    // button must not make Escape inert after the operator enters Show. Open
    // dialogs and editable fields were rejected above, so their own cancel and
    // editing semantics remain intact.
    if (key === 'Escape') return true;

    const interactive = closestElement(event?.target, isInteractiveElement);
    if (!interactive) return true;
    const showTransport = SHOW_TRANSPORT_BUTTON_IDS.has(String(interactive.id || ''))
      || interactive.getAttribute?.('data-show-transport') === 'true';
    if (!showTransport) return false;

    // Enter and Space continue to activate the focused button. The navigation
    // keys remain available after a mouse click without moving focus elsewhere.
    return !NATIVE_ACTIVATION_KEYS.has(key);
  }

  function setThumbnailCurrentState(item, isCurrent) {
    if (!item) return;
    item.classList?.toggle?.('active', Boolean(isCurrent));
    if (isCurrent) item.setAttribute?.('aria-current', 'true');
    else item.removeAttribute?.('aria-current');
  }

  function thumbnailActionLabel(slideIndex, text) {
    const slideNumber = Number.isInteger(slideIndex) ? slideIndex + 1 : 1;
    const summary = String(text || '').replace(/\s+/g, ' ').trim();
    return summary && summary !== '—'
      ? `Go to slide ${slideNumber}: ${summary}`
      : `Go to slide ${slideNumber}`;
  }

  return Object.freeze({
    setThumbnailCurrentState,
    shouldHandleGlobalShowShortcut,
    thumbnailActionLabel
  });
}));
