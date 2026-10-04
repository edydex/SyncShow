'use strict';

// Runs in the approved Community editor, including cached versions of that
// editor. It uses its ordinary editing controls and never requests a live take.
async function focusPlannerCue({ syncId, cueId, number, sectionIds = [] }) {
  const frame = () => new Promise(resolve => {
    const id = requestAnimationFrame(() => { clearTimeout(timer); resolve(); });
    const timer = setTimeout(() => { cancelAnimationFrame(id); resolve(); }, 50);
  });
  const settle = async predicate => {
    const deadline = Date.now() + 500;
    do { await frame(); if (predicate()) return; } while (Date.now() < deadline);
  };
  const editing = document.activeElement;
  if (editing?.closest('input,textarea,[contenteditable]')) { editing.blur(); await frame(); }
  const picker = () => document.querySelector('.heritage-service-planner__service-picker select');
  const activeService = () => document.querySelector('[data-active-service]')?.dataset.activeService;
  if (!document.querySelector('[data-active-service]') && picker()?.value !== syncId) window.postMessage({ type: 'heritage-editor:open', syncId }, window.location.origin);
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (activeService() === syncId || (picker()?.value === syncId && !picker().disabled)) break;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  if (activeService() !== syncId && (picker()?.value !== syncId || picker().disabled)) return { focused: false };
  document.querySelector('.heritage-workspace-toolbar__views button:nth-child(2)')?.click();
  await frame();
  // The stage-facing output is derived and read-only. Reopening Adjust must
  // offer an editable audience slide, while retaining an English/Russian tab
  // the operator already chose. Output labels can be localized.
  const outputTabs=[...document.querySelectorAll('.heritage-service-planner__output-tabs [role="tab"]')];
  if(outputTabs[2]?.getAttribute('aria-selected')==='true') {
    outputTabs[0]?.click();
    await frame();
  }
  const visited = new Set(), selectionDeadline = Date.now() + 3000;
  for (let depth = 0; depth < 32 && Date.now() < selectionDeadline; depth++) {
    const rows = [...document.querySelectorAll('.heritage-service-planner__row[data-slide-id]')];
    const target = rows.find(row => row.dataset.slideId === cueId);
    if (target) {
      // Ordinary slides replace the selection. Section title controls use
      // Ctrl/Command to select just the title rather than every descendant.
      target.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: target.hasAttribute('aria-expanded') }));
      await settle(() => [...document.querySelectorAll('.heritage-service-planner__row[data-slide-id]')]
        .some(row => row.dataset.slideId === cueId && row.dataset.active === 'true'));
      const selected = [...document.querySelectorAll('.heritage-service-planner__row[data-slide-id]')]
        .find(row => row.dataset.slideId === cueId);
      selected?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      selected?.focus({ preventScroll: true });
      return { focused: selected?.dataset.active === 'true', cueId };
    }
    // A long service hides slides inside sections. Reveal the containing
    // section (and any nested section) through the existing selection logic.
    const owner = sectionIds.map(id => rows.find(row => row.dataset.slideId === id && !visited.has(id))).find(Boolean);
    const candidates = rows.map(row => ({ row, number: Number(row.querySelector('.heritage-service-planner__kind')?.textContent)
      || Number(/^\s*(\d+)\./.exec(row.querySelector('strong')?.textContent || '')?.[1]) }))
      .filter(value => value.number > 0 && value.number <= number && !visited.has(value.row.dataset.slideId))
      .sort((a, b) => b.number - a.number);
    if (!owner && !candidates.length) break;
    const section = owner || candidates[0].row;
    visited.add(section.dataset.slideId);
    const before = rows.map(row => row.dataset.slideId).join('|');
    section.dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true }));
    // React can commit a cold editor after the first animation frame. Do not
    // select a fallback row from the old collapsed outline while it is pending.
    await settle(() => {
      const current = [...document.querySelectorAll('.heritage-service-planner__row[data-slide-id]')];
      return current.map(row => row.dataset.slideId).join('|') !== before
        || current.find(row => row.dataset.slideId === section.dataset.slideId)?.getAttribute?.('aria-expanded') === 'true';
    });
  }
  return { focused: false, cueId };
}

module.exports = { focusPlannerCue };
