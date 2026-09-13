(function (Retune) {
  const state = Retune.state;
  const util = Retune.util;
  const model = Retune.model;

  const MIN_PPS = 8;
  const MAX_PPS = 400;
  const MIN_TRIM = 0.01;
  const DRAG_THRESHOLD = 4;
  const TAIL_SECONDS = 4;
  const SECOND_STEPS = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];

  let canvas = null;
  let stage = null;
  let scroller = null;
  let headers = null;
  let playheadElement = null;
  let drag = null;
  let ghost = null;
  let redrawQueued = false;
  let lastPointerType = 'mouse';

  function px(name) {
    return util.tokenNumber(name);
  }

  function rulerHeight() {
    return px('--ruler-height');
  }

  function laneHeight() {
    return px('--lane-height');
  }

  function timeToX(seconds) {
    return seconds * state.pixelsPerSecond;
  }

  function xToTime(x) {
    return Math.max(0, x / state.pixelsPerSecond);
  }

  function stageWidth() {
    const needed = (model.projectDuration() + TAIL_SECONDS) * state.pixelsPerSecond;
    return Math.max(scroller ? scroller.clientWidth : 0, Math.ceil(needed));
  }

  function stageHeight() {
    return rulerHeight() + state.lanes.length * laneHeight();
  }

  function pointerPosition(event) {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }

  function laneIndexAt(y) {
    const index = Math.floor((y - rulerHeight()) / laneHeight());
    return util.clamp(index, 0, state.lanes.length - 1);
  }

  function clipAt(time, index) {
    const lane = state.lanes[index];
    if (!lane) {
      return null;
    }
    return model.laneClips(lane.id).find(function (clip) {
      return time >= clip.startSeconds && time <= model.clipEnd(clip);
    }) || null;
  }

  function transformSummary(clip) {
    const parts = [];
    if (clip.tempoPercent !== 100) {
      parts.push(clip.targetBpm > 0 ? clip.targetBpm.toFixed(1) + ' BPM' : util.round(clip.tempoPercent, 1) + '%');
    }
    const semitones = clip.linkPitchToTempo
      ? util.ratioToSemitones(model.tempoRatio(clip))
      : clip.pitchSemitones + clip.pitchCents / 100;
    if (Math.abs(semitones) > 0.005) {
      parts.push((semitones > 0 ? '+' : '') + util.round(semitones, 2) + ' st');
    }
    if (clip.linkPitchToTempo) {
      parts.push('linked');
    }
    return parts.join(', ');
  }

  function drawRuler(context, width) {
    const height = rulerHeight();
    const pad = px('--space-1');
    const hair = px('--line-width');
    const density = px('--space-7');
    context.fillStyle = util.token('--color-surface');
    context.fillRect(0, 0, width, height);
    context.fillStyle = util.token('--color-grid-strong');
    context.fillRect(0, height - hair, width, hair);
    context.font = util.token('--type-xs') + ' ' + util.token('--font-system');
    context.textBaseline = 'middle';
    if (state.rulerMode === 'bars') {
      const beat = util.beatSeconds(state.projectBpm);
      const barPixels = beat * 4 * state.pixelsPerSecond;
      const everyBars = Math.max(1, Math.ceil(density / Math.max(1, barPixels)));
      const beats = Math.ceil(width / (beat * state.pixelsPerSecond)) + 1;
      for (let i = 0; i < beats; i += 1) {
        const x = Math.round(timeToX(i * beat));
        const isBar = i % 4 === 0;
        context.fillStyle = util.token(isBar ? '--color-grid-strong' : '--color-grid');
        context.fillRect(x, isBar ? height * 0.35 : height * 0.65, hair, height);
        if (isBar && (i / 4) % everyBars === 0) {
          context.fillStyle = util.token('--color-ruler-ink');
          context.fillText(String(i / 4 + 1), x + pad, height * 0.35);
        }
      }
      context.fillStyle = util.token('--color-ruler-ink');
      context.fillText('bars', pad, height * 0.75);
      return;
    }
    const step = SECOND_STEPS.find(function (candidate) {
      return candidate * state.pixelsPerSecond >= density;
    }) || SECOND_STEPS[SECOND_STEPS.length - 1];
    const ticks = Math.ceil(width / (step * state.pixelsPerSecond)) + 1;
    for (let i = 0; i < ticks; i += 1) {
      const x = Math.round(timeToX(i * step));
      context.fillStyle = util.token('--color-grid-strong');
      context.fillRect(x, height * 0.35, hair, height);
      context.fillStyle = util.token('--color-ruler-ink');
      context.fillText(util.formatSeconds(i * step), x + pad, height * 0.35);
    }
    context.fillText('m:ss', pad, height * 0.75);
  }

  function drawGrid(context, width, height) {
    const top = rulerHeight();
    const hair = px('--line-width');
    const beat = util.beatSeconds(state.projectBpm);
    const beatPixels = beat * state.pixelsPerSecond;
    if (beatPixels < px('--space-2')) {
      return;
    }
    const beats = Math.ceil(width / beatPixels) + 1;
    for (let i = 0; i < beats; i += 1) {
      const x = Math.round(timeToX(i * beat));
      context.fillStyle = util.token(i % 4 === 0 ? '--color-grid-strong' : '--color-grid');
      context.fillRect(x, top, hair, height - top);
    }
  }

  function drawSelection(context, height) {
    const from = Math.min(state.selectionIn, state.selectionOut);
    const to = Math.max(state.selectionIn, state.selectionOut);
    const top = rulerHeight();
    const mark = px('--line-width-strong');
    if (to - from > 0) {
      context.fillStyle = util.token('--color-accent-wash');
      context.fillRect(timeToX(from), top, timeToX(to - from), height - top);
      context.fillStyle = util.token('--color-marker');
      [from, to].forEach(function (time) {
        context.fillRect(Math.round(timeToX(time)), 0, mark, height);
      });
    }
  }

  function drawClip(context, clip, index) {
    const source = model.getSource(clip.sourceId);
    const inset = px('--line-width-strong');
    const pad = px('--space-1');
    const top = rulerHeight() + index * laneHeight() + inset;
    const height = laneHeight() - inset * 2;
    const x = timeToX(clip.startSeconds);
    const width = Math.max(pad, timeToX(model.clipDuration(clip)));
    const ready = Retune.engine.playbackFor(clip) !== null;
    const selected = state.selectedClipId === clip.id;
    context.save();
    context.beginPath();
    context.rect(x, top, width, height);
    context.clip();
    context.fillStyle = util.token(ready ? (selected ? '--color-clip-selected' : '--color-clip') : '--color-clip-pending');
    context.fillRect(x, top, width, height);
    if (source && source.peaks && ready) {
      const rate = source.buffer.sampleRate;
      Retune.waveform.drawBand(
        context,
        source.peaks[0],
        source.bucketCount,
        Retune.waveform.bucketFor(clip.trimInSeconds, rate),
        Retune.waveform.bucketFor(clip.trimOutSeconds, rate),
        x,
        top,
        Math.ceil(width),
        height,
        util.token('--color-clip-wave')
      );
    }
    context.fillStyle = util.token('--color-ink');
    context.font = '600 ' + util.token('--type-xs') + ' ' + util.token('--font-system');
    context.textBaseline = 'top';
    context.fillText(source ? source.name : 'Missing source', x + pad, top + pad);
    const summary = source && source.buffer ? transformSummary(clip) : 'file not loaded';
    if (summary) {
      context.fillStyle = util.token('--color-ink-muted');
      context.font = util.token('--type-xs') + ' ' + util.token('--font-mono');
      context.fillText(summary, x + pad, top + pad + px('--type-xs') * 1.4);
    }
    context.restore();
    context.strokeStyle = util.token(ready ? '--color-clip-edge' : '--color-clip-pending-edge');
    context.lineWidth = selected ? px('--line-width-strong') : px('--line-width');
    context.strokeRect(x + 0.5, top + 0.5, width - 1, height - 1);
  }

  function drawGhost(context) {
    if (!ghost) {
      return;
    }
    const inset = px('--line-width-strong');
    const top = rulerHeight() + ghost.index * laneHeight() + inset;
    context.save();
    context.setLineDash([px('--space-2'), px('--space-1')]);
    context.strokeStyle = util.token('--color-accent');
    context.lineWidth = inset;
    context.strokeRect(timeToX(ghost.time), top, Math.max(px('--space-3'), timeToX(ghost.duration)), laneHeight() - inset * 2);
    context.restore();
  }

  function paint() {
    if (!canvas) {
      return;
    }
    const width = stageWidth();
    const height = stageHeight();
    const hair = px('--line-width');
    canvas.style.width = width + 'px';
    canvas.style.height = height + 'px';
    stage.style.width = width + 'px';
    stage.style.height = height + 'px';
    const surface = Retune.waveform.prepareCanvas(canvas);
    const context = surface.context;
    state.lanes.forEach(function (lane, index) {
      context.fillStyle = util.token(index % 2 === 0 ? '--color-lane-odd' : '--color-lane-even');
      context.fillRect(0, rulerHeight() + index * laneHeight(), width, laneHeight());
      context.fillStyle = util.token('--color-grid');
      context.fillRect(0, rulerHeight() + (index + 1) * laneHeight() - hair, width, hair);
    });
    drawSelection(context, height);
    drawGrid(context, width, height);
    state.clips.forEach(function (clip) {
      const index = model.laneIndex(clip.laneId);
      if (index >= 0) {
        drawClip(context, clip, index);
      }
    });
    drawGhost(context);
    drawRuler(context, width);
    movePlayhead(state.playhead);
  }

  function redraw() {
    if (redrawQueued) {
      return;
    }
    redrawQueued = true;
    requestAnimationFrame(function () {
      redrawQueued = false;
      paint();
    });
  }

  function movePlayhead(seconds) {
    if (!playheadElement) {
      return;
    }
    playheadElement.style.transform = 'translateX(' + timeToX(seconds) + 'px)';
  }

  function renderHeaders() {
    if (!headers) {
      return;
    }
    headers.textContent = '';
    const spacer = document.createElement('div');
    spacer.className = 'lane-headers-spacer';
    headers.appendChild(spacer);
    state.lanes.forEach(function (lane) {
      const row = document.createElement('div');
      row.className = 'lane-header' + (state.selectedLaneId === lane.id ? ' is-selected' : '');
      const select = document.createElement('button');
      select.type = 'button';
      select.className = 'lane-select';
      select.setAttribute('aria-pressed', String(state.selectedLaneId === lane.id));
      const name = document.createElement('span');
      name.className = 'lane-header-name';
      name.textContent = lane.name;
      select.appendChild(name);
      select.addEventListener('click', function () {
        state.selectedLaneId = lane.id;
        state.selectedClipId = null;
        Retune.bus.emit('selection', {});
      });
      const toggles = document.createElement('div');
      toggles.className = 'lane-toggles';
      toggles.appendChild(Retune.icons.button({
        label: 'M',
        title: 'Mute ' + lane.name,
        className: 'btn-small',
        pressed: lane.muted,
        onClick: function () {
          lane.muted = !lane.muted;
          Retune.transport.reschedule();
          Retune.bus.emit('project', {});
        }
      }));
      toggles.appendChild(Retune.icons.button({
        label: 'S',
        title: 'Solo ' + lane.name,
        className: 'btn-small',
        pressed: lane.soloed,
        onClick: function () {
          lane.soloed = !lane.soloed;
          Retune.transport.reschedule();
          Retune.bus.emit('project', {});
        }
      }));
      row.appendChild(select);
      row.appendChild(toggles);
      headers.appendChild(row);
    });
  }

  function commit() {
    Retune.bus.emit('project', {});
  }

  function addClip(sourceId, laneId, startSeconds) {
    const source = model.getSource(sourceId);
    if (!source) {
      return null;
    }
    const clip = model.createClip(sourceId, laneId, startSeconds, source.duration);
    model.syncTargetBpm(clip);
    state.clips.push(clip);
    model.normalizeLane(laneId, clip.id);
    state.selectedClipId = clip.id;
    state.selectedLaneId = null;
    Retune.bus.emit('selection', {});
    commit();
    return clip;
  }

  function addAtPlayhead(sourceId) {
    const laneId = state.selectedLaneId || (state.lanes[0] && state.lanes[0].id);
    if (!laneId) {
      return;
    }
    addClip(sourceId, laneId, model.snapTime(state.playhead));
  }

  function selectAt(position) {
    const index = laneIndexAt(position.y);
    const clip = clipAt(xToTime(position.x), index);
    if (clip) {
      state.selectedClipId = clip.id;
      state.selectedLaneId = null;
    } else {
      state.selectedClipId = null;
      state.selectedLaneId = state.lanes[index] ? state.lanes[index].id : null;
    }
    Retune.bus.emit('selection', {});
    redraw();
    return clip;
  }

  function beginRulerDrag(position) {
    const time = model.snapTime(xToTime(position.x));
    drag = { kind: 'ruler', startX: position.x, startTime: time, moved: false };
    Retune.transport.seek(time);
  }

  function beginClipDrag(position) {
    const clip = selectAt(position);
    if (!clip) {
      return;
    }
    const time = xToTime(position.x);
    const grab = px('--clip-edge-grab') / state.pixelsPerSecond;
    const end = model.clipEnd(clip);
    let kind = 'move';
    if (time - clip.startSeconds < grab) {
      kind = 'trim-start';
    } else if (end - time < grab) {
      kind = 'trim-end';
    }
    drag = {
      kind: kind,
      clipId: clip.id,
      offset: time - clip.startSeconds,
      startTime: time,
      trimIn: clip.trimInSeconds,
      trimOut: clip.trimOutSeconds,
      startSeconds: clip.startSeconds
    };
  }

  function updateDrag(position) {
    if (!drag) {
      return;
    }
    const time = xToTime(position.x);
    if (drag.kind === 'ruler') {
      if (!drag.moved && Math.abs(position.x - drag.startX) < DRAG_THRESHOLD) {
        Retune.transport.seek(model.snapTime(time));
        return;
      }
      drag.moved = true;
      state.selectionIn = drag.startTime;
      state.selectionOut = model.snapTime(time);
      Retune.bus.emit('selection', {});
      redraw();
      return;
    }
    const clip = model.getClip(drag.clipId);
    if (!clip) {
      return;
    }
    const source = model.getSource(clip.sourceId);
    const ratio = model.tempoRatio(clip);
    if (drag.kind === 'move') {
      clip.startSeconds = model.snapTime(time - drag.offset);
      const lane = state.lanes[laneIndexAt(position.y)];
      if (lane && lane.id !== clip.laneId) {
        clip.laneId = lane.id;
      }
    } else if (drag.kind === 'trim-start') {
      const delta = (time - drag.startTime) * ratio;
      const trimIn = util.clamp(drag.trimIn + delta, 0, drag.trimOut - MIN_TRIM);
      clip.trimInSeconds = trimIn;
      clip.startSeconds = Math.max(0, drag.startSeconds + (trimIn - drag.trimIn) / ratio);
    } else {
      const delta = (time - drag.startTime) * ratio;
      const maximum = source ? source.duration : drag.trimOut;
      clip.trimOutSeconds = util.clamp(drag.trimOut + delta, clip.trimInSeconds + MIN_TRIM, maximum);
    }
    redraw();
  }

  function endDrag() {
    if (!drag) {
      return;
    }
    if (drag.clipId) {
      const clip = model.getClip(drag.clipId);
      if (clip) {
        model.normalizeLane(clip.laneId, clip.id);
      }
      Retune.transport.reschedule();
      commit();
    }
    drag = null;
  }

  function onPointerDown(event) {
    lastPointerType = event.pointerType;
    if (event.pointerType === 'touch') {
      return;
    }
    if (event.button !== 0) {
      return;
    }
    canvas.focus();
    canvas.setPointerCapture(event.pointerId);
    const position = pointerPosition(event);
    if (position.y < rulerHeight()) {
      beginRulerDrag(position);
    } else {
      beginClipDrag(position);
    }
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!drag) {
      return;
    }
    updateDrag(pointerPosition(event));
    event.preventDefault();
  }

  function onPointerUp(event) {
    if (canvas.hasPointerCapture(event.pointerId)) {
      canvas.releasePointerCapture(event.pointerId);
    }
    endDrag();
  }

  function onClick(event) {
    if (lastPointerType !== 'touch') {
      return;
    }
    const position = pointerPosition(event);
    if (position.y < rulerHeight()) {
      Retune.transport.seek(model.snapTime(xToTime(position.x)));
      return;
    }
    selectAt(position);
  }

  function nudge(seconds) {
    const clip = model.getClip(state.selectedClipId);
    if (!clip) {
      return;
    }
    clip.startSeconds = Math.max(0, clip.startSeconds + seconds);
    model.normalizeLane(clip.laneId, clip.id);
    Retune.transport.reschedule();
    commit();
  }

  function moveLane(direction) {
    const clip = model.getClip(state.selectedClipId);
    if (!clip) {
      return;
    }
    const lane = state.lanes[model.laneIndex(clip.laneId) + direction];
    if (!lane) {
      return;
    }
    clip.laneId = lane.id;
    model.normalizeLane(lane.id, clip.id);
    Retune.transport.reschedule();
    commit();
  }

  function removeSelectedClip() {
    if (!state.selectedClipId) {
      return;
    }
    model.removeClip(state.selectedClipId);
    Retune.transport.reschedule();
    Retune.bus.emit('selection', {});
    commit();
  }

  function onKeyDown(event) {
    const unit = model.snapSeconds() || 0.1;
    if (event.key === 'ArrowLeft') {
      nudge(-unit);
    } else if (event.key === 'ArrowRight') {
      nudge(unit);
    } else if (event.key === 'ArrowUp') {
      moveLane(-1);
    } else if (event.key === 'ArrowDown') {
      moveLane(1);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      removeSelectedClip();
    } else {
      return;
    }
    event.preventDefault();
  }

  function zoomBy(factor) {
    state.pixelsPerSecond = util.clamp(state.pixelsPerSecond * factor, MIN_PPS, MAX_PPS);
    redraw();
  }

  function fit() {
    const duration = model.projectDuration();
    if (duration <= 0 || !scroller) {
      return;
    }
    state.pixelsPerSecond = util.clamp(scroller.clientWidth / (duration + 1), MIN_PPS, MAX_PPS);
    redraw();
  }

  function insideCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
  }

  function updateSourceDrag(sourceId, clientX, clientY) {
    if (!insideCanvas(clientX, clientY)) {
      if (ghost) {
        ghost = null;
        redraw();
      }
      return;
    }
    const source = model.getSource(sourceId);
    const rect = canvas.getBoundingClientRect();
    ghost = {
      time: model.snapTime(xToTime(clientX - rect.left)),
      index: laneIndexAt(clientY - rect.top),
      duration: source ? source.duration : 1
    };
    redraw();
  }

  function endSourceDrag(sourceId, clientX, clientY) {
    const target = ghost;
    ghost = null;
    if (!target || !insideCanvas(clientX, clientY)) {
      redraw();
      return;
    }
    const lane = state.lanes[target.index];
    if (lane) {
      addClip(sourceId, lane.id, target.time);
    }
  }

  function mount(elements) {
    canvas = elements.canvas;
    stage = elements.stage;
    scroller = elements.scroller;
    headers = elements.headers;
    playheadElement = elements.playhead;
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('pointercancel', onPointerUp);
    canvas.addEventListener('click', onClick);
    canvas.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', redraw);
    Retune.bus.on('playhead', function (payload) {
      movePlayhead(payload.seconds);
    });
    Retune.bus.on('render', redraw);
    renderHeaders();
    redraw();
  }

  Retune.timeline = {
    mount: mount,
    redraw: redraw,
    renderHeaders: renderHeaders,
    addClip: addClip,
    addAtPlayhead: addAtPlayhead,
    moveLane: moveLane,
    nudge: nudge,
    removeSelectedClip: removeSelectedClip,
    zoomBy: zoomBy,
    fit: fit,
    updateSourceDrag: updateSourceDrag,
    endSourceDrag: endSourceDrag
  };
})(window.Retune);
