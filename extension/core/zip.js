const crcTable = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value;
});

export function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(length) {
  const bytes = new Uint8Array(length);
  const view = new DataView(bytes.buffer);
  return {
    bytes,
    short: (offset, value) => view.setUint16(offset, value, true),
    long: (offset, value) => view.setUint32(offset, value, true),
  };
}

// Stored ZIP entries. Both the extension archive and Excel format use UTF-8 filenames.
export function makeZip(files) {
  const encoder = new TextEncoder();
  const local = [];
  const directory = [];
  let offset = 0;
  let directorySize = 0;
  for (const [name, value] of files) {
    const path = encoder.encode(name);
    const data = typeof value === "string" ? encoder.encode(value) : value;
    const crc = crc32(data);
    const file = header(30);
    file.long(0, 0x04034b50);
    file.short(4, 20);
    file.short(6, 0x0800);
    file.short(12, 33);
    file.long(14, crc);
    file.long(18, data.length);
    file.long(22, data.length);
    file.short(26, path.length);
    local.push(file.bytes, path, data);

    const central = header(46);
    central.long(0, 0x02014b50);
    central.short(4, 20);
    central.short(6, 20);
    central.short(8, 0x0800);
    central.short(14, 33);
    central.long(16, crc);
    central.long(20, data.length);
    central.long(24, data.length);
    central.short(28, path.length);
    central.long(42, offset);
    directory.push(central.bytes, path);
    directorySize += central.bytes.length + path.length;
    offset += file.bytes.length + path.length + data.length;
  }
  const end = header(22);
  end.long(0, 0x06054b50);
  end.short(8, files.length);
  end.short(10, files.length);
  end.long(12, directorySize);
  end.long(16, offset);

  const output = new Uint8Array(offset + directorySize + end.bytes.length);
  let cursor = 0;
  for (const part of [...local, ...directory, end.bytes]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
}
