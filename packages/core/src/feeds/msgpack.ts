/*
  Minimal MessagePack codec for the Alpaca options stream. Alpaca serves the
  options WebSocket in msgpack only (https://docs.alpaca.markets/docs/
  real-time-option-data, "the option stream is only available in msgpack
  format") and this repo adds no new npm dependencies, so a small codec lives
  here: encode covers the control messages we send (maps/strings/arrays/
  bools), decode covers the full type range Alpaca emits, including the
  timestamp extension (type -1), which decodes to epoch milliseconds.
*/

export type MsgpackValue =
  | null
  | boolean
  | number
  | string
  | Uint8Array
  | MsgpackValue[]
  | { [key: string]: MsgpackValue };

export function msgpackEncode(value: MsgpackValue): Uint8Array {
  const chunks: number[] = [];
  encodeInto(value, chunks);
  return Uint8Array.from(chunks);
}

function encodeInto(value: MsgpackValue, out: number[]): void {
  if (value === null) {
    out.push(0xc0);
    return;
  }
  if (typeof value === "boolean") {
    out.push(value ? 0xc3 : 0xc2);
    return;
  }
  if (typeof value === "number") {
    if (Number.isInteger(value) && value >= 0 && value <= 0x7f) {
      out.push(value);
    } else if (Number.isInteger(value) && value >= -32 && value < 0) {
      out.push(0x100 + value);
    } else if (Number.isInteger(value) && value >= 0 && value <= 0xffffffff) {
      out.push(
        0xce,
        (value >>> 24) & 0xff,
        (value >>> 16) & 0xff,
        (value >>> 8) & 0xff,
        value & 0xff,
      );
    } else {
      const buf = new DataView(new ArrayBuffer(8));
      buf.setFloat64(0, value);
      out.push(0xcb);
      for (let i = 0; i < 8; i++) out.push(buf.getUint8(i));
    }
    return;
  }
  if (typeof value === "string") {
    const bytes = new TextEncoder().encode(value);
    if (bytes.length <= 31) out.push(0xa0 | bytes.length);
    else if (bytes.length <= 0xff) out.push(0xd9, bytes.length);
    else out.push(0xda, (bytes.length >>> 8) & 0xff, bytes.length & 0xff);
    for (const b of bytes) out.push(b);
    return;
  }
  if (value instanceof Uint8Array) {
    out.push(0xc4, value.length & 0xff);
    for (const b of value) out.push(b);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length <= 15) out.push(0x90 | value.length);
    else out.push(0xdc, (value.length >>> 8) & 0xff, value.length & 0xff);
    for (const item of value) encodeInto(item, out);
    return;
  }
  const keys = Object.keys(value);
  if (keys.length <= 15) out.push(0x80 | keys.length);
  else out.push(0xde, (keys.length >>> 8) & 0xff, keys.length & 0xff);
  for (const key of keys) {
    encodeInto(key, out);
    encodeInto(value[key] as MsgpackValue, out);
  }
}

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  u8(): number {
    return this.view.getUint8(this.offset++);
  }
  take(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.offset, this.offset + n);
    this.offset += n;
    return slice;
  }
}

/** Decode one msgpack value; throws on truncated or unknown input. */
export function msgpackDecode(bytes: Uint8Array): MsgpackValue {
  return decodeValue(new Reader(bytes));
}

