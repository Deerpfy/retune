(function (global) {
  const Retune = {};
  Retune.appName = 'Retune';

  const topics = new Map();

  Retune.bus = {
    on: function (topic, handler) {
      let set = topics.get(topic);
      if (!set) {
        set = new Set();
        topics.set(topic, set);
      }
      set.add(handler);
    },
    emit: function (topic, payload) {
      const set = topics.get(topic);
      if (!set) {
        return;
      }
      set.forEach(function (handler) {
        handler(payload);
      });
    }
  };

  const tokenCache = new Map();

  function token(name) {
    let value = tokenCache.get(name);
    if (value === undefined) {
      value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      tokenCache.set(name, value);
    }
    return value;
  }

  function tokenNumber(name) {
    const value = parseFloat(token(name));
    return Number.isFinite(value) ? value : 0;
  }

  function clamp(value, min, max) {
    if (!Number.isFinite(value)) {
      return min;
    }
    return value < min ? min : value > max ? max : value;
  }

  function round(value, decimals) {
    const factor = Math.pow(10, decimals);
    return Math.round(value * factor) / factor;
  }

  let counter = 0;

  function uid(prefix) {
    counter += 1;
    return prefix + counter;
  }

  function dbToGain(db) {
    return Math.pow(10, db / 20);
  }

  function semitoneRatio(semitones, cents) {
    return Math.pow(2, (semitones + cents / 100) / 12);
  }

  function ratioToSemitones(ratio) {
    return 12 * Math.log2(ratio);
  }

  function beatSeconds(bpm) {
    return 60 / bpm;
  }

  function formatSeconds(seconds) {
    const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
    const minutes = Math.floor(safe / 60);
    const rest = safe - minutes * 60;
    return minutes + ':' + rest.toFixed(2).padStart(5, '0');
  }

  function formatBarBeat(seconds, bpm) {
    const beats = Math.max(0, seconds) / beatSeconds(bpm);
    const bar = Math.floor(beats / 4) + 1;
    const beat = Math.floor(beats % 4) + 1;
    return bar + '.' + beat;
  }

  function reducedMotion() {
    return global.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function fileBaseName(name) {
    const dot = name.lastIndexOf('.');
    return dot > 0 ? name.slice(0, dot) : name;
  }

  Retune.util = {
    token: token,
    tokenNumber: tokenNumber,
    clamp: clamp,
    round: round,
    uid: uid,
    dbToGain: dbToGain,
    semitoneRatio: semitoneRatio,
    ratioToSemitones: ratioToSemitones,
    beatSeconds: beatSeconds,
    formatSeconds: formatSeconds,
    formatBarBeat: formatBarBeat,
    reducedMotion: reducedMotion,
    fileBaseName: fileBaseName
  };

  const state = {
    sources: [],
    lanes: [],
    clips: [],
    projectBpm: 120,
    snap: 'beat',
    rulerMode: 'bars',
    pixelsPerSecond: 90,
    selectionIn: 0,
    selectionOut: 0,
    loop: false,
    selectedClipId: null,
    selectedLaneId: null,
    playhead: 0
  };

  Retune.state = state;

  function createSource(name) {
    return {
      id: uid('src-'),
      name: name,
      buffer: null,
      duration: 0,
      channels: 0,
      peaks: null,
      bucketCount: 0,
      detectedBpm: 0,
      confidence: 0,
      bpmOverride: 0
    };
  }

  function createLane(name) {
    return {
      id: uid('lane-'),
      name: name,
      gainDb: 0,
      muted: false,
      soloed: false
    };
  }

  function createClip(sourceId, laneId, startSeconds, trimOut) {
    return {
      id: uid('clip-'),
      sourceId: sourceId,
      laneId: laneId,
      startSeconds: Math.max(0, startSeconds),
      trimInSeconds: 0,
      trimOutSeconds: trimOut,
      gainDb: 0,
      muted: false,
      pitchSemitones: 0,
      pitchCents: 0,
      targetBpm: 0,
      tempoPercent: 100,
      linkPitchToTempo: false,
      fadeInSeconds: 0,
      fadeOutSeconds: 0
    };
  }

  function getSource(id) {
    return state.sources.find(function (source) {
      return source.id === id;
    }) || null;
  }

  function getLane(id) {
    return state.lanes.find(function (lane) {
      return lane.id === id;
    }) || null;
  }

  function getClip(id) {
    return state.clips.find(function (clip) {
      return clip.id === id;
    }) || null;
  }

  function laneIndex(id) {
    return state.lanes.findIndex(function (lane) {
      return lane.id === id;
    });
  }

  function laneClips(laneId) {
    return state.clips.filter(function (clip) {
      return clip.laneId === laneId;
    }).sort(function (a, b) {
      return a.startSeconds - b.startSeconds;
    });
  }

  function sourceBpm(source) {
    if (!source) {
      return 0;
    }
    return source.bpmOverride > 0 ? source.bpmOverride : source.detectedBpm;
  }

  function tempoRatio(clip) {
    return clamp(clip.tempoPercent, 1, 1000) / 100;
  }

  function pitchRatio(clip) {
    if (clip.linkPitchToTempo) {
      return tempoRatio(clip);
    }
    return semitoneRatio(clip.pitchSemitones, clip.pitchCents);
  }

  function clipDuration(clip) {
    return Math.max(0, clip.trimOutSeconds - clip.trimInSeconds) / tempoRatio(clip);
  }

  function clipEnd(clip) {
    return clip.startSeconds + clipDuration(clip);
  }

  function projectDuration() {
    return state.clips.reduce(function (max, clip) {
      return Math.max(max, clipEnd(clip));
    }, 0);
  }

  function syncTargetBpm(clip) {
    const bpm = sourceBpm(getSource(clip.sourceId));
    clip.targetBpm = bpm > 0 ? round(bpm * tempoRatio(clip), 2) : 0;
  }

  function setTempoPercent(clip, percent) {
    clip.tempoPercent = clamp(percent, 1, 1000);
    syncTargetBpm(clip);
  }

  function setTargetBpm(clip, bpm) {
    const base = sourceBpm(getSource(clip.sourceId));
    if (base <= 0 || bpm <= 0) {
      return;
    }
    setTempoPercent(clip, (bpm / base) * 100);
  }

  function refreshClipsOfSource(sourceId) {
    state.clips.forEach(function (clip) {
      if (clip.sourceId === sourceId) {
        syncTargetBpm(clip);
      }
    });
  }

  function normalizeLane(laneId, priorityClipId) {
    const clips = state.clips.filter(function (clip) {
      return clip.laneId === laneId;
    }).sort(function (a, b) {
      if (a.startSeconds === b.startSeconds) {
        if (a.id === priorityClipId) {
          return -1;
        }
        if (b.id === priorityClipId) {
          return 1;
        }
        return 0;
      }
      return a.startSeconds - b.startSeconds;
    });
    for (let i = 1; i < clips.length; i += 1) {
      const previousEnd = clipEnd(clips[i - 1]);
      if (clips[i].startSeconds < previousEnd) {
        clips[i].startSeconds = previousEnd;
      }
    }
  }

  function addLane(name) {
    const lane = createLane(name || 'Lane ' + (state.lanes.length + 1));
    state.lanes.push(lane);
    return lane;
  }

  function removeLane(laneId) {
    if (state.lanes.length < 2) {
      return false;
    }
    state.clips = state.clips.filter(function (clip) {
      return clip.laneId !== laneId;
    });
    state.lanes = state.lanes.filter(function (lane) {
      return lane.id !== laneId;
    });
    if (state.selectedLaneId === laneId) {
      state.selectedLaneId = null;
    }
    return true;
  }

  function removeClip(clipId) {
    state.clips = state.clips.filter(function (clip) {
      return clip.id !== clipId;
    });
    if (state.selectedClipId === clipId) {
      state.selectedClipId = null;
    }
  }

  function removeSource(sourceId) {
    state.clips = state.clips.filter(function (clip) {
      return clip.sourceId !== sourceId;
    });
    state.sources = state.sources.filter(function (source) {
      return source.id !== sourceId;
    });
  }

  function anySoloed() {
    return state.lanes.some(function (lane) {
      return lane.soloed;
    });
  }

  function laneAudible(lane) {
    if (lane.muted) {
      return false;
    }
    return anySoloed() ? lane.soloed : true;
  }

  function snapSeconds() {
    if (state.snap === 'off') {
      return 0;
    }
    const beat = beatSeconds(state.projectBpm);
    return state.snap === 'bar' ? beat * 4 : beat;
  }

  function snapTime(seconds) {
    const unit = snapSeconds();
    if (unit <= 0) {
      return Math.max(0, seconds);
    }
    return Math.max(0, Math.round(seconds / unit) * unit);
  }

  Retune.model = {
    createSource: createSource,
    createClip: createClip,
    getSource: getSource,
    getLane: getLane,
    getClip: getClip,
    laneIndex: laneIndex,
    laneClips: laneClips,
    sourceBpm: sourceBpm,
    tempoRatio: tempoRatio,
    pitchRatio: pitchRatio,
    clipDuration: clipDuration,
    clipEnd: clipEnd,
    projectDuration: projectDuration,
    setTempoPercent: setTempoPercent,
    setTargetBpm: setTargetBpm,
    syncTargetBpm: syncTargetBpm,
    refreshClipsOfSource: refreshClipsOfSource,
    normalizeLane: normalizeLane,
    addLane: addLane,
    removeLane: removeLane,
    removeClip: removeClip,
    removeSource: removeSource,
    laneAudible: laneAudible,
    anySoloed: anySoloed,
    snapSeconds: snapSeconds,
    snapTime: snapTime
  };

  global.Retune = Retune;
})(window);
