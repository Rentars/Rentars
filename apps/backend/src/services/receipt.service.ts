/**
 * Receipt service — generates a PDF receipt for a confirmed / completed
 * booking using the zero-dependency PdfBuilder utility (no npm installs).
 *
 * Included fields: property, stay dates, itemised price breakdown,
 * platform fee, total, booking id, and the on-chain escrow reference.
 */

import { supabase } from '@/config/supabase.js';
import { PdfBuilder } from '@/utils/pdf.js';
import type { ServiceResponse } from './index.js';

// ─── Constants ────────────────────────────────────────────────────────────────

const PLATFORM_FEE_RATE = 0.1; // 10 %
const EXPLORER_BASE = 'https://stellar.expert/explorer/public/tx';

// Layout (points, y measured from top of A4)
const ML = 60;
const W  = PdfBuilder.PAGE_WIDTH - ML - ML; // 475.28 pt

// Brand colours
const BLUE  = '#2563EB';
const WHITE = '#FFFFFF';
const DARK  = '#111827';
const MUTED = '#6B7280';
const LIGHT = '#F3F4F6';
const LINE  = '#E5E7EB';
const GREEN = '#059669';
const AMBER = '#D97706';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface ReceiptData {
  bookingId:       string;
  propertyTitle:   string;
  propertyAddress: string;
  checkIn:         string;
  checkOut:        string;
  nights:          number;
  pricePerNight:   number;
  subtotal:        number;
  platformFee:     number;
  total:           number;
  guestCount:      number;
  status:          string;
  escrowId?:       string;
  onChainId?:      number;
  createdAt:       string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Count the number of nights between two ISO date strings.
 *
 * Uses UTC-normalised date-only arithmetic so that DST transitions
 * (where a wall-clock day can be 23 or 25 hours long) never produce an
 * off-by-one result. Each "date" is treated as midnight UTC, regardless of
 * local timezone or DST rules.
 *
 * Returns at least 1 to handle same-day edge cases gracefully.
 */
export function calcNights(checkIn: string, checkOut: string): number {
  // Parse only the date portion (YYYY-MM-DD) and interpret it as UTC
  // midnight so DST offsets cannot inflate or deflate the difference.
  const parseUTCDate = (iso: string): number => {
    const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  const msPerDay = 86_400_000;
  const diff = parseUTCDate(checkOut) - parseUTCDate(checkIn);
  return Math.max(1, Math.round(diff / msPerDay));
}

function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric', month: 'short', year: 'numeric',
  });
}

// ─── Data layer ───────────────────────────────────────────────────────────────

export async function fetchReceiptData(
  bookingId: string,
): Promise<ServiceResponse<ReceiptData>> {
  if (!bookingId) return { success: false, error: 'Booking ID is required' };

  const { data: booking, error } = await supabase
    .from('bookings')
    .select(
      `id, property_id, tenant_id, check_in, check_out, guest_count,
       total_price, status, escrow_id, on_chain_id, created_at,
       properties ( title, address, city, country, price_per_night )`,
    )
    .eq('id', bookingId)
    .single();

  if (error || !booking) return { success: false, error: 'Booking not found' };

  const b = booking as {
    id: string; property_id: string; tenant_id: string;
    check_in: string; check_out: string; guest_count: number;
    total_price: number; status: string; escrow_id?: string;
    on_chain_id?: number; created_at: string;
    properties: { title: string; address?: string; city?: string; country?: string; price_per_night?: number } | null;
  };

  const prop         = b.properties;
  const pricePerNight = prop?.price_per_night ?? 0;
  const nights       = calcNights(b.check_in, b.check_out);
  const subtotal     = pricePerNight * nights;
  const platformFee  = Math.round(subtotal * PLATFORM_FEE_RATE * 100) / 100;
  const total        = b.total_price ?? subtotal + platformFee;
  const address      = [prop?.address, prop?.city, prop?.country].filter(Boolean).join(', ');

  return {
    success: true,
    data: {
      bookingId:       b.id,
      propertyTitle:   prop?.title ?? 'Rental Property',
      propertyAddress: address,
      checkIn:         b.check_in,
      checkOut:        b.check_out,
      nights,
      pricePerNight,
      subtotal,
      platformFee,
      total,
      guestCount:  b.guest_count,
      status:      b.status,
      escrowId:    b.escrow_id,
      onChainId:   b.on_chain_id,
      createdAt:   b.created_at,
    },
  };
}

// ─── PDF generation ───────────────────────────────────────────────────────────