function decodeValue(r: Reader): MsgpackValue {
  const tag = r.u8();
  if (tag <= 0x7f) return tag; // positive fixint
  if (tag >= 0xe0) return tag - 0x100; // negative fixint
  if (tag >= 0x80 && tag <= 0x8f) return decodeMap(r, tag & 0x0f);
  if (tag >= 0x90 && tag <= 0x9f) return decodeArray(r, tag & 0x0f);
  if (tag >= 0xa0 && tag <= 0xbf) return decodeStr(r, tag & 0x1f);
  switch (tag) {
    case 0xc0:
      return null;
    case 0xc2:
      return false;
    case 0xc3:
      return true;
    case 0xc4:
      return r.take(r.u8());
    case 0xc5: {
      const n = r.view.getUint16(r.offset);
      r.offset += 2;
      return r.take(n);
    }
    case 0xc6: {
      const n = r.view.getUint32(r.offset);
      r.offset += 4;
      return r.take(n);
    }
    case 0xca: {
      const v = r.view.getFloat32(r.offset);
      r.offset += 4;
      return v;
    }
    case 0xcb: {
      const v = r.view.getFloat64(r.offset);
      r.offset += 8;
      return v;
    }
    case 0xcc:
      return r.u8();
    case 0xcd: {
      const v = r.view.getUint16(r.offset);
      r.offset += 2;
      return v;
    }
    case 0xce: {
      const v = r.view.getUint32(r.offset);
      r.offset += 4;
      return v;
    }
    case 0xcf: {
      const v = r.view.getBigUint64(r.offset);
      r.offset += 8;
      return Number(v);
    }
    case 0xd0:
      return r.view.getInt8(r.offset++);
    case 0xd1: {
      const v = r.view.getInt16(r.offset);
      r.offset += 2;
      return v;
    }
    case 0xd2: {
      const v = r.view.getInt32(r.offset);
      r.offset += 4;
      return v;
    }
    case 0xd3: {
      const v = r.view.getBigInt64(r.offset);
      r.offset += 8;
      return Number(v);
    }
    case 0xd9:
      return decodeStr(r, r.u8());
    case 0xda: {
      const n = r.view.getUint16(r.offset);
      r.offset += 2;
      return decodeStr(r, n);
    }
    case 0xdb: {
      const n = r.view.getUint32(r.offset);
      r.offset += 4;
      return decodeStr(r, n);
    }
    case 0xdc: {
      const n = r.view.getUint16(r.offset);
      r.offset += 2;
      return decodeArray(r, n);
    }
    case 0xdd: {
      const n = r.view.getUint32(r.offset);
      r.offset += 4;
      return decodeArray(r, n);
    }
    case 0xde: {
      const n = r.view.getUint16(r.offset);
      r.offset += 2;
      return decodeMap(r, n);
    }
    case 0xdf: {
      const n = r.view.getUint32(r.offset);
      r.offset += 4;
      return decodeMap(r, n);
    }
    // ext family — the only ext Alpaca uses is timestamp (type -1).
    case 0xd4:
      return decodeExt(r, 1);
    case 0xd5:
      return decodeExt(r, 2);
    case 0xd6:
      return decodeExt(r, 4);
    case 0xd7:
      return decodeExt(r, 8);
    case 0xd8:
      return decodeExt(r, 16);
    case 0xc7:
      return decodeExt(r, r.u8());
    case 0xc8: {
      const n = r.view.getUint16(r.offset);
      r.offset += 2;
      return decodeExt(r, n);
    }
    case 0xc9: {
      const n = r.view.getUint32(r.offset);
      r.offset += 4;
      return decodeExt(r, n);
    }
    default:
      throw new Error(`msgpack: unsupported tag 0x${tag.toString(16)}`);
  }
}

function decodeStr(r: Reader, n: number): string {
  return new TextDecoder().decode(r.take(n));
}

function decodeArray(r: Reader, n: number): MsgpackValue[] {
  const out: MsgpackValue[] = [];
  for (let i = 0; i < n; i++) out.push(decodeValue(r));
  return out;
}

function decodeMap(r: Reader, n: number): { [key: string]: MsgpackValue } {
  const out: { [key: string]: MsgpackValue } = {};
  for (let i = 0; i < n; i++) {
    const key = decodeValue(r);
    out[typeof key === "string" ? key : String(key)] = decodeValue(r);
  }
  return out;
}

/** Timestamp ext (type -1) decodes to epoch ms; other exts pass raw bytes. */
function decodeExt(r: Reader, n: number): MsgpackValue {
  const type = r.view.getInt8(r.offset++);
  const data = r.take(n);
  if (type !== -1) return data;
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  if (n === 4) return view.getUint32(0) * 1000;
  if (n === 8) {
    const raw = view.getBigUint64(0);
    const nanos = Number(raw >> 34n);
    const seconds = Number(raw & 0x3ffffffffn);
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  if (n === 12) {
    const nanos = view.getUint32(0);
    const seconds = Number(view.getBigInt64(4));
    return seconds * 1000 + Math.floor(nanos / 1e6);
  }
  return data;
}
