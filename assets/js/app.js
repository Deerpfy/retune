(function (Retune) {
  const state = Retune.state;
  const util = Retune.util;
  const model = Retune.model;

  const TAP_RESET = 2000;
  const TAP_HISTORY = 8;
  const PEAK_PROGRESS_SECONDS = 30;
  const READOUT_INTERVAL = 100;
  const DECODE_HINT = 'Files that normally decode: WAV, MP3, AAC in M4A, FLAC, OGG Vorbis, Opus and WebM.';

  const dom = {};
  const messages = new Map();
  const cards = new Map();
  let dragSourceId = null;
  let lastReadout = 0;
  let veilDepth = 0;
  let playButton = null;
  let loopButton = null;

  function byId(id) {
    return document.getElementById(id);
  }

  function updateFootbar() {
    dom.footbar.hidden = dom.transport.hidden && messages.size === 0;
  }

  function ensureMessage(id) {
    let entry = messages.get(id);
    if (!entry) {
      const element = document.createElement('div');
      element.className = 'message';
      const text = document.createElement('p');
      element.appendChild(text);
      entry = { element: element, text: text, bar: null };
      messages.set(id, entry);
      dom.messages.appendChild(element);
      updateFootbar();
    }
    return entry;
  }

  function dismiss(id) {
    const entry = messages.get(id);
    if (!entry) {
      return;
    }
    entry.element.remove();
    messages.delete(id);
    updateFootbar();
  }

  function status(text, kind) {
    const id = util.uid('message-');
    const entry = ensureMessage(id);
    entry.text.textContent = text;
    if (kind === 'error') {
      entry.element.classList.add('message-error');
    }
    entry.element.appendChild(Retune.icons.button({
      icon: 'x-mark',
      label: 'Dismiss message',
      hideLabel: true,
      className: 'btn-small btn-icon',
      onClick: function () {
        dismiss(id);
      }
    }));
    if (kind !== 'error') {
      setTimeout(function () {
        dismiss(id);
      }, util.tokenNumber('--message-timeout'));
    }
  }

  function progress(id, label, value) {
    const entry = ensureMessage(id);
    entry.text.textContent = label;
    if (!entry.bar) {
      entry.bar = document.createElement('progress');
      entry.bar.max = 1;
      entry.element.appendChild(entry.bar);
    }
    entry.bar.value = value;
  }

  function showWorkspace() {
    if (!dom.workspace.hidden) {
      return;
    }
    dom.empty.hidden = true;
    dom.workspace.hidden = false;
    dom.topbar.hidden = false;
    dom.transport.hidden = false;
    updateFootbar();
    Retune.transport.setMeterCanvas(dom.meter);
    Retune.timeline.redraw();
  }

  function readArrayBuffer(file) {
    if (typeof file.arrayBuffer === 'function') {
      return file.arrayBuffer();
    }
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(reader.result);
      };
      reader.onerror = function () {
        reject(new Error('the file could not be read'));
      };
      reader.readAsArrayBuffer(file);
    });
  }

  function placeSource(source) {
    const lane = state.lanes[0];
    if (!lane) {
      return;
    }
    const clips = model.laneClips(lane.id);
    const start = clips.length > 0 ? model.clipEnd(clips[clips.length - 1]) : 0;
    Retune.timeline.addClip(source.id, lane.id, start);
  }

  function clampClipsToSource(source) {
    state.clips.forEach(function (clip) {
      if (clip.sourceId !== source.id) {
        return;
      }
      clip.trimOutSeconds = Math.min(clip.trimOutSeconds || source.duration, source.duration);
      clip.trimInSeconds = util.clamp(clip.trimInSeconds, 0, Math.max(0, clip.trimOutSeconds - 0.01));
    });
  }

  async function loadAudioFile(file) {
    let buffer;
    try {
      const data = await readArrayBuffer(file);
      buffer = await Retune.engine.decode(data);
    } catch (error) {
      status(file.name + ' did not load: this browser cannot decode that container or codec. ' + DECODE_HINT, 'error');
      return;
    }
    const waiting = state.sources.find(function (source) {
      return source.name === file.name && !source.buffer;
    });
    const source = waiting || model.createSource(file.name);
    source.buffer = buffer;
    source.duration = buffer.duration;
    source.channels = buffer.numberOfChannels;
    if (!waiting) {
      state.sources.push(source);
    }
    showWorkspace();
    Retune.bus.emit('sources', {});

    const peakId = 'peaks-' + source.id;
    const showPeakProgress = buffer.duration > PEAK_PROGRESS_SECONDS;
    if (showPeakProgress) {
      progress(peakId, 'Reading ' + source.name, 0);
    }
    const peaks = await Retune.waveform.extractPeaks(buffer, function (value) {
      if (showPeakProgress) {
        progress(peakId, 'Reading ' + source.name, value);
      }
    });
    source.peaks = peaks.peaks;
    source.bucketCount = peaks.bucketCount;
    dismiss(peakId);
    if (waiting) {
      clampClipsToSource(source);
    } else {
      placeSource(source);
    }
    Retune.bus.emit('source-meta', { sourceId: source.id });
    Retune.bus.emit('project', {});

    const tempoId = 'tempo-' + source.id;
    progress(tempoId, 'Detecting tempo of ' + source.name, 0);
    try {
      const detection = await Retune.bpmDetect.detect(buffer, function (value) {
        progress(tempoId, 'Detecting tempo of ' + source.name, value);
      });
      source.detectedBpm = detection.bpm;
      source.confidence = detection.confidence;
      model.refreshClipsOfSource(source.id);
    } catch (error) {
      status('Tempo detection failed for ' + source.name + ': ' + error.message + '.', 'error');
    }
    dismiss(tempoId);
    Retune.bus.emit('source-meta', { sourceId: source.id });
    Retune.bus.emit('selection', {});
    Retune.bus.emit('project', {});
  }

  async function acceptFiles(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) {
      return;
    }
    await Retune.engine.resume();
    for (let i = 0; i < files.length; i += 1) {
      await loadAudioFile(files[i]);
    }
  }

  function sourceMeta(source) {
    if (!source.buffer) {
      return 'file not loaded, add it again to relink';
    }
    return util.formatSeconds(source.duration) + ', ' +
      (source.channels > 1 ? source.channels + ' channels' : 'mono') + ', ' +
      Math.round(source.buffer.sampleRate) + ' Hz';
  }

  function bpmText(source) {
    if (source.bpmOverride > 0) {
      return 'Manual ' + source.bpmOverride.toFixed(1) + ' BPM';
    }
    if (source.detectedBpm > 0) {
      return 'Detected ' + source.detectedBpm.toFixed(1) + ' BPM';
    }
    return 'No tempo detected';
  }

  function buildCard(source) {
    const item = document.createElement('li');
    item.className = 'source';

    const head = document.createElement('div');
    head.className = 'source-head';
    const name = document.createElement('span');
    name.className = 'source-name';
    name.textContent = source.name;
    name.title = source.name;
    head.appendChild(name);
    head.appendChild(Retune.icons.button({
      icon: 'trash-can',
      label: 'Remove ' + source.name,
      hideLabel: true,
      className: 'btn-small btn-icon',
      onClick: function () {
        Retune.engine.clearForSource(source.id);
        model.removeSource(source.id);
        Retune.transport.reschedule();
        Retune.bus.emit('sources', {});
        Retune.bus.emit('selection', {});
        Retune.bus.emit('project', {});
      }
    }));
    item.appendChild(head);

    const canvas = document.createElement('canvas');
    canvas.className = 'source-canvas';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Waveform of ' + source.name);
    item.appendChild(canvas);

    const meta = document.createElement('p');
    meta.className = 'source-meta';
    item.appendChild(meta);

    const tempoLine = document.createElement('p');
    tempoLine.className = 'source-meta';
    item.appendChild(tempoLine);

    const confidence = document.createElement('div');
    confidence.className = 'confidence';
    const confidenceLabel = document.createElement('span');
    const track = document.createElement('div');
    track.className = 'confidence-track';
    const fill = document.createElement('div');
    fill.className = 'confidence-fill';
    track.appendChild(fill);
    confidence.appendChild(confidenceLabel);
    confidence.appendChild(track);
    item.appendChild(confidence);

    const bpmRow = document.createElement('div');
    bpmRow.className = 'row';
    const bpmField = document.createElement('label');
    bpmField.className = 'field';
    const bpmCaption = document.createElement('span');
    bpmCaption.textContent = 'BPM override';
    const bpmInput = document.createElement('input');
    bpmInput.type = 'number';
    bpmInput.inputMode = 'decimal';
    bpmInput.min = '20';
    bpmInput.max = '300';
    bpmInput.step = '0.1';
    bpmInput.addEventListener('change', function () {
      const parsed = parseFloat(bpmInput.value);
      source.bpmOverride = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
      model.refreshClipsOfSource(source.id);
      Retune.bus.emit('source-meta', { sourceId: source.id });
      Retune.bus.emit('selection', {});
      Retune.bus.emit('project', {});
    });
    bpmField.appendChild(bpmCaption);
    bpmField.appendChild(bpmInput);
    bpmRow.appendChild(bpmField);

    let taps = [];
    bpmRow.appendChild(Retune.icons.button({
      label: 'Tap tempo',
      onClick: function () {
        const now = performance.now();
        if (taps.length > 0 && now - taps[taps.length - 1] > TAP_RESET) {
          taps = [];
        }
        taps.push(now);
        if (taps.length > TAP_HISTORY) {
          taps = taps.slice(taps.length - TAP_HISTORY);
        }
        if (taps.length < 2) {
          return;
        }
        const span = taps[taps.length - 1] - taps[0];
        const bpm = (60000 * (taps.length - 1)) / span;
        source.bpmOverride = util.round(util.clamp(bpm, 20, 300), 1);
        model.refreshClipsOfSource(source.id);
        Retune.bus.emit('source-meta', { sourceId: source.id });
        Retune.bus.emit('selection', {});
        Retune.bus.emit('project', {});
      }
    }));
    item.appendChild(bpmRow);

    const actions = document.createElement('div');
    actions.className = 'row';
    actions.appendChild(Retune.icons.button({
      icon: 'plus',
      label: 'Add to timeline',
      onClick: function () {
        Retune.timeline.addAtPlayhead(source.id);
      }
    }));
    const grip = Retune.icons.button({
      icon: 'grip-dots',
      label: 'Drag ' + source.name + ' onto a lane',
      hideLabel: true,
      className: 'source-grip'
    });
    grip.addEventListener('pointerdown', function (event) {
      dragSourceId = source.id;
      grip.setPointerCapture(event.pointerId);
      event.preventDefault();
    });
    grip.addEventListener('pointermove', function (event) {
      if (dragSourceId !== source.id) {
        return;
      }
      Retune.timeline.updateSourceDrag(source.id, event.clientX, event.clientY);
    });
    grip.addEventListener('pointerup', function (event) {
      if (dragSourceId !== source.id) {
        return;
      }
      dragSourceId = null;
      if (grip.hasPointerCapture(event.pointerId)) {
        grip.releasePointerCapture(event.pointerId);
      }
      Retune.timeline.endSourceDrag(source.id, event.clientX, event.clientY);
    });
    actions.appendChild(grip);
    item.appendChild(actions);

    function update() {
      meta.textContent = sourceMeta(source);
      tempoLine.textContent = bpmText(source);
      const percent = Math.round(source.confidence * 100);
      confidenceLabel.textContent = 'Confidence ' + percent + '%';
      fill.style.width = percent + '%';
      if (document.activeElement !== bpmInput) {
        bpmInput.value = source.bpmOverride > 0 ? String(source.bpmOverride) : '';
      }
      if (source.peaks) {
        Retune.waveform.drawSource(canvas, source);
      }
    }

    cards.set(source.id, update);
    update();
    return item;
  }

  function renderLibrary() {
    cards.clear();
    dom.library.textContent = '';
    state.sources.forEach(function (source) {
      dom.library.appendChild(buildCard(source));
    });
  }

  function updateCard(payload) {
    const update = cards.get(payload.sourceId);
    if (update) {
      update();
    }
  }

  function refreshCards() {
    cards.forEach(function (update) {
      update();
    });
  }

  async function runExport() {
    if (state.clips.length === 0) {
      status('There is nothing to export yet: add a clip to the timeline first.', 'error');
      return;
    }
    const target = dom.exportTarget.value;
    const depth = parseInt(dom.exportDepth.value, 10);
    const base = Retune.exportWav.safeName(Retune.appName.toLowerCase());
    progress('export', 'Preparing export', 0);
    try {
      await Retune.engine.prepare(state.clips, function (value, name) {
        progress('export', 'Preparing ' + name, value);
      });
      const duration = model.projectDuration();
      if (target === 'selection') {
        const bounds = Retune.transport.selectionBounds();
        if (!bounds) {
          status('Drag a selection range on the ruler, or use the in and out buttons, before exporting a selection.', 'error');
          return;
        }
        progress('export', 'Rendering selection', 0);
        const rendered = await Retune.transport.renderOffline(bounds.from, bounds.to, null);
        Retune.exportWav.download(Retune.exportWav.encode(rendered, depth), base + '-selection.wav');
      } else if (target === 'stems') {
        for (let i = 0; i < state.lanes.length; i += 1) {
          const lane = state.lanes[i];
          progress('export', 'Rendering ' + lane.name, i / state.lanes.length);
          const rendered = await Retune.transport.renderOffline(0, duration, lane.id);
          Retune.exportWav.download(
            Retune.exportWav.encode(rendered, depth),
            base + '-' + Retune.exportWav.safeName(lane.name) + '.wav'
          );
        }
      } else {
        progress('export', 'Rendering project', 0);
        const rendered = await Retune.transport.renderOffline(0, duration, null);
        Retune.exportWav.download(Retune.exportWav.encode(rendered, depth), base + '-mixdown.wav');
      }
      status('Export finished.', 'info');
    } catch (error) {
      status('Export failed: ' + error.message + '.', 'error');
    } finally {
      dismiss('export');
    }
  }

  async function openProject(file) {
    try {
      const missing = await Retune.projectIo.load(file);
      Retune.bus.emit('sources', {});
      Retune.bus.emit('selection', {});
      Retune.bus.emit('project', {});
      Retune.timeline.renderHeaders();
      showWorkspace();
      dom.projectBpm.value = String(state.projectBpm);
      dom.snapMode.value = state.snap;
      dom.rulerMode.value = state.rulerMode;
      if (loopButton) {
        loopButton.setAttribute('aria-pressed', String(state.loop));
      }
      if (missing.length > 0) {
        status('These files are not loaded: ' + missing.join(', ') + '. Add them again with the same file names to relink them.', 'error');
      } else {
        status('Project loaded.', 'info');
      }
    } catch (error) {
      status('Project did not load: ' + error.message + '.', 'error');
    }
  }

  function buildTransport() {
    playButton = Retune.icons.button({
      icon: 'triangle-right',
      label: 'Play',
      onClick: function () {
        Retune.transport.toggle();
      }
    });
    dom.transportControls.appendChild(playButton);
    dom.transportControls.appendChild(Retune.icons.button({
      icon: 'square',
      label: 'Stop',
      onClick: function () {
        Retune.transport.stop();
      }
    }));
    dom.transportControls.appendChild(Retune.icons.button({
      icon: 'arrow-left-line',
      label: 'Start',
      title: 'Return to start',
      onClick: function () {
        Retune.transport.toStart();
      }
    }));
    loopButton = Retune.icons.button({
      icon: 'arrows-loop',
      label: 'Loop',
      pressed: state.loop,
      onClick: function () {
        state.loop = !state.loop;
        loopButton.setAttribute('aria-pressed', String(state.loop));
        Retune.transport.reschedule();
      }
    });
    dom.transportControls.appendChild(loopButton);
    dom.transportControls.appendChild(Retune.icons.button({
      label: 'Set in',
      title: 'Set the selection start at the playhead',
      onClick: function () {
        state.selectionIn = state.playhead;
        if (state.selectionOut < state.selectionIn) {
          state.selectionOut = state.selectionIn;
        }
        Retune.timeline.redraw();
      }
    }));
    dom.transportControls.appendChild(Retune.icons.button({
      label: 'Set out',
      title: 'Set the selection end at the playhead',
      onClick: function () {
        state.selectionOut = state.playhead;
        if (state.selectionIn > state.selectionOut) {
          state.selectionIn = state.selectionOut;
        }
        Retune.timeline.redraw();
      }
    }));
  }

  function buildPanels() {
    dom.libraryActions.appendChild(Retune.icons.button({
      icon: 'folder',
      label: 'Add files',
      onClick: function () {
        dom.audioInput.click();
      }
    }));
    dom.timelineActions.appendChild(Retune.icons.button({
      icon: 'magnifier-minus',
      label: 'Zoom out',
      hideLabel: true,
      className: 'btn-icon',
      onClick: function () {
        Retune.timeline.zoomBy(1 / 1.5);
      }
    }));
    dom.timelineActions.appendChild(Retune.icons.button({
      icon: 'magnifier-plus',
      label: 'Zoom in',
      hideLabel: true,
      className: 'btn-icon',
      onClick: function () {
        Retune.timeline.zoomBy(1.5);
      }
    }));
    dom.timelineActions.appendChild(Retune.icons.button({
      icon: 'arrows-out',
      label: 'Fit',
      onClick: function () {
        Retune.timeline.fit();
      }
    }));
    dom.timelineActions.appendChild(Retune.icons.button({
      icon: 'plus',
      label: 'Add lane',
      onClick: function () {
        model.addLane();
        Retune.timeline.renderHeaders();
        Retune.timeline.redraw();
        Retune.bus.emit('selection', {});
      }
    }));
    dom.outputActions.appendChild(Retune.icons.button({
      icon: 'arrow-down-tray',
      label: 'Export WAV',
      onClick: runExport
    }));
    dom.outputActions.appendChild(Retune.icons.button({
      label: 'Save project',
      onClick: function () {
        Retune.projectIo.save();
      }
    }));
    dom.outputActions.appendChild(Retune.icons.button({
      label: 'Open project',
      onClick: function () {
        dom.projectInput.click();
      }
    }));
  }

  function bindGlobalInput() {
    dom.heroPick.addEventListener('click', function () {
      dom.audioInput.click();
    });
    dom.audioInput.addEventListener('change', function () {
      acceptFiles(dom.audioInput.files);
      dom.audioInput.value = '';
    });
    dom.projectInput.addEventListener('change', function () {
      const file = dom.projectInput.files[0];
      dom.projectInput.value = '';
      if (file) {
        openProject(file);
      }
    });
    window.addEventListener('dragenter', function (event) {
      event.preventDefault();
      veilDepth += 1;
      dom.veil.hidden = false;
    });
    window.addEventListener('dragover', function (event) {
      event.preventDefault();
    });
    window.addEventListener('dragleave', function (event) {
      event.preventDefault();
      veilDepth = Math.max(0, veilDepth - 1);
      if (veilDepth === 0) {
        dom.veil.hidden = true;
      }
    });
    window.addEventListener('drop', function (event) {
      event.preventDefault();
      veilDepth = 0;
      dom.veil.hidden = true;
      if (event.dataTransfer) {
        acceptFiles(event.dataTransfer.files);
      }
    });
    window.addEventListener('paste', function (event) {
      if (event.clipboardData && event.clipboardData.files.length > 0) {
        acceptFiles(event.clipboardData.files);
      }
    });
    window.addEventListener('keydown', function (event) {
      if (event.code !== 'Space' && event.key !== ' ') {
        return;
      }
      const target = event.target;
      const tag = target && target.tagName ? target.tagName.toLowerCase() : '';
      if (tag === 'input' || tag === 'select' || tag === 'textarea' || tag === 'button' || tag === 'summary') {
        return;
      }
      event.preventDefault();
      Retune.transport.toggle();
    });
    window.addEventListener('resize', refreshCards);
  }

  function bindTopbar() {
    dom.projectBpm.addEventListener('change', function () {
      const parsed = parseFloat(dom.projectBpm.value);
      if (Number.isFinite(parsed) && parsed >= 20 && parsed <= 300) {
        state.projectBpm = parsed;
        Retune.timeline.redraw();
      } else {
        dom.projectBpm.value = String(state.projectBpm);
      }
    });
    dom.snapMode.addEventListener('change', function () {
      state.snap = dom.snapMode.value;
    });
    dom.rulerMode.addEventListener('change', function () {
      state.rulerMode = dom.rulerMode.value;
      Retune.timeline.redraw();
    });
  }

  function bindBus() {
    Retune.bus.on('status', function (payload) {
      status(payload.text, payload.kind);
    });
    Retune.bus.on('progress', function (payload) {
      if (payload.done) {
        dismiss(payload.id);
        return;
      }
      progress(payload.id, payload.label, payload.value);
    });
    Retune.bus.on('sources', renderLibrary);
    Retune.bus.on('source-meta', updateCard);
    Retune.bus.on('project', function () {
      Retune.timeline.renderHeaders();
      Retune.timeline.redraw();
    });
    Retune.bus.on('selection', function () {
      Retune.timeline.renderHeaders();
      Retune.timeline.redraw();
    });
    Retune.bus.on('transport', function (payload) {
      if (!playButton) {
        return;
      }
      playButton.textContent = '';
      playButton.insertAdjacentHTML('afterbegin', Retune.icons.markup(payload.playing ? 'bars-two' : 'triangle-right'));
      const label = document.createElement('span');
      label.textContent = payload.playing ? 'Pause' : 'Play';
      playButton.appendChild(label);
    });
    Retune.bus.on('playhead', function (payload) {
      const now = performance.now();
      if (now - lastReadout < READOUT_INTERVAL) {
        return;
      }
      lastReadout = now;
      dom.time.textContent = util.formatSeconds(payload.seconds) + ' | bar ' + util.formatBarBeat(payload.seconds, state.projectBpm);
    });
    Retune.bus.on('meter', function (payload) {
      dom.meterValue.textContent = payload.db === -Infinity ? 'off' : Math.round(payload.db) + ' dB';
    });
  }

  function init() {
    dom.topbar = byId('topbar');
    dom.empty = byId('empty-state');
    dom.workspace = byId('workspace');
    dom.heroPick = byId('hero-pick');
    dom.library = byId('library-list');
    dom.libraryActions = byId('library-actions');
    dom.timelineActions = byId('timeline-actions');
    dom.outputActions = byId('output-actions');
    dom.exportTarget = byId('export-target');
    dom.exportDepth = byId('export-depth');
    dom.inspectorBody = byId('inspector-body');
    dom.messages = byId('messages');
    dom.transport = byId('transport');
    dom.transportControls = byId('transport-controls');
    dom.time = byId('transport-time');
    dom.meter = byId('meter');
    dom.meterValue = byId('meter-value');
    dom.veil = byId('drop-veil');
    dom.footbar = byId('footbar');
    dom.audioInput = byId('audio-input');
    dom.projectInput = byId('project-input');
    dom.projectBpm = byId('project-bpm');
    dom.snapMode = byId('snap-mode');
    dom.rulerMode = byId('ruler-mode');

    model.addLane('Lane 1');
    model.addLane('Lane 2');

    bindBus();
    buildTransport();
    buildPanels();
    bindGlobalInput();
    bindTopbar();

    Retune.timeline.mount({
      canvas: byId('timeline-canvas'),
      stage: byId('timeline-stage'),
      scroller: byId('timeline-scroll'),
      headers: byId('lane-headers'),
      playhead: byId('playhead')
    });
    Retune.inspector.mount(dom.inspectorBody);
  }

  init();
})(window.Retune);
