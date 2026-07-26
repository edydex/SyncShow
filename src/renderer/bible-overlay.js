/**
 * Double-buffered Bible overlay used by ordinary and Singer output windows.
 * New content is laid out invisibly, checked for clipping, then swapped at a
 * shared reveal deadline. The currently-live passage remains visible if a
 * replacement cannot be prepared.
 */
(function exposeBibleOverlayController() {
  function layerFromSuffix(suffix) {
    const overlay = document.getElementById(`bibleOverlay${suffix}`);
    return {
      overlay,
      reference: document.getElementById(`bibleReference${suffix}`),
      verses: document.getElementById(`bibleVerses${suffix}`),
      translation: document.getElementById(`bibleTranslation${suffix}`),
      attribution: document.getElementById(`bibleAttribution${suffix}`),
      footer: overlay?.querySelector('.bible-footer') || null,
      timer: null
    };
  }

  function createBibleOverlayController({ onReady, onReveal, onHide } = {}) {
    let activeLayer = layerFromSuffix('');
    let stagingLayer = layerFromSuffix('Staging');
    let activeOverlayId = null;
    let preparedOverlayId = null;

    function cancelTimer(layer) {
      if (!layer?.timer) return;
      clearTimeout(layer.timer);
      layer.timer = null;
    }

    function setStagingState(layer, staging) {
      layer.overlay.classList.toggle('staging', staging);
      layer.overlay.setAttribute('aria-hidden', staging ? 'true' : 'false');
    }

    function resetLayer(layer, { staging = false } = {}) {
      cancelTimer(layer);
      layer.overlay.hidden = true;
      layer.overlay.classList.remove('medium', 'long', 'compact');
      setStagingState(layer, staging);
    }

    function renderPassage(layer, passage) {
      layer.reference.textContent = passage.reference || '';
      layer.translation.textContent = passage.translationId || passage.translation?.id || '';
      layer.attribution.textContent = passage.attribution || passage.translation?.attribution || '';
      layer.verses.replaceChildren();

      const verses = Array.isArray(passage.verses) ? passage.verses : [];
      if (verses.length > 0) {
        for (const verse of verses) {
          const paragraph = document.createElement('p');
          const number = document.createElement('sup');
          number.className = 'bible-verse-number';
          number.textContent = String(verse.number ?? '');
          paragraph.append(number, document.createTextNode(String(verse.text || '')));
          layer.verses.appendChild(paragraph);
        }
      } else {
        layer.verses.textContent = String(passage.text || '');
      }
      return {
        verses,
        textLength: verses.reduce((total, verse) => total + String(verse.text || '').length, 0)
          || String(passage.text || '').length
      };
    }

    function layerFits(layer) {
      const tolerance = 2;
      const elements = [layer.overlay, layer.reference, layer.verses, layer.footer]
        .filter(Boolean);
      return elements.every(element =>
        element.clientWidth > 0
        && element.clientHeight > 0
        && element.scrollWidth <= element.clientWidth + tolerance
        && element.scrollHeight <= element.clientHeight + tolerance
      );
    }

    function fitLayer(layer, textLength, verseCount) {
      const preferredClass = textLength > 560 || verseCount > 6
        ? 'long'
        : (textLength > 300 || verseCount > 3 ? 'medium' : null);
      const candidates = [...new Set([preferredClass, 'medium', 'long', 'compact'])];
      for (const candidate of candidates) {
        layer.overlay.classList.remove('medium', 'long', 'compact');
        if (candidate) layer.overlay.classList.add(candidate);
        // Force layout so every candidate is measured before trying the next.
        void layer.overlay.offsetHeight;
        if (layerFits(layer)) return true;
      }
      return false;
    }

    function schedule(layer, revealAt, callback) {
      cancelTimer(layer);
      const delay = Number.isFinite(revealAt) ? Math.max(0, revealAt - Date.now()) : 0;
      if (delay === 0) {
        callback();
        return;
      }
      layer.timer = setTimeout(() => {
        layer.timer = null;
        callback();
      }, delay);
    }

    function prepare({ overlayId, passage } = {}) {
      if (!overlayId || !passage) return;
      preparedOverlayId = overlayId;
      resetLayer(stagingLayer, { staging: true });
      stagingLayer.overlay.hidden = false;
      const { verses, textLength } = renderPassage(stagingLayer, passage);

      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (preparedOverlayId !== overlayId) return;
        const fits = fitLayer(stagingLayer, textLength, verses.length);
        onReady?.({
          overlayId,
          ok: fits,
          ...(fits ? {} : { error: 'Passage does not fit this output at a readable size' })
        });
      }));
    }

    function reveal({ overlayId, revealAt } = {}) {
      if (!overlayId || preparedOverlayId !== overlayId) return;
      schedule(stagingLayer, revealAt, () => {
        if (preparedOverlayId !== overlayId) return;
        resetLayer(activeLayer, { staging: true });
        setStagingState(stagingLayer, false);
        stagingLayer.overlay.hidden = false;
        const previousLayer = activeLayer;
        activeLayer = stagingLayer;
        stagingLayer = previousLayer;
        activeOverlayId = overlayId;
        preparedOverlayId = null;
        onReveal?.({ overlayId });
      });
    }

    function hide({ overlayId, revealAt } = {}) {
      if (!overlayId) {
        resetLayer(activeLayer, { staging: true });
        resetLayer(stagingLayer, { staging: true });
        activeOverlayId = null;
        preparedOverlayId = null;
        return;
      }

      if (overlayId === preparedOverlayId) {
        schedule(stagingLayer, revealAt, () => {
          if (preparedOverlayId !== overlayId) return;
          resetLayer(stagingLayer, { staging: true });
          preparedOverlayId = null;
          onHide?.({ overlayId });
        });
      }
      if (overlayId === activeOverlayId) {
        schedule(activeLayer, revealAt, () => {
          if (activeOverlayId !== overlayId) return;
          resetLayer(activeLayer, { staging: true });
          activeOverlayId = null;
          onHide?.({ overlayId });
        });
      }
    }

    resetLayer(activeLayer, { staging: false });
    resetLayer(stagingLayer, { staging: true });
    return { prepare, reveal, hide };
  }

  window.createBibleOverlayController = createBibleOverlayController;
})();
