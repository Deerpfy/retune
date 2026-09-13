(function (Retune) {
  const BUCKET = 512;
  const BUCKETS_PER_SLICE = 4096;

  function yieldToEventLoop() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  async function extractPeaks(buffer, onProgress) {
    const report = onProgress || function () {};
    const bucketCount = Math.max(1, Math.ceil(buffer.length / BUCKET));
    const peaks = [];
    for (let c = 0; c < buffer.numberOfChannels; c += 1) {
      const data = buffer.getChannelData(c);
      const target = new Float32Array(bucketCount * 2);
      let bucket = 0;
      while (bucket < bucketCount) {
        const stopBucket = Math.min(bucketCount, bucket + BUCKETS_PER_SLICE);
        for (let b = bucket; b < stopBucket; b += 1) {
          const start = b * BUCKET;
          const end = Math.min(data.length, start + BUCKET);
          let min = 0;
          let max = 0;
          if (end > start) {
            min = data[start];
            max = data[start];
            for (let i = start + 1; i < end; i += 1) {
              const value = data[i];
              if (value < min) {
                min = value;
              }
              if (value > max) {
                max = value;
              }
            }
          }
          target[b * 2] = min;
          target[b * 2 + 1] = max;
        }
        bucket = stopBucket;
        report((c + bucket / bucketCount) / buffer.numberOfChannels);
        await yieldToEventLoop();
      }
      peaks.push(target);
    }
    return { peaks: peaks, bucketCount: bucketCount };
  }

  function bucketFor(seconds, sampleRate) {
    return (seconds * sampleRate) / BUCKET;
  }

  function prepareCanvas(canvas) {
    const ratio = window.devicePixelRatio || 1;
    const width = Math.max(1, canvas.clientWidth);
    const height = Math.max(1, canvas.clientHeight);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    const context = canvas.getContext('2d');
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, width, height);
    return { context: context, width: width, height: height };
  }

  function drawBand(context, channel, bucketCount, fromBucket, toBucket, x, y, width, height, color) {
    const span = Math.max(1, toBucket - fromBucket);
    const middle = y + height / 2;
    const half = height / 2;
    context.fillStyle = color;
    for (let column = 0; column < width; column += 1) {
      const start = Math.floor(fromBucket + (column / width) * span);
      const end = Math.max(start + 1, Math.floor(fromBucket + ((column + 1) / width) * span));
      let min = 0;
      let max = 0;
      for (let b = start; b < end; b += 1) {
        if (b < 0 || b >= bucketCount) {
          continue;
        }
        const low = channel[b * 2];
        const high = channel[b * 2 + 1];
        if (low < min) {
          min = low;
        }
        if (high > max) {
          max = high;
        }
      }
      const top = middle - max * half;
      const bottom = middle - min * half;
      context.fillRect(x + column, top, 1, Math.max(1, bottom - top));
    }
  }

  function drawSource(canvas, source) {
    if (!source.peaks) {
      return;
    }
    const surface = prepareCanvas(canvas);
    const channels = source.peaks.length;
    const bandHeight = surface.height / channels;
    const axis = Retune.util.token('--color-wave-axis');
    const wave = Retune.util.token('--color-wave');
    for (let c = 0; c < channels; c += 1) {
      const top = c * bandHeight;
      surface.context.fillStyle = axis;
      surface.context.fillRect(0, top + bandHeight / 2, surface.width, 1);
      drawBand(
        surface.context,
        source.peaks[c],
        source.bucketCount,
        0,
        source.bucketCount,
        0,
        top,
        surface.width,
        bandHeight,
        wave
      );
    }
  }

  Retune.waveform = {
    bucketSize: BUCKET,
    extractPeaks: extractPeaks,
    bucketFor: bucketFor,
    prepareCanvas: prepareCanvas,
    drawBand: drawBand,
    drawSource: drawSource
  };
})(window.Retune);
