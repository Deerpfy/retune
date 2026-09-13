(function (Retune) {
  const CACHE_BUDGET = 256 * 1024 * 1024;

  let context = null;
  let master = null;
  let analyser = null;
  let cacheBytes = 0;
  const cache = new Map();
  const inflight = new Map();

  function ensureContext() {
    if (!context) {
      const Constructor = window.AudioContext || window.webkitAudioContext;
      context = new Constructor();
    }
    return context;
  }

  function resume() {
    const active = ensureContext();
    if (active.state === 'suspended') {
      return active.resume();
    }
    return Promise.resolve();
  }

  function masterGain() {
    const active = ensureContext();
    if (!master) {
      master = active.createGain();
      analyser = active.createAnalyser();
      analyser.fftSize = 2048;
      master.connect(analyser);
      analyser.connect(active.destination);
    }
    return master;
  }

  function meter() {
    masterGain();
    return analyser;
  }

  function sampleRate() {
    return ensureContext().sampleRate;
  }

  function decode(arrayBuffer) {
    const active = ensureContext();
    return new Promise(function (resolve, reject) {
      const result = active.decodeAudioData(arrayBuffer, resolve, reject);
      if (result && typeof result.then === 'function') {
        result.then(resolve, reject);
      }
    });
  }

  function keyFor(sourceId, tempoRatio, pitchRatio) {
    return sourceId + '|' + tempoRatio.toFixed(4) + '|' + pitchRatio.toFixed(4);
  }

  function touch(key) {
    const entry = cache.get(key);
    if (!entry) {
      return null;
    }
    cache.delete(key);
    cache.set(key, entry);
    return entry;
  }

  function evict() {
    while (cacheBytes > CACHE_BUDGET && cache.size > 0) {
      const oldest = cache.keys().next().value;
      const entry = cache.get(oldest);
      cache.delete(oldest);
      cacheBytes -= entry.bytes;
    }
  }

  function store(key, buffer) {
    const bytes = buffer.length * buffer.numberOfChannels * 4;
    cache.set(key, { buffer: buffer, bytes: bytes });
    cacheBytes += bytes;
    evict();
  }

  function clearForSource(sourceId) {
    const prefix = sourceId + '|';
    Array.from(cache.keys()).forEach(function (key) {
      if (key.indexOf(prefix) === 0) {
        cacheBytes -= cache.get(key).bytes;
        cache.delete(key);
      }
    });
  }

  function toAudioBuffer(channels, rate) {
    const active = ensureContext();
    const buffer = active.createBuffer(channels.length, Math.max(1, channels[0].length), rate);
    for (let c = 0; c < channels.length; c += 1) {
      buffer.copyToChannel(channels[c], c, 0);
    }
    return buffer;
  }

  function renderTransformed(source, tempoRatio, pitchRatio, onProgress) {
    const key = keyFor(source.id, tempoRatio, pitchRatio);
    const cached = touch(key);
    if (cached) {
      return Promise.resolve(cached.buffer);
    }
    if (inflight.has(key)) {
      return inflight.get(key);
    }
    const channels = [];
    for (let c = 0; c < source.buffer.numberOfChannels; c += 1) {
      channels.push(source.buffer.getChannelData(c));
    }
    const task = Retune.dsp
      .renderTransform(channels, source.buffer.sampleRate, tempoRatio, pitchRatio, onProgress)
      .then(function (result) {
        const buffer = toAudioBuffer(result, source.buffer.sampleRate);
        store(key, buffer);
        inflight.delete(key);
        return buffer;
      })
      .catch(function (error) {
        inflight.delete(key);
        throw error;
      });
    inflight.set(key, task);
    return task;
  }

  function transformOf(clip) {
    return {
      tempo: Retune.model.tempoRatio(clip),
      pitch: Retune.model.pitchRatio(clip)
    };
  }

  function playbackFor(clip) {
    const source = Retune.model.getSource(clip.sourceId);
    if (!source || !source.buffer) {
      return null;
    }
    const transform = transformOf(clip);
    const trim = Math.max(0, clip.trimOutSeconds - clip.trimInSeconds);
    if (trim <= 0) {
      return null;
    }
    if (clip.linkPitchToTempo) {
      return {
        buffer: source.buffer,
        rate: transform.tempo,
        offset: clip.trimInSeconds,
        duration: trim / transform.tempo
      };
    }
    if (!Retune.dsp.needsRender(transform.tempo, transform.pitch)) {
      return {
        buffer: source.buffer,
        rate: 1,
        offset: clip.trimInSeconds,
        duration: trim
      };
    }
    const entry = touch(keyFor(source.id, transform.tempo, transform.pitch));
    if (!entry) {
      return null;
    }
    return {
      buffer: entry.buffer,
      rate: 1,
      offset: clip.trimInSeconds / transform.tempo,
      duration: trim / transform.tempo
    };
  }

  function requestRender(clip) {
    const source = Retune.model.getSource(clip.sourceId);
    if (!source || !source.buffer || clip.linkPitchToTempo) {
      return;
    }
    const transform = transformOf(clip);
    if (!Retune.dsp.needsRender(transform.tempo, transform.pitch)) {
      return;
    }
    const key = keyFor(source.id, transform.tempo, transform.pitch);
    if (cache.has(key) || inflight.has(key)) {
      return;
    }
    Retune.bus.emit('progress', { id: key, label: 'Rendering ' + source.name, value: 0 });
    renderTransformed(source, transform.tempo, transform.pitch, function (value) {
      Retune.bus.emit('progress', { id: key, label: 'Rendering ' + source.name, value: value });
    }).then(function () {
      Retune.bus.emit('progress', { id: key, done: true });
      Retune.bus.emit('render', { sourceId: source.id });
    }, function (error) {
      Retune.bus.emit('progress', { id: key, done: true });
      Retune.bus.emit('status', {
        kind: 'error',
        text: 'Transform of ' + source.name + ' failed: ' + error.message + '.'
      });
    });
  }

  async function prepare(clips, onProgress) {
    const report = onProgress || function () {};
    const jobs = [];
    const seen = new Set();
    clips.forEach(function (clip) {
      const source = Retune.model.getSource(clip.sourceId);
      if (!source || !source.buffer || clip.linkPitchToTempo) {
        return;
      }
      const transform = transformOf(clip);
      if (!Retune.dsp.needsRender(transform.tempo, transform.pitch)) {
        return;
      }
      const key = keyFor(source.id, transform.tempo, transform.pitch);
      if (seen.has(key) || cache.has(key)) {
        return;
      }
      seen.add(key);
      jobs.push({ source: source, transform: transform });
    });
    for (let i = 0; i < jobs.length; i += 1) {
      const job = jobs[i];
      await renderTransformed(job.source, job.transform.tempo, job.transform.pitch, function (value) {
        report((i + value) / jobs.length, job.source.name);
      });
    }
    return jobs.length;
  }

  Retune.engine = {
    context: ensureContext,
    resume: resume,
    masterGain: masterGain,
    meter: meter,
    sampleRate: sampleRate,
    decode: decode,
    playbackFor: playbackFor,
    requestRender: requestRender,
    prepare: prepare,
    clearForSource: clearForSource
  };
})(window.Retune);
