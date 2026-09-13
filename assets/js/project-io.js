(function (Retune) {
  const state = Retune.state;
  const model = Retune.model;

  const FORMAT_VERSION = 1;

  function serialize() {
    const laneOrder = new Map();
    state.lanes.forEach(function (lane, index) {
      laneOrder.set(lane.id, index);
    });
    return {
      app: Retune.appName,
      version: FORMAT_VERSION,
      projectBpm: state.projectBpm,
      snap: state.snap,
      rulerMode: state.rulerMode,
      pixelsPerSecond: state.pixelsPerSecond,
      selectionIn: state.selectionIn,
      selectionOut: state.selectionOut,
      loop: state.loop,
      sources: state.sources.map(function (source) {
        return {
          name: source.name,
          duration: source.duration,
          detectedBpm: source.detectedBpm,
          confidence: source.confidence,
          bpmOverride: source.bpmOverride
        };
      }),
      lanes: state.lanes.map(function (lane) {
        return {
          name: lane.name,
          gainDb: lane.gainDb,
          muted: lane.muted,
          soloed: lane.soloed
        };
      }),
      clips: state.clips.map(function (clip) {
        const source = model.getSource(clip.sourceId);
        return {
          sourceName: source ? source.name : '',
          lane: laneOrder.get(clip.laneId),
          startSeconds: clip.startSeconds,
          trimInSeconds: clip.trimInSeconds,
          trimOutSeconds: clip.trimOutSeconds,
          gainDb: clip.gainDb,
          muted: clip.muted,
          pitchSemitones: clip.pitchSemitones,
          pitchCents: clip.pitchCents,
          tempoPercent: clip.tempoPercent,
          targetBpm: clip.targetBpm,
          linkPitchToTempo: clip.linkPitchToTempo,
          fadeInSeconds: clip.fadeInSeconds,
          fadeOutSeconds: clip.fadeOutSeconds
        };
      })
    };
  }

  function save() {
    const blob = new Blob([JSON.stringify(serialize(), null, 2)], { type: 'application/json' });
    Retune.exportWav.download(blob, Retune.exportWav.safeName(Retune.appName.toLowerCase() + '-project') + '.json');
  }

  function readFile(file) {
    return new Promise(function (resolve, reject) {
      const reader = new FileReader();
      reader.onload = function () {
        resolve(String(reader.result));
      };
      reader.onerror = function () {
        reject(new Error('the file could not be read'));
      };
      reader.readAsText(file);
    });
  }

  function apply(data) {
    const keptSources = new Map();
    state.sources.forEach(function (source) {
      if (source.buffer) {
        keptSources.set(source.name, source);
      }
    });
    state.clips = [];
    state.lanes = [];
    state.sources = [];
    state.selectedClipId = null;
    state.selectedLaneId = null;
    state.projectBpm = data.projectBpm || state.projectBpm;
    state.snap = data.snap || state.snap;
    state.rulerMode = data.rulerMode || state.rulerMode;
    state.pixelsPerSecond = data.pixelsPerSecond || state.pixelsPerSecond;
    state.selectionIn = data.selectionIn || 0;
    state.selectionOut = data.selectionOut || 0;
    state.loop = Boolean(data.loop);
    state.playhead = 0;

    const byName = new Map();
    (data.sources || []).forEach(function (entry) {
      const existing = keptSources.get(entry.name);
      if (existing) {
        existing.detectedBpm = entry.detectedBpm || existing.detectedBpm;
        existing.bpmOverride = entry.bpmOverride || existing.bpmOverride;
        state.sources.push(existing);
        byName.set(entry.name, existing);
        return;
      }
      const source = model.createSource(entry.name);
      source.duration = entry.duration || 0;
      source.detectedBpm = entry.detectedBpm || 0;
      source.confidence = entry.confidence || 0;
      source.bpmOverride = entry.bpmOverride || 0;
      state.sources.push(source);
      byName.set(entry.name, source);
    });

    (data.lanes || []).forEach(function (entry) {
      const lane = model.addLane(entry.name);
      lane.gainDb = entry.gainDb || 0;
      lane.muted = Boolean(entry.muted);
      lane.soloed = Boolean(entry.soloed);
    });
    if (state.lanes.length === 0) {
      model.addLane('Lane 1');
    }

    (data.clips || []).forEach(function (entry) {
      const source = byName.get(entry.sourceName);
      const lane = state.lanes[entry.lane] || state.lanes[0];
      if (!source || !lane) {
        return;
      }
      const clip = model.createClip(source.id, lane.id, entry.startSeconds || 0, entry.trimOutSeconds || source.duration);
      clip.trimInSeconds = entry.trimInSeconds || 0;
      clip.gainDb = entry.gainDb || 0;
      clip.muted = Boolean(entry.muted);
      clip.pitchSemitones = entry.pitchSemitones || 0;
      clip.pitchCents = entry.pitchCents || 0;
      clip.tempoPercent = entry.tempoPercent || 100;
      clip.targetBpm = entry.targetBpm || 0;
      clip.linkPitchToTempo = Boolean(entry.linkPitchToTempo);
      clip.fadeInSeconds = entry.fadeInSeconds || 0;
      clip.fadeOutSeconds = entry.fadeOutSeconds || 0;
      state.clips.push(clip);
    });

    return state.sources.filter(function (source) {
      return !source.buffer;
    }).map(function (source) {
      return source.name;
    });
  }

  async function load(file) {
    const text = await readFile(file);
    let data;
    try {
      data = JSON.parse(text);
    } catch (error) {
      throw new Error(file.name + ' is not valid JSON');
    }
    if (!data || data.app !== Retune.appName) {
      throw new Error(file.name + ' is not a ' + Retune.appName + ' project file');
    }
    return apply(data);
  }

  Retune.projectIo = {
    save: save,
    load: load
  };
})(window.Retune);
