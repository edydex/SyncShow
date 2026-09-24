(() => {
  'use strict';
  const dialog = document.getElementById('translationDialog');
  const rows = document.getElementById('translationOutputs');
  const status = document.getElementById('translationStatus');
  const error = document.getElementById('translationError');
  const manualOutput = document.getElementById('translationManualOutput');
  const manualText = document.getElementById('translationManualText');
  let signature = '';
  let state = null;
  let pending = 0;

  function select(label, choices, field) {
    const wrapper = document.createElement('label');
    wrapper.append(label);
    const input = document.createElement('select');
    input.dataset.field = field;
    for (const [value, text] of choices) input.add(new Option(text, value));
    wrapper.append(input);
    return wrapper;
  }

  async function action(run) {
    pending++;
    dialog.setAttribute('aria-busy', 'true');
    error.textContent = '';
    try {
      const result = await run();
      if (!result?.success) throw new Error(result?.error?.message || 'Translation could not be updated.');
      render(result.data);
    } catch (cause) { error.textContent = cause.message; }
    finally { if (--pending === 0) dialog.removeAttribute('aria-busy'); }
  }

  function configure(outputId, row, hidden = false) {
    return action(() => window.api.configureTranslationOutput({ outputId, settings: {
      language: row.querySelector('[data-field="language"]').value,
      layout: hidden ? 'hidden' : row.querySelector('[data-field="layout"]').value,
      fontScale: Number(row.querySelector('[data-field="fontScale"]').value)
    } }));
  }

  function render(next) {
    if (!next?.outputs) return;
    state = next;
    const cueStatus = document.getElementById('translationCueStatus');
    if (cueStatus) {
      const automation = next.automation || { phase: 'idle' };
      cueStatus.hidden = automation.phase === 'idle';
      const labels = { preparing: 'Preparing the translation audio feed…', ready: 'Translation ready · starts on the next slide',
        starting: 'Starting translation…', live: 'Translation is live', stopping: 'Stopping translation…', error: 'Translation needs attention' };
      if (automation.phase === 'live' && next.connectionWarning) {
        labels.live = 'Reconnecting caption feed · screens hold their last text';
      }
      cueStatus.textContent = `${labels[automation.phase] || ''}${automation.message ? ` · ${automation.message}` : ''}`;
      if (automation.phase === 'error') {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Open translation controls';
        button.addEventListener('click', () => action(() => window.api.openTranslationOperator()));
        cueStatus.append(' ', button);
      }
    }
    status.textContent = ({ live: 'Receiving live captions', idle: 'Connected · waiting for the next service',
      connecting: 'Connecting to the church…', disconnected: next.origin ? 'Connection lost · screens hold their last text' : 'Connect to your church to receive captions' })[next.status];
    for (const language of ['en', 'ru']) {
      const text = next.captions[language]?.at(-1);
      document.getElementById(`translationPreview-${language}`).textContent = text?.text || 'Waiting for captions…';
    }
    const nextSignature = JSON.stringify(next.outputs.map(output => [output.id, output.name]));
    if (signature !== nextSignature) {
      signature = nextSignature;
      rows.replaceChildren(); manualOutput.replaceChildren();
      for (const output of next.outputs) {
        const row = document.createElement('div');
        row.className = 'translation-row'; row.dataset.outputId = output.id;
        const name = document.createElement('div'); name.className = 'translation-output-name';
        const strong = document.createElement('strong'); strong.textContent = output.name;
        const detail = document.createElement('small'); detail.dataset.field = 'detail';
        name.append(strong, detail); row.append(name);
        row.append(select('Language', [['en', 'English'], ['ru', 'Russian']], 'language'));
        row.append(select('Layout', [['hidden', 'Hidden'], ['full-screen', 'Full-screen feed'], ['lower-third', 'Lower third'], ['ticker', 'Scrolling ticker']], 'layout'));
        row.append(select('Text size', [['0.75', 'Smaller'], ['1', 'Standard'], ['1.25', 'Larger'], ['1.5', 'Largest']], 'fontScale'));
        for (const input of row.querySelectorAll('select')) input.addEventListener('change', () => configure(output.id, row));
        const hide = document.createElement('button'); hide.type = 'button'; hide.className = 'btn btn-secondary'; hide.textContent = 'Hide';
        hide.setAttribute('aria-label', `Hide translation on ${output.name}`);
        hide.addEventListener('click', () => configure(output.id, row, true));
        const screen = document.createElement('button'); screen.type = 'button'; screen.className = 'btn btn-secondary';
        screen.dataset.field = 'screen';
        screen.addEventListener('click', () => action(() => state.outputs.find(item => item.id === output.id)?.standalone
          ? window.api.closeTranslationScreen({ outputId: output.id })
          : window.api.openTranslationScreen({ outputId: output.id })));
        const actions = document.createElement('div'); actions.className = 'translation-screen-actions';
        actions.append(screen, hide);
        row.append(actions); rows.append(row); manualOutput.add(new Option(output.name, output.id));
      }
    }
    for (const row of rows.children) {
      const output = next.outputs.find(item => item.id === row.dataset.outputId);
      for (const field of ['language', 'layout', 'fontScale']) row.querySelector(`[data-field="${field}"]`).value = String(output[field]);
      row.querySelector('[data-field="detail"]').textContent = output.manual ? 'Manual text on this screen'
        : output.standalone ? output.screenReady ? 'Translation-only screen open' : 'Opening translation screen…'
        : output.active ? 'Show screen open' : output.screenUnavailable || 'Ready to open without slides';
      const screen = row.querySelector('[data-field="screen"]');
      screen.textContent = output.standalone ? 'Close screen' : 'Open screen';
      screen.setAttribute('aria-label', `${output.standalone ? 'Close' : 'Open'} translation screen for ${output.name}`);
      screen.disabled = !output.standalone && Boolean(output.screenUnavailable);
    }
  }

  function open() {
    if (!dialog.open) dialog.showModal();
    action(() => window.api.connectTranslation());
  }
  document.querySelectorAll('[data-open-translation]').forEach(button => button.addEventListener('click', open));
  document.getElementById('translationClose').addEventListener('click', () => dialog.close());
  document.getElementById('translationConnect').addEventListener('click', () => action(() => window.api.connectTranslation()));
  document.getElementById('translationOperator').addEventListener('click', () => action(() => window.api.openTranslationOperator()));
  document.getElementById('translationSendManual').addEventListener('click', () => action(async () => {
    const output = state?.outputs.find(item => item.id === manualOutput.value);
    if (!output || output.layout === 'hidden') throw new Error('Choose a visible layout for this output before showing manual text.');
    return window.api.overrideTranslationOutput({ outputId: output.id, text: manualText.value });
  }));
  document.getElementById('translationResume').addEventListener('click', () => action(() => window.api.overrideTranslationOutput({ outputId: manualOutput.value, text: null })));
  // Typing in live tools must never advance the Show behind the dialog.
  dialog.addEventListener('keydown', event => event.stopPropagation());
  window.api.onTranslationState(render);
  window.api.getTranslationState().then(result => { if (result.success) render(result.data); }).catch(() => {});
})();
