import { inflateSync } from "node:zlib";

const PNG_SIGNATURE = Buffer.from("89504e470d0a1a0a", "hex");

const isPng = (bytes: Buffer): boolean => {
  if (bytes.length < 57 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return false;
  }

  let offset = 8;
  let hasHeader = false;
  const compressed: Buffer[] = [];

  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);

    if (length > bytes.length - offset - 12) {
      return false;
    }

    const type = bytes.toString("ascii", offset + 4, offset + 8);
    const data = offset + 8;
    offset += length + 12;

    if (!hasHeader) {
      if (
        type !== "IHDR" ||
        length !== 13 ||
        bytes.readUInt32BE(data) === 0 ||
        bytes.readUInt32BE(data + 4) === 0
      ) {
        return false;
      }

      hasHeader = true;
    } else if (type === "IDAT") {
      compressed.push(bytes.subarray(data, data + length));
    } else if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length || !compressed.length) {
        return false;
      }

      try {
        return (
          inflateSync(Buffer.concat(compressed), {
            maxOutputLength: 32 * 1024 * 1024,
          }).length > 0
        );
      } catch {
        return false;
      }
    } else if (type === "IHDR") {
      return false;
    }
  }

  return false;
};

const isFrameMarker = (marker: number) =>
  [
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
    0xcf,
  ].includes(marker);

const nextScanMarker = (bytes: Buffer, from: number): number => {
  let offset = from;

  while (offset < bytes.length - 1) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }

    let next = offset + 1;

    while (bytes[next] === 0xff) {
      next += 1;
    }

    if (bytes[next] !== 0x00 && (bytes[next] < 0xd0 || bytes[next] > 0xd7)) {
      return offset;
    }

    offset = next + 1;
  }

  return bytes.length;
};

interface JpegSegment {
  end: number;
  frame: boolean;
  marker: number;
  size: number;
}

const readJpegSegment = (
  bytes: Buffer,
  at: number
): JpegSegment | undefined => {
  if (bytes[at] !== 0xff) {
    return;
  }

  let offset = at;

  while (bytes[offset] === 0xff) {
    offset += 1;
  }

  const marker = bytes[offset];
  offset += 1;

  if (marker === 0xd9) {
    return { end: offset, frame: false, marker, size: 0 };
  }

  if (offset + 2 > bytes.length || marker === 0x00) {
    return;
  }

  const size = bytes.readUInt16BE(offset);

  if (size < 2 || offset + size > bytes.length) {
    return;
  }

  const frame =
    isFrameMarker(marker) &&
    size >= 11 &&
    bytes.readUInt16BE(offset + 3) > 0 &&
    bytes.readUInt16BE(offset + 5) > 0;

  return { end: offset + size, frame, marker, size };
};

const hasJpegEnvelope = (bytes: Buffer) =>
  bytes.length >= 24 &&
  bytes[0] === 0xff &&
  bytes[1] === 0xd8 &&
  bytes.at(-2) === 0xff &&
  bytes.at(-1) === 0xd9;

const isJpeg = (bytes: Buffer): boolean => {
  if (!hasJpegEnvelope(bytes)) {
    return false;
  }

  let offset = 2;
  let frame = false;
  let scan = false;
  let quantization = false;
  let entropyTable = false;

  while (offset < bytes.length) {
    const segment = readJpegSegment(bytes, offset);

    if (!segment) {
      return false;
    }

    const { end, marker, size } = segment;

    if (marker === 0xd9) {
      return frame && scan && end === bytes.length;
    }

    frame ||= segment.frame;
    quantization ||= marker === 0xdb;
    entropyTable ||= marker === 0xc4 || marker === 0xcc;
    offset = end;

    if (marker === 0xda) {
      if (!(frame && quantization && entropyTable && size >= 6)) {
        return false;
      }

      const next = nextScanMarker(bytes, offset);

      if (next <= offset) {
        return false;
      }

      scan = true;
      offset = next;
    }
  }

  return false;
};

const skipGifBlocks = (bytes: Buffer, at: number): number | undefined => {
  let offset = at;

  while (offset < bytes.length) {
    const length = bytes[offset];
    offset += 1;

    if (length === 0) {
      return offset;
    }

    if (offset + length > bytes.length) {
      return;
    }

    offset += length;
  }
};

const gifColorTableEnd = (bytes: Buffer, at: number, packed: number) =>
  at + ((packed & 0x80) === 0 ? 0 : 3 * 2 ** ((packed & 7) + 1));

const gifFrameEnd = (bytes: Buffer, at: number): number | undefined => {
  if (
    at + 9 > bytes.length ||
    bytes.readUInt16LE(at + 4) === 0 ||
    bytes.readUInt16LE(at + 6) === 0
  ) {
    return;
  }

  const data = gifColorTableEnd(bytes, at + 9, bytes[at + 8]);

  if (
    data + 2 >= bytes.length ||
    bytes[data] < 2 ||
    bytes[data] > 12 ||
    bytes[data + 1] === 0
  ) {
    return;
  }

  return skipGifBlocks(bytes, data + 1);
};

const isGif = (bytes: Buffer): boolean => {
  if (
    bytes.length < 20 ||
    !["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6)) ||
    bytes.readUInt16LE(6) === 0 ||
    bytes.readUInt16LE(8) === 0
  ) {
    return false;
  }

  let offset = gifColorTableEnd(bytes, 13, bytes[10]);
  let frame = false;

  while (offset < bytes.length) {
    const block = bytes[offset];
    offset += 1;

    if (block === 0x3b) {
      return frame && offset === bytes.length;
    }

    if (block === 0x21 && offset < bytes.length) {
      offset = skipGifBlocks(bytes, offset + 1) ?? bytes.length;
    } else if (block === 0x2c) {
      const end = gifFrameEnd(bytes, offset);

      if (end === undefined) {
        return false;
      }

      frame = true;
      offset = end;
    } else {
      return false;
    }
  }

  return false;
};

const validWebpFrame = (
  bytes: Buffer,
  type: string,
  data: number,
  length: number
) => {
  if (type === "VP8 ") {
    return (
      length >= 10 &&
      bytes.toString("hex", data + 3, data + 6) === "9d012a" &&
      (bytes.readUInt16LE(data + 6) & 0x3fff) > 0 &&
      (bytes.readUInt16LE(data + 8) & 0x3fff) > 0
    );
  }

  if (type === "VP8L") {
    return length >= 5 && bytes[data] === 0x2f;
  }

  return type === "ANMF" && length >= 16;
};

const isWebp = (bytes: Buffer): boolean => {
  if (
    bytes.length < 30 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) !== bytes.length - 8
  ) {
    return false;
  }

  let offset = 12;
  let frame = false;

  while (offset + 8 <= bytes.length) {
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const data = offset + 8;
    const end = data + length + (length % 2);

    if (end > bytes.length) {
      return false;
    }

    frame ||= validWebpFrame(bytes, type, data, length);
    offset = end;
  }

  return frame && offset === bytes.length;
};

export const detectImageFormat = (bytes: Buffer): string | undefined => {
  if (isPng(bytes)) {
    return "image/png";
  }

  if (isJpeg(bytes)) {
    return "image/jpeg";
  }

  if (isGif(bytes)) {
    return "image/gif";
  }

  if (isWebp(bytes)) {
    return "image/webp";
  }
};
