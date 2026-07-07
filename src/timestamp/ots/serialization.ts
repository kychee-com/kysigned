/**
 * OpenTimestamps wire primitives — F-2 / F-5 / AC-9.
 *
 * The `.ots` format is a byte stream of: fixed bytes, base-128 varuints, and
 * length-prefixed varbytes. These are the documented OTS encodings, written from
 * the protocol spec (no `opentimestamps` dependency). Arithmetic (not bit-shift)
 * is used for varuints so values above 2^31 are handled safely.
 */

export class Writer {
  private chunks: number[] = [];

  writeByte(b: number): void {
    this.chunks.push(b & 0xff);
  }

  writeBytes(bytes: Uint8Array | readonly number[]): void {
    for (const b of bytes) this.chunks.push(b & 0xff);
  }

  /** Unsigned base-128 varint (LEB128). */
  writeVaruint(n: number): void {
    if (!Number.isInteger(n) || n < 0) {
      throw new Error('varuint must be a non-negative integer');
    }
    if (n === 0) {
      this.chunks.push(0);
      return;
    }
    while (n !== 0) {
      let b = n % 128;
      n = Math.floor(n / 128);
      if (n !== 0) b |= 0x80;
      this.chunks.push(b);
    }
  }

  /** Length-prefixed bytes: varuint(length) then the bytes. */
  writeVarbytes(bytes: Uint8Array): void {
    this.writeVaruint(bytes.length);
    this.writeBytes(bytes);
  }

  getBytes(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

export class Reader {
  private pos = 0;

  constructor(private readonly buf: Uint8Array) {}

  get offset(): number {
    return this.pos;
  }

  get remaining(): number {
    return this.buf.length - this.pos;
  }

  atEnd(): boolean {
    return this.pos >= this.buf.length;
  }

  readByte(): number {
    if (this.pos >= this.buf.length) throw new Error('unexpected end of OTS stream');
    return this.buf[this.pos++];
  }

  readBytes(n: number): Uint8Array {
    if (n < 0 || this.pos + n > this.buf.length) throw new Error('unexpected end of OTS stream');
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }

  /** Read an unsigned base-128 varint (LEB128). */
  readVaruint(): number {
    let result = 0;
    let factor = 1;
    for (;;) {
      const b = this.readByte();
      result += (b & 0x7f) * factor;
      if ((b & 0x80) === 0) break;
      factor *= 128;
      if (factor > Number.MAX_SAFE_INTEGER) throw new Error('varuint too large');
    }
    return result;
  }

  /** Read length-prefixed bytes; `max` bounds the declared length. */
  readVarbytes(max = 0xffffffff): Uint8Array {
    const len = this.readVaruint();
    if (len > max) throw new Error(`varbytes too long: ${len} > ${max}`);
    return this.readBytes(len);
  }
}
