'use strict';
(function expose(root) {
  const screens = [
    {id: 'english', name: 'English', symbol: 'Aa', detail: 'Audience screen'},
    {id: 'russian', name: 'Russian', symbol: 'Яя', detail: 'Audience screen'},
    {id: 'media', name: 'Stage-Facing', symbol: '≡', detail: 'Current slide + what’s next'}
  ];

  function createPicker(host, {value, onChange = () => {}}) {
    let current;
    const setValue = next => { current = structuredClone(next); render(); };
    const getValue = () => ({screenIds: [...current.screenIds], hintScreenIds: current.hintScreenIds.filter(id => current.screenIds.includes(id))});
    function change(next) { current = next; render(); onChange(getValue()); }
    function render() {
      host.replaceChildren();
      host.classList.add('presentation-screen-picker');
      for (const screen of screens) {
        const active = current.screenIds.includes(screen.id);
        const card = document.createElement('div');
        card.className = `presentation-screen-card${active ? ' is-selected' : ''}`;
        const button = document.createElement('button');
        button.type = 'button'; button.className = 'presentation-screen-choice';
        button.setAttribute('aria-pressed', String(active));
        const icon = document.createElement('span'); icon.className = 'presentation-screen-icon'; icon.textContent = screen.symbol; icon.setAttribute('aria-hidden', 'true');
        const name = document.createElement('strong'); name.textContent = screen.name;
        const detail = document.createElement('small'); detail.textContent = screen.detail;
        button.append(icon, name, detail);
        button.addEventListener('click', () => {
          const screenIds = active ? current.screenIds.filter(id => id !== screen.id) : [...current.screenIds, screen.id];
          const hintScreenIds = current.hintScreenIds.filter(id => screenIds.includes(id));
          if (!active && screen.id === 'media') hintScreenIds.push('media');
          change({screenIds, hintScreenIds});
          host.querySelector(`[data-screen="${screen.id}"] button`)?.focus();
        });
        const label = document.createElement('label'); label.className = 'presentation-screen-hint';
        const input = document.createElement('input'); input.type = 'checkbox'; input.disabled = !active;
        input.checked = current.hintScreenIds.includes(screen.id);
        input.addEventListener('change', () => {
          change({...current, hintScreenIds: input.checked ? [...current.hintScreenIds, screen.id] : current.hintScreenIds.filter(id => id !== screen.id)});
          host.querySelector(`[data-screen="${screen.id}"] input`)?.focus();
        });
        label.append(input, document.createTextNode('Show next slide'));
        card.dataset.screen = screen.id; card.append(button, label); host.append(card);
      }
      const summary = document.createElement('p'); summary.className = 'presentation-screen-count'; summary.setAttribute('role', 'status');
      const count = current.screenIds.length;
      summary.textContent = count ? `${count} ${count === 1 ? 'screen' : 'screens'} selected · physical screens are assigned when you present` : 'Choose at least one screen';
      host.append(summary);
    }
    setValue(value);
    return {setValue, getValue};
  }
  root.SyncShowScreenPicker = {createPicker};
})(window);
