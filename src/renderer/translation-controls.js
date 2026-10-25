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
    } catch (cause) { error.textContent = cause.message; if (!dialog.open) dialog.showModal(); }
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
    const audioSelect = document.getElementById('translationDefaultInput');
    const audioChoices = [...(next.audioInputs || [])];
    if (next.audioInput && !audioChoices.some(input => input.id === next.audioInput.id)) audioChoices.unshift(next.audioInput);
    const audioSignature = JSON.stringify(audioChoices);
    if (audioSelect.dataset.choices !== audioSignature) {
      audioSelect.dataset.choices = audioSignature;
      audioSelect.replaceChildren(new Option('Choose an audio input', ''));
      for (const input of audioChoices) audioSelect.add(new Option(input.label, input.id));
    }
    audioSelect.value = next.audioInput?.id || '';
    document.getElementById('translationAudioStatus').textContent = next.audioInput ? `Saved default: ${next.audioInput.label}. Used by translation cues and Translate.` : 'No default audio input saved. Click Find audio inputs, then choose the mixer.';
    const toggle = document.getElementById('translationToggle');
    const running = ['live', 'ready', 'starting', 'preparing', 'stopping'].includes(next.automation?.phase);
    if (toggle) { toggle.textContent = running ? 'Stop translation' : 'Translate'; toggle.disabled = next.automation?.phase === 'stopping'; }
    if (next.defaults && !dialog.contains(document.activeElement)) {
      document.getElementById('translationDefaultProvider').value = next.defaults.transcriptionProvider;
      document.getElementById('translationDefaultSource').value = next.defaults.sourceLanguage;
      document.getElementById('translationDefaultSpeech').checked = next.defaults.speechEnabled;
    }
    const cueStatus = document.getElementById('translationCueStatus');
    if (cueStatus) {
      const automation = next.automation || { phase: 'idle' };
      cueStatus.hidden = automation.phase === 'idle';
      const labels = { preparing: 'Preparing the translation audio feed…', ready: 'Translation ready · starts on the next slide',
        starting: 'Starting translation…', live: next.captions.en?.length || next.captions.ru?.length ? 'Translation is live · captions received' : 'Translation started · waiting for speech and captions', stopping: 'Stopping translation…', error: 'Translation needs attention' };
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
    if (state?.defaults) {
      document.getElementById('translationDefaultProvider').value = state.defaults.transcriptionProvider;
      document.getElementById('translationDefaultSource').value = state.defaults.sourceLanguage;
      document.getElementById('translationDefaultSpeech').checked = state.defaults.speechEnabled;
    }
    if (!dialog.open) dialog.showModal();
    action(() => window.api.connectTranslation());
  }
  document.querySelectorAll('[data-open-translation]').forEach(button => button.addEventListener('click', open));
  document.getElementById('translationFindInputs').addEventListener('click', () => action(() => window.api.listTranslationInputs()));
  document.getElementById('translationDefaultInput').addEventListener('change', event => action(() => {
    const input = state?.audioInputs?.find(value => value.id === event.target.value);
    if (!input) throw new Error('Click Find audio inputs before choosing a new default.');
    return window.api.saveTranslationInput(input);
  }));
  document.getElementById('translationToggle').addEventListener('click', () => action(() => window.api.toggleTranslation()));
  document.getElementById('translationSaveDefaults').addEventListener('click', () => action(() => window.api.saveTranslationDefaults({
    transcriptionProvider: document.getElementById('translationDefaultProvider').value,
    sourceLanguage: document.getElementById('translationDefaultSource').value,
    speechEnabled: document.getElementById('translationDefaultSpeech').checked
  })));
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
