(function (Retune) {
  const paths = {
    'folder': 'M3 6h6l2 3h10v10H3z',
    'triangle-right': 'M8 5l11 7-11 7z',
    'bars-two': 'M9 5v14M15 5v14',
    'square': 'M6 6h12v12H6z',
    'arrow-left-line': 'M5 5v14M20 12H10M14 8l-4 4 4 4',
    'arrows-loop': 'M17 3l3 3-3 3M20 6H7a3 3 0 0 0-3 3v1M7 21l-3-3 3-3M4 18h13a3 3 0 0 0 3-3v-1',
    'magnifier-plus': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6M11 8v6',
    'magnifier-minus': 'M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14zM20 20l-4-4M8 11h6',
    'arrows-out': 'M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5',
    'trash-can': 'M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13',
    'arrow-up': 'M12 19V5M6 11l6-6 6 6',
    'arrow-down': 'M12 5v14M6 13l6 6 6-6',
    'arrow-down-tray': 'M12 4v10M8 10l4 4 4-4M4 18v2h16v-2',
    'plus': 'M12 5v14M5 12h14',
    'grip-dots': 'M9 7h0M9 12h0M9 17h0M15 7h0M15 12h0M15 17h0',
    'x-mark': 'M6 6l12 12M18 6L6 18'
  };

  function markup(name) {
    const path = paths[name];
    if (!path) {
      return '';
    }
    return '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="' + path + '"/></svg>';
  }

  function button(options) {
    const element = document.createElement('button');
    element.type = 'button';
    element.className = 'btn' + (options.className ? ' ' + options.className : '');
    if (options.icon) {
      element.insertAdjacentHTML('afterbegin', markup(options.icon));
    }
    if (options.hideLabel) {
      element.setAttribute('aria-label', options.label);
    } else {
      const text = document.createElement('span');
      text.textContent = options.label;
      element.appendChild(text);
    }
    if (options.pressed !== undefined) {
      element.setAttribute('aria-pressed', String(options.pressed));
    }
    if (options.title) {
      element.title = options.title;
    }
    if (options.onClick) {
      element.addEventListener('click', options.onClick);
    }
    return element;
  }

  Retune.icons = {
    markup: markup,
    button: button
  };
})(window.Retune);
