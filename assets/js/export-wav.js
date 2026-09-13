(function (Retune) {
  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  function encode(buffer, bitDepth) {
    const depth = bitDepth === 32 ? 32 : 16;
    const channels = buffer.numberOfChannels;
    const frames = buffer.length;
    const bytesPerSample = depth / 8;
    const blockAlign = channels * bytesPerSample;
    const dataBytes = frames * blockAlign;
    const view = new DataView(new ArrayBuffer(44 + dataBytes));
    writeAscii(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataBytes, true);
    writeAscii(view, 8, 'WAVE');
    writeAscii(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, depth === 32 ? 3 : 1, true);
    view.setUint16(22, channels, true);
    view.setUint32(24, buffer.sampleRate, true);
    view.setUint32(28, buffer.sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, depth, true);
    writeAscii(view, 36, 'data');
    view.setUint32(40, dataBytes, true);
    const data = [];
    for (let c = 0; c < channels; c += 1) {
      data.push(buffer.getChannelData(c));
    }
    let offset = 44;
    for (let i = 0; i < frames; i += 1) {
      for (let c = 0; c < channels; c += 1) {
        const sample = data[c][i];
        if (depth === 32) {
          view.setFloat32(offset, sample, true);
          offset += 4;
        } else {
          const limited = sample < -1 ? -1 : sample > 1 ? 1 : sample;
          view.setInt16(offset, limited < 0 ? limited * 0x8000 : limited * 0x7fff, true);
          offset += 2;
        }
      }
    }
    return new Blob([view.buffer], { type: 'audio/wav' });
  }

  function safeName(text) {
    return text.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'retune';
  }

  function download(blob, filename) {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    anchor.rel = 'noopener';
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 0);
  }

  Retune.exportWav = {
    encode: encode,
    download: download,
    safeName: safeName
  };
})(window.Retune);
