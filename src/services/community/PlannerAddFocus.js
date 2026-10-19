'use strict';

// Runs only in the pinned, approved local editor. Uses ordinary editing UI;
// adding a slide never requests a live take or opens a remote service picker.
async function openPlannerAdd(category) {
  const index = ['templates', 'songs', 'scripture', 'media'].indexOf(category);
  if (index < 0) return {opened: false};
  if (!document.querySelector('.heritage-add-dialog[open]')) document.querySelector('.heritage-add-slide')?.click();
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const tabs = document.querySelectorAll('.heritage-add-workbench [role="tab"]');
    if (tabs[index]) {
      tabs[index].click();
      return {opened: true, category};
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return {opened: false};
}

module.exports = {openPlannerAdd};
