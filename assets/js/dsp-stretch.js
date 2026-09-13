(function (Retune) {
  const FRAME = 2048;
  const SYNTHESIS_HOP = 512;
  const SEARCH_RADIUS = 512;
  const CORRELATION = 512;
  const COARSE_STEP = 8;
  const FRAMES_PER_SLICE = 48;
  const SAMPLES_PER_SLICE = 262144;
  const EPSILON = 1e-6;
  const NORM_FLOOR = 0.5;

  function noop() {}

  function yieldToEventLoop() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function hannWindow(size) {
    const values = new Float32Array(size);
    for (let i = 0; i < size; i += 1) {
      values[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
    }
    return values;
  }

  function mixToMono(channels) {
    if (channels.length === 1) {
      return channels[0];
    }
    const length = channels[0].length;
    const mono = new Float32Array(length);
    for (let c = 0; c < channels.length; c += 1) {
      const data = channels[c];
      for (let i = 0; i < length; i += 1) {
        mono[i] += data[i];
      }
    }
    const scale = 1 / channels.length;
    for (let i = 0; i < length; i += 1) {
      mono[i] *= scale;
    }
    return mono;
  }

  function correlate(mono, templateStart, candidateStart) {
    let sum = 0;
    for (let i = 0; i < CORRELATION; i += 1) {
      sum += mono[templateStart + i] * mono[candidateStart + i];
    }
    return sum;
  }

  function bestLag(mono, templateStart, idealStart, maxStart) {
    const template = Math.min(Math.max(templateStart, 0), maxStart);
    let chosen = 0;
    let best = -Infinity;
    for (let lag = -SEARCH_RADIUS; lag <= SEARCH_RADIUS; lag += COARSE_STEP) {
      const candidate = idealStart + lag;
      if (candidate < 0 || candidate > maxStart) {
        continue;
      }
      const score = correlate(mono, template, candidate);
      if (score > best) {
        best = score;
        chosen = lag;
      }
    }
    const from = chosen - COARSE_STEP + 1;
    const to = chosen + COARSE_STEP - 1;
    for (let lag = from; lag <= to; lag += 1) {
      const candidate = idealStart + lag;
      if (candidate < 0 || candidate > maxStart || lag < -SEARCH_RADIUS || lag > SEARCH_RADIUS) {
        continue;
      }
      const score = correlate(mono, template, candidate);
      if (score > best) {
        best = score;
        chosen = lag;
      }
    }
    return chosen;
  }

  function sampleAt(data, index) {
    if (index < 0) {
      return data[0];
    }
    if (index >= data.length) {
      return data[data.length - 1];
    }
    return data[index];
  }

  function hermite(y0, y1, y2, y3, t) {
    const c1 = 0.5 * (y2 - y0);
    const c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
    const c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    return ((c3 * t + c2) * t + c1) * t + y1;
  }

  function lowpass(data, sampleRate, cutoff) {
    if (cutoff >= sampleRate * 0.5 || cutoff <= 0) {
      return data;
    }
    const w0 = (2 * Math.PI * cutoff) / sampleRate;
    const cosine = Math.cos(w0);
    const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
    const a0 = 1 + alpha;
    const b0 = ((1 - cosine) / 2) / a0;
    const b1 = (1 - cosine) / a0;
    const b2 = b0;
    const a1 = (-2 * cosine) / a0;
    const a2 = (1 - alpha) / a0;
    const out = new Float32Array(data.length);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < data.length; i += 1) {
      const x0 = data[i];
      const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x0;
      y2 = y1;
      y1 = y0;
      out[i] = y0;
    }
    return out;
  }

  async function resample(channels, step, sampleRate, onProgress) {
    const report = onProgress || noop;
    const inLength = channels[0].length;
    const outLength = Math.max(1, Math.floor(inLength / step));
    const cutoff = 0.45 * (sampleRate / step);
    const result = [];
    for (let c = 0; c < channels.length; c += 1) {
      const source = step > 1 ? lowpass(channels[c], sampleRate, cutoff) : channels[c];
      const target = new Float32Array(outLength);
      let index = 0;
      while (index < outLength) {
        const end = Math.min(outLength, index + SAMPLES_PER_SLICE);
        for (let i = index; i < end; i += 1) {
          const position = i * step;
          const base = Math.floor(position);
          const fraction = position - base;
          target[i] = hermite(
            sampleAt(source, base - 1),
            sampleAt(source, base),
            sampleAt(source, base + 1),
            sampleAt(source, base + 2),
            fraction
          );
        }
        index = end;
        report((c + index / outLength) / channels.length);
        await yieldToEventLoop();
      }
      result.push(target);
    }
    return result;
  }

  async function stretch(channels, stretchRatio, sampleRate, onProgress) {
    const report = onProgress || noop;
    const inLength = channels[0].length;
    if (inLength <= FRAME) {
      return resample(channels, 1 / stretchRatio, sampleRate, report);
    }
    const targetLength = Math.max(1, Math.round(inLength * stretchRatio));
    const analysisHop = SYNTHESIS_HOP / stretchRatio;
    const frames = Math.ceil(targetLength / SYNTHESIS_HOP) + 1;
    const padded = frames * SYNTHESIS_HOP + FRAME;
    const window = hannWindow(FRAME);
    const mono = mixToMono(channels);
    const maxStart = inLength - FRAME;
    const accumulator = channels.map(function () {
      return new Float32Array(padded);
    });
    const weight = new Float32Array(padded);
    let previousStart = 0;
    for (let frame = 0; frame < frames; frame += 1) {
      const ideal = Math.min(Math.max(Math.round(frame * analysisHop), 0), maxStart);
      let start = ideal;
      if (frame > 0) {
        start = Math.min(Math.max(ideal + bestLag(mono, previousStart + SYNTHESIS_HOP, ideal, maxStart), 0), maxStart);
      }
      const outPosition = frame * SYNTHESIS_HOP;
      for (let c = 0; c < channels.length; c += 1) {
        const source = channels[c];
        const target = accumulator[c];
        for (let i = 0; i < FRAME; i += 1) {
          target[outPosition + i] += source[start + i] * window[i];
        }
      }
      for (let i = 0; i < FRAME; i += 1) {
        weight[outPosition + i] += window[i];
      }
      previousStart = start;
      if (frame % FRAMES_PER_SLICE === FRAMES_PER_SLICE - 1) {
        report(frame / frames);
        await yieldToEventLoop();
      }
    }
    return accumulator.map(function (data) {
      const target = new Float32Array(targetLength);
      for (let i = 0; i < targetLength; i += 1) {
        const denominator = weight[i] < NORM_FLOOR ? NORM_FLOOR : weight[i];
        target[i] = data[i] / denominator;
      }
      return target;
    });
  }

  function needsRender(tempoRatio, pitchRatio) {
    return Math.abs(pitchRatio / tempoRatio - 1) > EPSILON || Math.abs(pitchRatio - 1) > EPSILON;
  }

  async function renderTransform(channels, sampleRate, tempoRatio, pitchRatio, onProgress) {
    const report = onProgress || noop;
    const stretchRatio = pitchRatio / tempoRatio;
    const wantsStretch = Math.abs(stretchRatio - 1) > EPSILON;
    const wantsResample = Math.abs(pitchRatio - 1) > EPSILON;
    const stretchSpan = wantsResample ? 0.85 : 1;
    let data = channels;
    if (wantsStretch) {
      data = await stretch(data, stretchRatio, sampleRate, function (value) {
        report(value * stretchSpan);
      });
    }
    if (wantsResample) {
      data = await resample(data, pitchRatio, sampleRate, function (value) {
        report(stretchSpan + value * (1 - stretchSpan));
      });
    }
    report(1);
    return data;
  }

  Retune.dsp = {
    needsRender: needsRender,
    renderTransform: renderTransform
  };
})(window.Retune);
