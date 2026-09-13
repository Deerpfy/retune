(function (Retune) {
  const state = Retune.state;
  const util = Retune.util;
  const model = Retune.model;

  const RENDER_DELAY = 260;

  let host = null;
  let refreshers = [];
  let renderTimer = null;

  function scheduleRender(clip) {
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
    }
    renderTimer = setTimeout(function () {
      renderTimer = null;
      Retune.engine.requestRender(clip);
      Retune.transport.reschedule();
    }, RENDER_DELAY);
  }

  function changed(clip) {
    model.normalizeLane(clip.laneId, clip.id);
    scheduleRender(clip);
    Retune.bus.emit('project', {});
  }

  function labelled(labelText, control) {
    const wrap = document.createElement('label');
    wrap.className = 'field';
    const caption = document.createElement('span');
    caption.textContent = labelText;
    wrap.appendChild(caption);
    wrap.appendChild(control);
    return wrap;
  }

  function numberField(options) {
    const input = document.createElement('input');
    input.type = 'number';
    input.inputMode = 'decimal';
    input.step = String(options.step);
    if (options.min !== undefined) {
      input.min = String(options.min);
    }
    if (options.max !== undefined) {
      input.max = String(options.max);
    }
    input.value = String(util.round(options.value(), options.decimals));
    input.addEventListener('change', function () {
      const parsed = parseFloat(input.value);
      if (Number.isFinite(parsed)) {
        options.apply(parsed);
      }
      Retune.bus.emit('selection-refresh', {});
    });
    if (options.disabled) {
      input.disabled = true;
    }
    refreshers.push(function () {
      if (document.activeElement !== input) {
        input.value = String(util.round(options.value(), options.decimals));
      }
    });
    return labelled(options.label, input);
  }

  function rangeField(options) {
    const input = document.createElement('input');
    input.type = 'range';
    input.className = 'slider';
    input.min = String(options.min);
    input.max = String(options.max);
    input.step = String(options.step);
    input.value = String(options.value());
    input.setAttribute('aria-label', options.label);
    input.addEventListener('input', function () {
      options.apply(parseFloat(input.value));
    });
    refreshers.push(function () {
      if (document.activeElement !== input) {
        input.value = String(util.clamp(options.value(), options.min, options.max));
      }
    });
    return input;
  }

  function group(labelText) {
    const element = document.createElement('div');
    element.className = 'group';
    const caption = document.createElement('p');
    caption.className = 'group-label';
    caption.textContent = labelText;
    element.appendChild(caption);
    return element;
  }

  function readout(build) {
    const element = document.createElement('p');
    element.className = 'inspector-readout';
    element.textContent = build();
    refreshers.push(function () {
      element.textContent = build();
    });
    return element;
  }

  function buildClip(clip) {
    const source = model.getSource(clip.sourceId);
    const title = document.createElement('p');
    title.className = 'inspector-title';
    title.textContent = source ? source.name : 'Missing source';
    host.appendChild(title);
    host.appendChild(readout(function () {
      return 'Length ' + util.formatSeconds(model.clipDuration(clip)) + ' at ' + util.round(clip.tempoPercent, 1) + '%';
    }));

    const tempo = group('Tempo');
    const bpm = model.sourceBpm(source);
    tempo.appendChild(readout(function () {
      const current = model.sourceBpm(model.getSource(clip.sourceId));
      if (current <= 0) {
        return 'Source BPM unknown, use the percentage';
      }
      return 'Source ' + current.toFixed(1) + ' BPM';
    }));
    tempo.appendChild(numberField({
      label: 'Target BPM',
      value: function () {
        return clip.targetBpm;
      },
      apply: function (value) {
        model.setTargetBpm(clip, value);
        changed(clip);
      },
      step: 0.1,
      decimals: 2,
      disabled: bpm <= 0
    }));
    tempo.appendChild(numberField({
      label: 'Tempo percent',
      value: function () {
        return clip.tempoPercent;
      },
      apply: function (value) {
        model.setTempoPercent(clip, value);
        changed(clip);
      },
      step: 0.1,
      decimals: 2
    }));
    tempo.appendChild(rangeField({
      label: 'Tempo percent slider',
      min: 50,
      max: 200,
      step: 0.5,
      value: function () {
        return clip.tempoPercent;
      },
      apply: function (value) {
        model.setTempoPercent(clip, value);
        changed(clip);
      }
    }));
    const link = Retune.icons.button({
      label: 'Link pitch to tempo',
      pressed: clip.linkPitchToTempo,
      onClick: function () {
        clip.linkPitchToTempo = !clip.linkPitchToTempo;
        link.setAttribute('aria-pressed', String(clip.linkPitchToTempo));
        changed(clip);
        Retune.bus.emit('selection', {});
      }
    });
    tempo.appendChild(link);
    host.appendChild(tempo);

    const pitch = group('Pitch');
    if (clip.linkPitchToTempo) {
      pitch.appendChild(readout(function () {
        return 'Linked: ' + util.round(util.ratioToSemitones(model.tempoRatio(clip)), 2) + ' semitones';
      }));
    } else {
      pitch.appendChild(numberField({
        label: 'Semitones',
        value: function () {
          return clip.pitchSemitones;
        },
        apply: function (value) {
          clip.pitchSemitones = value;
          changed(clip);
        },
        step: 1,
        decimals: 2
      }));
      pitch.appendChild(rangeField({
        label: 'Semitones slider',
        min: -12,
        max: 12,
        step: 1,
        value: function () {
          return clip.pitchSemitones;
        },
        apply: function (value) {
          clip.pitchSemitones = value;
          changed(clip);
        }
      }));
    }
    host.appendChild(pitch);

    const position = group('Position');
    position.appendChild(numberField({
      label: 'Start (s)',
      value: function () {
        return clip.startSeconds;
      },
      apply: function (value) {
        clip.startSeconds = Math.max(0, value);
        changed(clip);
      },
      min: 0,
      step: 0.01,
      decimals: 3
    }));
    position.appendChild(numberField({
      label: 'Trim in (source s)',
      value: function () {
        return clip.trimInSeconds;
      },
      apply: function (value) {
        clip.trimInSeconds = util.clamp(value, 0, clip.trimOutSeconds - 0.01);
        changed(clip);
      },
      min: 0,
      step: 0.01,
      decimals: 3
    }));
    position.appendChild(numberField({
      label: 'Trim out (source s)',
      value: function () {
        return clip.trimOutSeconds;
      },
      apply: function (value) {
        clip.trimOutSeconds = util.clamp(value, clip.trimInSeconds + 0.01, source ? source.duration : value);
        changed(clip);
      },
      min: 0,
      step: 0.01,
      decimals: 3
    }));
    const lanePicker = document.createElement('select');
    state.lanes.forEach(function (lane) {
      const option = document.createElement('option');
      option.value = lane.id;
      option.textContent = lane.name;
      option.selected = lane.id === clip.laneId;
      lanePicker.appendChild(option);
    });
    lanePicker.addEventListener('change', function () {
      clip.laneId = lanePicker.value;
      changed(clip);
    });
    position.appendChild(labelled('Lane', lanePicker));
    const laneButtons = document.createElement('div');
    laneButtons.className = 'row';
    laneButtons.appendChild(Retune.icons.button({
      icon: 'arrow-up',
      label: 'Move lane up',
      onClick: function () {
        Retune.timeline.moveLane(-1);
        Retune.bus.emit('selection', {});
      }
    }));
    laneButtons.appendChild(Retune.icons.button({
      icon: 'arrow-down',
      label: 'Move lane down',
      onClick: function () {
        Retune.timeline.moveLane(1);
        Retune.bus.emit('selection', {});
      }
    }));
    position.appendChild(laneButtons);
    host.appendChild(position);

    const details = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = 'Gain, fades and cents';
    details.appendChild(summary);
    details.appendChild(numberField({
      label: 'Gain (dB)',
      value: function () {
        return clip.gainDb;
      },
      apply: function (value) {
        clip.gainDb = util.clamp(value, -60, 12);
        changed(clip);
      },
      min: -60,
      max: 12,
      step: 0.5,
      decimals: 2
    }));
    details.appendChild(numberField({
      label: 'Fade in (s)',
      value: function () {
        return clip.fadeInSeconds;
      },
      apply: function (value) {
        clip.fadeInSeconds = Math.max(0, value);
        changed(clip);
      },
      min: 0,
      step: 0.05,
      decimals: 3
    }));
    details.appendChild(numberField({
      label: 'Fade out (s)',
      value: function () {
        return clip.fadeOutSeconds;
      },
      apply: function (value) {
        clip.fadeOutSeconds = Math.max(0, value);
        changed(clip);
      },
      min: 0,
      step: 0.05,
      decimals: 3
    }));
    if (!clip.linkPitchToTempo) {
      details.appendChild(numberField({
        label: 'Cents',
        value: function () {
          return clip.pitchCents;
        },
        apply: function (value) {
          clip.pitchCents = util.clamp(value, -100, 100);
          changed(clip);
        },
        min: -100,
        max: 100,
        step: 1,
        decimals: 1
      }));
    }
    host.appendChild(details);

    const actions = document.createElement('div');
    actions.className = 'row';
    const mute = Retune.icons.button({
      label: 'Mute clip',
      pressed: clip.muted,
      onClick: function () {
        clip.muted = !clip.muted;
        mute.setAttribute('aria-pressed', String(clip.muted));
        Retune.transport.reschedule();
        Retune.bus.emit('project', {});
      }
    });
    actions.appendChild(mute);
    actions.appendChild(Retune.icons.button({
      icon: 'trash-can',
      label: 'Delete clip',
      className: 'btn-danger',
      onClick: function () {
        Retune.timeline.removeSelectedClip();
      }
    }));
    host.appendChild(actions);
  }

  function buildLane(lane) {
    const title = document.createElement('p');
    title.className = 'inspector-title';
    title.textContent = lane.name;
    host.appendChild(title);
    const name = document.createElement('input');
    name.type = 'text';
    name.value = lane.name;
    name.addEventListener('change', function () {
      lane.name = name.value.trim() || lane.name;
      title.textContent = lane.name;
      Retune.bus.emit('project', {});
    });
    host.appendChild(labelled('Lane name', name));
    host.appendChild(numberField({
      label: 'Lane gain (dB)',
      value: function () {
        return lane.gainDb;
      },
      apply: function (value) {
        lane.gainDb = util.clamp(value, -60, 12);
        Retune.transport.reschedule();
        Retune.bus.emit('project', {});
      },
      min: -60,
      max: 12,
      step: 0.5,
      decimals: 2
    }));
    const actions = document.createElement('div');
    actions.className = 'row';
    actions.appendChild(Retune.icons.button({
      icon: 'trash-can',
      label: 'Delete lane',
      className: 'btn-danger',
      onClick: function () {
        if (!model.removeLane(lane.id)) {
          Retune.bus.emit('status', { kind: 'error', text: 'The last lane cannot be deleted.' });
          return;
        }
        Retune.transport.reschedule();
        Retune.bus.emit('selection', {});
        Retune.bus.emit('project', {});
      }
    }));
    host.appendChild(actions);
  }

  function build() {
    refreshers = [];
    host.textContent = '';
    const clip = model.getClip(state.selectedClipId);
    if (clip) {
      buildClip(clip);
      return;
    }
    const lane = model.getLane(state.selectedLaneId);
    if (lane) {
      buildLane(lane);
      return;
    }
    const empty = document.createElement('p');
    empty.className = 'inspector-empty';
    empty.textContent = 'Select a clip on the timeline to change its tempo, pitch, position and fades.';
    host.appendChild(empty);
  }

  function refresh() {
    refreshers.forEach(function (fn) {
      fn();
    });
  }

  function mount(element) {
    host = element;
    Retune.bus.on('selection', build);
    Retune.bus.on('project', refresh);
    Retune.bus.on('selection-refresh', refresh);
    build();
  }

  Retune.inspector = {
    mount: mount
  };
})(window.Retune);
