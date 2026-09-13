(function (Retune) {
  const WINDOW = 1024;
  const HOP = 512;
  const MAX_SECONDS = 90;
  const MIN_BPM = 60;
  const MAX_BPM = 200;
  const FRAMES_PER_SLICE = 64;
  const SAMPLES_PER_SLICE = 1048576;

  const cosTable = new Float32Array(WINDOW);
  const sinTable = new Float32Array(WINDOW);
  const analysisWindow = new Float32Array(WINDOW);

  for (let i = 0; i < WINDOW; i += 1) {
    cosTable[i] = Math.cos((-2 * Math.PI * i) / WINDOW);
    sinTable[i] = Math.sin((-2 * Math.PI * i) / WINDOW);
    analysisWindow[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WINDOW);
  }

  function yieldToEventLoop() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i += 1) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) {
        j ^= bit;
      }
      j ^= bit;
      if (i < j) {
        const tr = re[i];
        re[i] = re[j];
        re[j] = tr;
        const ti = im[i];
        im[i] = im[j];
        im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const half = len >> 1;
      const stride = n / len;
      for (let start = 0; start < n; start += len) {
        for (let k = 0; k < half; k += 1) {
          const twiddle = k * stride;
          const wr = cosTable[twiddle];
          const wi = sinTable[twiddle];
          const a = start + k;
          const b = a + half;
          const vr = re[b] * wr - im[b] * wi;
          const vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr;
          im[b] = im[a] - vi;
          re[a] += vr;
          im[a] += vi;
        }
      }
    }
  }

  async function monoSection(buffer, length, onProgress) {
    const mono = new Float32Array(length);
    const channels = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      channels.push(buffer.getChannelData(c));
    }
    const scale = 1 / channels.length;
    let index = 0;
    while (index < length) {
      const end = Math.min(length, index + SAMPLES_PER_SLICE);
      for (let c = 0; c < channels.length; c += 1) {
        const data = channels[c];
        for (let i = index; i < end; i += 1) {
          mono[i] += data[i] * scale;
        }
      }
      index = end;
      onProgress(0.15 * (index / length));
      await yieldToEventLoop();
    }
    return mono;
  }

  async function onsetEnvelope(mono, onProgress) {
    const frames = Math.floor((mono.length - WINDOW) / HOP) + 1;
    if (frames < 8) {
      return new Float32Array(0);
    }
    const envelope = new Float32Array(frames);
    const re = new Float32Array(WINDOW);
    const im = new Float32Array(WINDOW);
    const magnitude = new Float32Array(WINDOW / 2);
    const previous = new Float32Array(WINDOW / 2);
    for (let frame = 0; frame < frames; frame += 1) {
      const offset = frame * HOP;
      for (let i = 0; i < WINDOW; i += 1) {
        re[i] = mono[offset + i] * analysisWindow[i];
        im[i] = 0;
      }
      fft(re, im);
      let flux = 0;
      for (let bin = 0; bin < magnitude.length; bin += 1) {
        magnitude[bin] = Math.sqrt(re[bin] * re[bin] + im[bin] * im[bin]);
        const difference = magnitude[bin] - previous[bin];
        if (difference > 0) {
          flux += difference;
        }
        previous[bin] = magnitude[bin];
      }
      envelope[frame] = flux;
      if (frame % FRAMES_PER_SLICE === FRAMES_PER_SLICE - 1) {
        onProgress(0.15 + 0.8 * (frame / frames));
        await yieldToEventLoop();
      }
    }
    return envelope;
  }

  function normalize(envelope) {
    let mean = 0;
    for (let i = 0; i < envelope.length; i += 1) {
      mean += envelope[i];
    }
    mean /= envelope.length;
    let peak = 0;
    for (let i = 0; i < envelope.length; i += 1) {
      const value = envelope[i] - mean;
      envelope[i] = value > 0 ? value : 0;
      if (envelope[i] > peak) {
        peak = envelope[i];
      }
    }
    if (peak > 0) {
      for (let i = 0; i < envelope.length; i += 1) {
        envelope[i] /= peak;
      }
    }
    return peak;
  }

  function autocorrelation(envelope, minLag, maxLag) {
    const values = new Float32Array(maxLag + 1);
    for (let lag = minLag; lag <= maxLag; lag += 1) {
      const count = envelope.length - lag;
      if (count <= 0) {
        break;
      }
      let sum = 0;
      for (let i = 0; i < count; i += 1) {
        sum += envelope[i] * envelope[i + lag];
      }
      values[lag] = sum / count;
    }
    return values;
  }

  function combScore(values, lag) {
    let score = values[lag] || 0;
    const second = Math.round(lag * 2);
    const third = Math.round(lag * 3);
    if (second < values.length) {
      score += 0.5 * (values[second] || 0);
    }
    if (third < values.length) {
      score += 0.25 * (values[third] || 0);
    }
    return score;
  }

  async function detect(buffer, onProgress) {
    const report = onProgress || function () {};
    const sampleRate = buffer.sampleRate;
    const length = Math.min(buffer.length, Math.floor(sampleRate * MAX_SECONDS));
    if (length < sampleRate * 2) {
      report(1);
      return { bpm: 0, confidence: 0 };
    }
    const mono = await monoSection(buffer, length, report);
    const envelope = await onsetEnvelope(mono, report);
    if (envelope.length < 8) {
      report(1);
      return { bpm: 0, confidence: 0 };
    }
    if (normalize(envelope) <= 0) {
      report(1);
      return { bpm: 0, confidence: 0 };
    }
    const envelopeRate = sampleRate / HOP;
    const minLag = Math.max(2, Math.round((envelopeRate * 60) / MAX_BPM));
    const searchLag = Math.round((envelopeRate * 60) / MIN_BPM);
    const maxLag = Math.min(envelope.length - 2, searchLag * 3);
    if (maxLag <= minLag) {
      report(1);
      return { bpm: 0, confidence: 0 };
    }
    const values = autocorrelation(envelope, minLag, maxLag);
    const upper = Math.min(searchLag, maxLag);
    let peakLag = minLag;
    let peak = -Infinity;
    let total = 0;
    let count = 0;
    for (let lag = minLag; lag <= upper; lag += 1) {
      total += values[lag];
      count += 1;
      if (values[lag] > peak) {
        peak = values[lag];
        peakLag = lag;
      }
    }
    const mean = count > 0 ? total / count : 0;
    const candidates = [peakLag, Math.round(peakLag / 2), peakLag * 2];
    let chosen = peakLag;
    let chosenScore = -Infinity;
    candidates.forEach(function (lag) {
      if (lag < minLag || lag > upper) {
        return;
      }
      const score = combScore(values, lag);
      if (score > chosenScore) {
        chosenScore = score;
        chosen = lag;
      }
    });
    const bpm = (60 * envelopeRate) / chosen;
    const ratio = mean > 0 ? peak / mean : 0;
    report(1);
    return {
      bpm: Retune.util.round(bpm, 1),
      confidence: Retune.util.clamp((ratio - 1) / 1.5, 0, 1)
    };
  }

  Retune.bpmDetect = {
    detect: detect
  };
})(window.Retune);
