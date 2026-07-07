/**
 * Ambient type declaration for `bidi-js` (MIT) — the package ships no `.d.ts`.
 * Only the surface kysigned uses is declared (see src/pdf/nameFont.ts). bidi-js
 * implements the Unicode Bidirectional Algorithm (UAX #9); `getReorderedString`
 * returns a string in VISUAL order (with mirrored characters replaced), which is
 * exactly what a left-to-right glyph placer like pdf-lib needs.
 */
declare module 'bidi-js' {
  export interface EmbeddingLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }

  export interface Bidi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl' | 'auto'): EmbeddingLevels;
    getReorderedString(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): string;
    getReorderedIndices(text: string, embeddingLevels: EmbeddingLevels, start?: number, end?: number): number[];
    getReorderSegments(
      text: string,
      embeddingLevels: EmbeddingLevels,
      start?: number,
      end?: number,
    ): Array<[number, number]>;
    getMirroredCharacter(char: string): string | null;
  }

  export default function bidiFactory(): Bidi;
}
