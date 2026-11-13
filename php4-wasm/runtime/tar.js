// Reads a tar archive (ustar or old GNU) into entries: regular files,
// directories and symlinks, which is what TYPO3's release archives hold.
// Anything else is an error rather than something skipped, so a different
// archive cannot unpack silently incomplete.
'use strict';

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.readTar = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  const BLOCK = 512;

  function field(bytes, offset, length) {
    let end = offset;
    while (end < offset + length && bytes[end] !== 0) {
      end++;
    }
    let text = '';
    for (let i = offset; i < end; i++) {
      text += String.fromCharCode(bytes[i]);
    }
    return text;
  }

  function octal(bytes, offset, length) {
    const text = field(bytes, offset, length).trim();
    return text ? parseInt(text, 8) : 0;
  }

  function checksumMatches(bytes, offset) {
    let sum = 0;
    for (let i = 0; i < BLOCK; i++) {
      sum += i >= 148 && i < 156 ? 0x20 : bytes[offset + i];
    }
    return sum === octal(bytes, offset + 148, 8);
  }

  // Returns [{ type: 'file' | 'directory' | 'symlink', path, data?, target? }].
  function readTar(bytes) {
    const entries = [];
    let offset = 0;
    while (offset + BLOCK <= bytes.length) {
      if (bytes.subarray(offset, offset + BLOCK).every(byte => byte === 0)) {
        break;
      }
      if (!checksumMatches(bytes, offset)) {
        throw new Error(`tar: bad header checksum at byte ${offset}`);
      }
      const prefix = field(bytes, offset + 345, 155);
      const name = field(bytes, offset + 0, 100);
      const path = (prefix && field(bytes, offset + 257, 6) === 'ustar' ? `${prefix}/${name}` : name).replace(/\/+$/, '');
      const size = octal(bytes, offset + 124, 12);
      const flag = String.fromCharCode(bytes[offset + 156] || 0x30);
      const dataStart = offset + BLOCK;
      if (flag === '0' || flag === '7') {
        entries.push({ type: 'file', path, data: bytes.subarray(dataStart, dataStart + size) });
      } else if (flag === '5') {
        entries.push({ type: 'directory', path });
      } else if (flag === '2') {
        entries.push({ type: 'symlink', path, target: field(bytes, offset + 157, 100) });
      } else {
        throw new Error(`tar: entry type '${flag}' of ${path} is not supported`);
      }
      offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    }
    return entries;
  }

  return readTar;
});
