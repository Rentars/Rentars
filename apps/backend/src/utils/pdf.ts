/**
 * Minimal zero-dependency PDF 1.4 builder.
 *
 * Produces valid, viewable PDF files using only Node's built-in Buffer.
 * Supports: text, lines, rectangles, basic font styling (Helvetica family).
 *
 * Usage:
 *   const pdf = new PdfBuilder();
 *   pdf.text('Hello', 60, 700, { size: 14, bold: true });
 *   const buf = pdf.build();
 */

// ─── Types ────────────────────────────────────────────────────────────────────

interface TextOptions {
  size?: number;
  bold?: boolean;
  italic?: boolean;
  colour?: string; // hex e.g. '#2563EB'
  align?: 'left' | 'center' | 'right';
  width?: number; // required for center/right alignment
}

interface RectOptions {
  fill?: string;  // hex colour
  stroke?: string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Convert a 6-digit hex colour to PDF r g b values (0–1 range).
 *
 * Only accepts complete six-digit hex strings (with or without a leading '#').
 * Partial, empty, or non-hex values silently fall back to black (0 0 0) so
 * that callers which pass a malformed colour never produce invalid PDF output
 * with incorrect or NaN RGB channel values (issue #485).
 */
export function hexToRgb(hex: string): [number, number, number] {
  const FALLBACK: [number, number, number] = [0, 0, 0];

  if (typeof hex !== 'string') return FALLBACK;

  const h = hex.replace('#', '');

  // Require exactly 6 hex digits — reject 3-digit shorthand, empty, or
  // strings with non-hex characters.
  if (!/^[0-9a-fA-F]{6}$/.test(h)) return FALLBACK;

  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  return [r, g, b];
}

/** Escape a string for use in a PDF string literal. */
function pdfStr(s: string): string {
  return s
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n');
}

/**
 * Approximate character width for Helvetica at size 1.
 * Uses a simplified table based on standard PDF metrics.
 */
function charWidth(ch: string, bold: boolean): number {
  // Most printable ASCII chars average ~0.55 em; digits and punctuation vary.
  const code = ch.charCodeAt(0);
  if (code < 32 || code > 126) return 0.55;
  // Narrower chars: i l j ! | : ; ' ,  .  (space)
  if (' |il;:.,!j\'"`'.includes(ch)) return 0.28;
  if ('frt'.includes(ch)) return 0.33;
  if ('mwMW'.includes(ch)) return 0.75;
  if ('bold'.includes(ch) && bold) return 0.6;
  return 0.55;
}

/** Measure the approximate width of a string in points at a given size. */
function measureText(text: string, size: number, bold = false): number {
  let w = 0;
  for (const ch of text) w += charWidth(ch, bold);
  return w * size;
}

// ─── PdfBuilder ───────────────────────────────────────────────────────────────

export class PdfBuilder {
  // A4 in points (1 pt = 1/72 inch)
  static readonly PAGE_WIDTH = 595.28;
  static readonly PAGE_HEIGHT = 841.89;

  private _stream: string[] = [];  // content stream commands
  private _fonts = new Set<string>(['F1', 'F2', 'F3', 'F4']); // always include all Helvetica variants

  // Add a content stream command
  private op(cmd: string) {
    this._stream.push(cmd);
  }

  // ── Drawing primitives ─────────────────────────────────────────────────────

  /** Draw a filled (and optionally stroked) rectangle. PDF y-axis: 0 = bottom. */
  rect(x: number, y: number, w: number, h: number, opts: RectOptions = {}): this {
    this.op(`${x} ${y} ${w} ${h} re`);
    if (opts.fill && opts.stroke) {
      const [r, g, b] = hexToRgb(opts.fill);
      this.op(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      const [sr, sg, sb] = hexToRgb(opts.stroke);
      this.op(`${sr.toFixed(3)} ${sg.toFixed(3)} ${sb.toFixed(3)} RG`);
      this.op('B');
    } else if (opts.fill) {
      const [r, g, b] = hexToRgb(opts.fill);
      this.op(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
      this.op('f');
    } else if (opts.stroke) {
      const [r, g, b] = hexToRgb(opts.stroke);
      this.op(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
      this.op('S');
    }
    return this;
  }

  /** Draw a horizontal line. */
  hline(x: number, y: number, w: number, colour = '#E5E7EB', width = 0.5): this {
    const [r, g, b] = hexToRgb(colour);
    this.op(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} RG`);
    this.op(`${width} w`);
    this.op(`${x} ${y} m`);
    this.op(`${x + w} ${y} l`);
    this.op('S');
    return this;
  }

  /**
   * Render text at position (x, y) where y is from the *top* of the page
   * (caller-friendly). Internally converted to PDF bottom-origin.
   */
  text(content: string, x: number, yFromTop: number, opts: TextOptions = {}): this {
    const size = opts.size ?? 10;
    const bold = opts.bold ?? false;
    const italic = opts.italic ?? false;
    const colour = opts.colour ?? '#111827';
    const align = opts.align ?? 'left';
    const width = opts.width ?? 0;

    // Font selection: F1=Helvetica, F2=Helvetica-Bold, F3=Helvetica-Oblique, F4=Helvetica-BoldOblique
    let fontRef = 'F1';
    if (bold && italic) fontRef = 'F4';
    else if (bold) fontRef = 'F2';
    else if (italic) fontRef = 'F3';

    const [r, g, b] = hexToRgb(colour);

    // Compute x offset for alignment
    let xPos = x;
    if ((align === 'center' || align === 'right') && width > 0) {
      const tw = measureText(content, size, bold);
      if (align === 'center') xPos = x + (width - tw) / 2;
      else xPos = x + width - tw;
    }

    const yPdf = PdfBuilder.PAGE_HEIGHT - yFromTop;

    this.op('BT');
    this.op(`/${fontRef} ${size} Tf`);
    this.op(`${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)} rg`);
    this.op(`${xPos.toFixed(2)} ${yPdf.toFixed(2)} Td`);
    this.op(`(${pdfStr(content)}) Tj`);
    this.op('ET');
    return this;
  }

  // ── PDF structure assembly ─────────────────────────────────────────────────

  /** Assemble and return the full PDF as a Buffer. */
  build(): Buffer {
    const lines: string[] = [];
    const offsets: number[] = [];
    let pos = 0;

    const emit = (s: string) => {
      lines.push(s);
      pos += Buffer.byteLength(s + '\n', 'latin1');
    };

    // ── Header
    emit('%PDF-1.4');

    // ── Object 1: Catalog
    offsets[1] = pos;
    emit('1 0 obj');
    emit('<< /Type /Catalog /Pages 2 0 R >>');
    emit('endobj');

    // ── Object 2: Pages
    offsets[2] = pos;
    emit('2 0 obj');
    emit('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    emit('endobj');

    // ── Object 3: Font resources
    const fontDict = [
      '/F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '/F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      '/F3 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>',
      '/F4 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-BoldOblique /Encoding /WinAnsiEncoding >>',
    ].join(' ');

    // ── Object 4: Content stream
    const streamBody = this._stream.join('\n');
    const streamBytes = Buffer.from(streamBody, 'latin1');

    offsets[4] = pos;
    emit('4 0 obj');
    emit(`<< /Length ${streamBytes.length} >>`);
    emit('stream');
    // Emit the stream body raw (may contain non-ascii in colour values — all ASCII here)
    lines.push(streamBody);
    pos += streamBytes.length + 1; // +1 for the newline after
    emit('endstream');
    emit('endobj');

    // ── Object 3: Page
    offsets[3] = pos;
    emit('3 0 obj');
    emit(`<< /Type /Page /Parent 2 0 R`);
    emit(`   /MediaBox [0 0 ${PdfBuilder.PAGE_WIDTH} ${PdfBuilder.PAGE_HEIGHT}]`);
    emit(`   /Resources << /Font << ${fontDict} >> >>`);
    emit(`   /Contents 4 0 R`);
    emit('>>');
    emit('endobj');

    // ── Cross-reference table
    const xrefPos = pos;
    emit('xref');
    emit(`0 ${offsets.length}`);
    emit('0000000000 65535 f ');
    for (let i = 1; i < offsets.length; i++) {
      emit(offsets[i].toString().padStart(10, '0') + ' 00000 n ');
    }

    // ── Trailer
    emit('trailer');
    emit(`<< /Size ${offsets.length} /Root 1 0 R >>`);
    emit('startxref');
    emit(String(xrefPos));
    emit('%%EOF');

    return Buffer.from(lines.join('\n'), 'latin1');
  }
}