export function generateReceiptPdf(data: ReceiptData): Buffer {
  const pdf = new PdfBuilder();
  let y = 50; // current y from top of page

  // ── Header bar ────────────────────────────────────────────────────────────
  // PdfBuilder.rect uses bottom-origin PDF coords; we convert here.
  // y=50 from top → PDF y = PAGE_HEIGHT - 50 - 60 (height) = 731.89
  const headerPdfY = PdfBuilder.PAGE_HEIGHT - y - 60;
  pdf.rect(ML, headerPdfY, W, 60, { fill: BLUE });

  pdf.text('Rentars',          ML + 14, y + 12, { size: 22, bold: true, colour: WHITE });
  pdf.text('Booking Receipt',  ML + 14, y + 38, { size: 10, colour: WHITE });
  pdf.text('RECEIPT',          ML + W - 80, y + 12, { size: 10, bold: true, colour: WHITE, align: 'right', width: 80 });
  pdf.text(fmtDate(data.createdAt), ML + W - 80, y + 28, { size: 8, colour: WHITE, align: 'right', width: 80 });

  y += 76;

  // ── Booking ID banner ────────────────────────────────────────────────────
  const bannerPdfY = PdfBuilder.PAGE_HEIGHT - y - 30;
  pdf.rect(ML, bannerPdfY, W, 30, { fill: LIGHT });
  pdf.text('BOOKING ID', ML + 10, y + 6,  { size: 7, colour: MUTED });
  pdf.text(data.bookingId, ML + 10, y + 16, { size: 8, bold: true, colour: DARK });
  pdf.text('STATUS',      ML + W - 90, y + 6,  { size: 7, colour: MUTED, align: 'right', width: 90 });
  const statusColour = ['Confirmed', 'confirmed', 'Completed', 'completed'].includes(data.status) ? GREEN : AMBER;
  pdf.text(data.status.toUpperCase(), ML + W - 90, y + 16, { size: 8, bold: true, colour: statusColour, align: 'right', width: 90 });

  y += 46;

  // ── Property ─────────────────────────────────────────────────────────────
  pdf.text(data.propertyTitle, ML, y, { size: 13, bold: true, colour: DARK });
  y += 18;
  if (data.propertyAddress) {
    pdf.text(data.propertyAddress, ML, y, { size: 9, colour: MUTED });
    y += 14;
  }
  y += 8;

  // ── Divider ──────────────────────────────────────────────────────────────
  pdf.hline(ML, PdfBuilder.PAGE_HEIGHT - y, W, LINE);
  y += 12;

  // ── Stay dates ────────────────────────────────────────────────────────────
  const col = W / 3;
  const dateFields: [string, string][] = [
    ['Check-in',  fmtDate(data.checkIn)],
    ['Check-out', fmtDate(data.checkOut)],
    ['Guests',    String(data.guestCount)],
  ];
  dateFields.forEach(([label, val], i) => {
    const x = ML + i * col;
    pdf.text(label, x, y,      { size: 8,  colour: MUTED });
    pdf.text(val,   x, y + 12, { size: 10, bold: true, colour: DARK });
  });
  y += 36;

  // ── Divider ──────────────────────────────────────────────────────────────
  pdf.hline(ML, PdfBuilder.PAGE_HEIGHT - y, W, LINE);
  y += 16;

  // ── Price breakdown heading ───────────────────────────────────────────────
  pdf.text('Price Breakdown', ML, y, { size: 11, bold: true, colour: DARK });
  y += 18;

  // Line-item helper
  const item = (label: string, value: string, bold = false, colour = MUTED) => {
    pdf.text(label, ML,        y, { size: bold ? 10 : 9, bold, colour: bold ? DARK : colour });
    pdf.text(value, ML + W - 120, y, { size: bold ? 10 : 9, bold, colour, width: 120, align: 'right' });
    y += bold ? 16 : 14;
  };

  item(
    `${data.pricePerNight} USDC x ${data.nights} night${data.nights !== 1 ? 's' : ''}`,
    `${data.subtotal.toFixed(2)} USDC`,
  );
  item('Platform fee (10%)', `${data.platformFee.toFixed(2)} USDC`);

  y += 4;
  pdf.hline(ML, PdfBuilder.PAGE_HEIGHT - y, W, LINE);
  y += 10;

  item('Total', `${data.total.toFixed(2)} USDC`, true, BLUE);
  y += 12;

  // ── Blockchain reference ─────────────────────────────────────────────────
  if (data.escrowId || data.onChainId !== undefined) {
    pdf.hline(ML, PdfBuilder.PAGE_HEIGHT - y, W, LINE);
    y += 14;
    pdf.text('Blockchain Reference', ML, y, { size: 11, bold: true, colour: DARK });
    y += 16;

    if (data.escrowId) {
      pdf.text('Escrow ID',    ML, y,      { size: 7, colour: MUTED });
      pdf.text(data.escrowId, ML, y + 10,  { size: 8, colour: DARK });
      y += 26;
    }

    if (data.onChainId !== undefined && data.onChainId !== null) {
      pdf.text('On-chain Booking ID',      ML, y,      { size: 7, colour: MUTED });
      pdf.text(String(data.onChainId),     ML, y + 10, { size: 8, colour: DARK });
      y += 26;
      pdf.text('Stellar Explorer',                    ML, y,      { size: 7, colour: MUTED });
      pdf.text(`${EXPLORER_BASE}/${data.onChainId}`,  ML, y + 10, { size: 8, colour: BLUE });
      y += 26;
    }
  }

  // ── Footer ────────────────────────────────────────────────────────────────
  const footerY = PdfBuilder.PAGE_HEIGHT - 60;
  pdf.hline(ML, footerY, W, LINE);
  pdf.text(
    'Automatically generated receipt — questions? support@rentars.app',
    ML, PdfBuilder.PAGE_HEIGHT - footerY + 8,
    { size: 7, colour: MUTED, align: 'center', width: W },
  );

  return pdf.build();
}
