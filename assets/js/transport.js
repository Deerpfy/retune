(function (Retune) {
  const LOOKAHEAD = 0.1;
  const TICK_MS = 25;
  const START_PAD = 0.02;
  const MIN_LOOP = 0.05;
  const REDUCED_STEP = 0.25;

  const state = Retune.state;
  const util = Retune.util;
  const model = Retune.model;

  let timer = null;
  let frameHandle = null;
  let playing = false;
  let originContext = 0;
  let originProject = 0;
  let cursor = 0;
  let includeRunning = true;
  let startedAt = 0;
  let active = [];
  let laneGains = new Map();
  let meterCanvas = null;
  let meterData = null;

  function projectAt(contextTime) {
    return originProject + (contextTime - originContext);
  }

  function contextAt(projectTime) {
    return originContext + (projectTime - originProject);
  }

  function loopBounds() {
    const from = Math.min(state.selectionIn, state.selectionOut);
    const to = Math.max(state.selectionIn, state.selectionOut);
    if (!state.loop || to - from < MIN_LOOP) {
      return null;
    }
    return { from: from, to: to };
  }

  function selectionBounds() {
    const from = Math.min(state.selectionIn, state.selectionOut);
    const to = Math.max(state.selectionIn, state.selectionOut);
    return to - from < MIN_LOOP ? null : { from: from, to: to };
  }

  function buildLaneGains(context, destination, laneId) {
    const map = new Map();
    state.lanes.forEach(function (lane) {
      if (laneId && lane.id !== laneId) {
        return;
      }
      const node = context.createGain();
      node.gain.value = model.laneAudible(lane) ? util.dbToGain(lane.gainDb) : 0;
      node.connect(destination);
      map.set(lane.id, node);
    });
    return map;
  }

  function envelopeLevel(relative, duration, fadeIn, fadeOut, peak) {
    if (fadeIn > 0 && relative < fadeIn) {
      return peak * util.clamp(relative / fadeIn, 0, 1);
    }
    if (fadeOut > 0 && relative > duration - fadeOut) {
      return peak * util.clamp((duration - relative) / fadeOut, 0, 1);
    }
    return peak;
  }

  function applyEnvelope(param, start, duration, clip, peak, now) {
    const fadeIn = util.clamp(clip.fadeInSeconds, 0, duration);
    const fadeOut = util.clamp(clip.fadeOutSeconds, 0, duration - fadeIn);
    const begin = Math.max(now, start);
    param.setValueAtTime(envelopeLevel(begin - start, duration, fadeIn, fadeOut, peak), begin);
    if (fadeIn > 0 && begin < start + fadeIn) {
      param.linearRampToValueAtTime(peak, start + fadeIn);
    }
    if (fadeOut > 0) {
      const fadeStart = start + duration - fadeOut;
      if (begin < fadeStart) {
        param.setValueAtTime(peak, fadeStart);
      }
      param.linearRampToValueAtTime(0, start + duration);
    }
  }

  function scheduleClipInto(context, clip, laneGain, when, now) {
    if (clip.muted) {
      return null;
    }
    const playback = Retune.engine.playbackFor(clip);
    if (!playback) {
      Retune.engine.requestRender(clip);
      return null;
    }
    let start = when;
    let offset = playback.offset;
    let duration = playback.duration;
    if (duration <= 0) {
      return null;
    }
    if (start < now) {
      const skip = now - start;
      if (skip >= duration) {
        return null;
      }
      offset += skip * playback.rate;
      duration -= skip;
      start = now;
    }
    const node = context.createBufferSource();
    node.buffer = playback.buffer;
    node.playbackRate.value = playback.rate;
    const gain = context.createGain();
    node.connect(gain);
    gain.connect(laneGain);
    applyEnvelope(gain.gain, when, playback.duration, clip, util.dbToGain(clip.gainDb), now);
    node.start(start, Math.max(0, offset));
    node.stop(start + duration);
    return { node: node, gain: gain };
  }

  function trackVoice(voice) {
    if (!voice) {
      return;
    }
    active.push(voice);
    voice.node.onended = function () {
      voice.node.disconnect();
      voice.gain.disconnect();
      active = active.filter(function (item) {
        return item !== voice;
      });
    };
  }

  function stopVoices() {
    active.forEach(function (voice) {
      voice.node.onended = null;
      try {
        voice.node.stop();
      } catch (error) {
        voice.node.disconnect();
      }
      voice.node.disconnect();
      voice.gain.disconnect();
    });
    active = [];
    laneGains.forEach(function (node) {
      node.disconnect();
    });
    laneGains = new Map();
  }

  function scheduleRange(context, from, to, now) {
    state.clips.forEach(function (clip) {
      const laneGain = laneGains.get(clip.laneId);
      if (!laneGain) {
        return;
      }
      const start = clip.startSeconds;
      const end = model.clipEnd(clip);
      const starts = start >= from && start < to;
      const running = includeRunning && start < from && end > from;
      if (!starts && !running) {
        return;
      }
      trackVoice(scheduleClipInto(context, clip, laneGain, contextAt(start), now));
    });
  }

  function tick() {
    const context = Retune.engine.context();
    const now = context.currentTime;
    const horizon = now + LOOKAHEAD;
    const loop = loopBounds();
    let guard = 0;
    while (contextAt(cursor) < horizon && guard < 16) {
      guard += 1;
      const limit = loop ? loop.to : Infinity;
      const sliceEnd = Math.min(limit, projectAt(horizon));
      if (sliceEnd > cursor) {
        scheduleRange(context, cursor, sliceEnd, now);
        includeRunning = false;
        cursor = sliceEnd;
      }
      if (loop && cursor >= loop.to - 1e-6) {
        const boundary = contextAt(loop.to);
        originContext = boundary;
        originProject = loop.from;
        cursor = loop.from;
        includeRunning = true;
      } else {
        break;
      }
    }
  }

  function drawMeter(level, peak) {
    if (!meterCanvas) {
      return;
    }
    const surface = Retune.waveform.prepareCanvas(meterCanvas);
    surface.context.fillStyle = util.token('--color-meter-track');
    surface.context.fillRect(0, 0, surface.width, surface.height);
    surface.context.fillStyle = util.token('--color-meter');
    surface.context.fillRect(0, 0, surface.width * level, surface.height);
    surface.context.fillStyle = util.token('--color-meter-peak');
    surface.context.fillRect(Math.max(0, surface.width * peak - 2), 0, 2, surface.height);
  }

  function readMeter() {
    const analyser = Retune.engine.meter();
    if (!meterData || meterData.length !== analyser.fftSize) {
      meterData = new Float32Array(analyser.fftSize);
    }
    analyser.getFloatTimeDomainData(meterData);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < meterData.length; i += 1) {
      const value = meterData[i];
      sum += value * value;
      const magnitude = Math.abs(value);
      if (magnitude > peak) {
        peak = magnitude;
      }
    }
    const rms = Math.sqrt(sum / meterData.length);
    const db = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
    drawMeter(util.clamp((db + 60) / 60, 0, 1), util.clamp((peak > 0 ? 20 * Math.log10(peak) : -60) / 60 + 1, 0, 1));
    Retune.bus.emit('meter', { db: db });
  }

  function animate() {
    if (!playing) {
      return;
    }
    const context = Retune.engine.context();
    let position = Math.max(originProject, projectAt(context.currentTime));
    const loop = loopBounds();
    if (loop && position < loop.from) {
      position = loop.to - (loop.from - position);
    }
    if (!loop && position > model.projectDuration()) {
      stop();
      return;
    }
    state.playhead = util.reducedMotion() ? Math.floor(position / REDUCED_STEP) * REDUCED_STEP : position;
    Retune.bus.emit('playhead', { seconds: state.playhead });
    readMeter();
    frameHandle = requestAnimationFrame(animate);
  }

  function beginAt(seconds) {
    const context = Retune.engine.context();
    stopVoices();
    laneGains = buildLaneGains(context, Retune.engine.masterGain(), null);
    originContext = context.currentTime + START_PAD;
    originProject = seconds;
    cursor = seconds;
    includeRunning = true;
    tick();
  }

  async function play() {
    if (playing) {
      return;
    }
    await Retune.engine.resume();
    Retune.bus.emit('progress', { id: 'prepare', label: 'Preparing transforms', value: 0 });
    try {
      await Retune.engine.prepare(state.clips, function (value, name) {
        Retune.bus.emit('progress', { id: 'prepare', label: 'Preparing ' + name, value: value });
      });
    } catch (error) {
      Retune.bus.emit('progress', { id: 'prepare', done: true });
      Retune.bus.emit('status', { kind: 'error', text: 'Playback stopped: ' + error.message + '.' });
      return;
    }
    Retune.bus.emit('progress', { id: 'prepare', done: true });
    const loop = loopBounds();
    let from = state.playhead;
    if (loop && (from < loop.from || from >= loop.to)) {
      from = loop.from;
    }
    startedAt = from;
    playing = true;
    beginAt(from);
    timer = setInterval(tick, TICK_MS);
    frameHandle = requestAnimationFrame(animate);
    Retune.bus.emit('transport', { playing: true });
  }

  function halt() {
    playing = false;
    if (timer !== null) {
      clearInterval(timer);
      timer = null;
    }
    if (frameHandle !== null) {
      cancelAnimationFrame(frameHandle);
      frameHandle = null;
    }
    stopVoices();
    drawMeter(0, 0);
    Retune.bus.emit('meter', { db: -Infinity });
  }

  function pause() {
    if (!playing) {
      return;
    }
    halt();
    Retune.bus.emit('transport', { playing: false });
  }

  function stop() {
    const wasPlaying = playing;
    halt();
    state.playhead = wasPlaying ? startedAt : state.playhead;
    Retune.bus.emit('playhead', { seconds: state.playhead });
    Retune.bus.emit('transport', { playing: false });
  }

  function toStart() {
    state.playhead = 0;
    if (playing) {
      startedAt = 0;
      beginAt(0);
    }
    Retune.bus.emit('playhead', { seconds: 0 });
  }

  function seek(seconds) {
    const position = Math.max(0, seconds);
    state.playhead = position;
    if (playing) {
      startedAt = position;
      beginAt(position);
    }
    Retune.bus.emit('playhead', { seconds: position });
  }

  function toggle() {
    if (playing) {
      pause();
    } else {
      play();
    }
  }

  function reschedule() {
    if (playing) {
      beginAt(state.playhead);
    }
  }

  function isPlaying() {
    return playing;
  }

  function setMeterCanvas(canvas) {
    meterCanvas = canvas;
    drawMeter(0, 0);
  }

  async function renderOffline(from, to, laneId) {
    const rate = Retune.engine.sampleRate();
    const duration = Math.max(0.01, to - from);
    const Constructor = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const context = new Constructor(2, Math.ceil(duration * rate), rate);
    const destination = context.createGain();
    destination.connect(context.destination);
    const gains = buildLaneGains(context, destination, laneId);
    state.clips.forEach(function (clip) {
      const laneGain = gains.get(clip.laneId);
      if (!laneGain) {
        return;
      }
      if (model.clipEnd(clip) <= from || clip.startSeconds >= to) {
        return;
      }
      scheduleClipInto(context, clip, laneGain, clip.startSeconds - from, 0);
    });
    return context.startRendering();
  }

  Retune.transport = {
    play: play,
    pause: pause,
    stop: stop,
    toggle: toggle,
    toStart: toStart,
    seek: seek,
    reschedule: reschedule,
    isPlaying: isPlaying,
    setMeterCanvas: setMeterCanvas,
    selectionBounds: selectionBounds,
    renderOffline: renderOffline
  };
})(window.Retune);
