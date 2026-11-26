function toCsvCell(value: unknown): string {
  const cell = value instanceof Date ? value.toISOString() : String(value ?? '');
  if (/[",\n]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

export function rowsToCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers, ...rows].map((row) => row.map(toCsvCell).join(','));
  return lines.join('\n');
}

export function downloadCsv(
  filename: string,
  headers: string[],
  rows: Array<Array<unknown>>
): void {
  const csv = rowsToCsv(headers, rows);
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

export type ExportKind = 'host-report' | 'admin-report' | 'listing-data' | 'financials';

export interface ExportRequest {
  kind: ExportKind;
  /** Optional account scope; server enforces ownership regardless. */
  accountId?: string;
  /** Optional date range for the export. */
  from?: string;
  to?: string;
}

export interface ExportReference {
  /** Short-lived, single-use download URL issued by the server. */
  url: string;
  /** ISO timestamp after which the URL is no longer valid. */
  expiresAt: string;
  /** Identifier for auditing the export action. */
  exportId: string;
}

export class ExportRequestError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = 'ExportRequestError';
  }
}

/**
 * Request a server-generated export for a sensitive dataset.
 *
 * The server is responsible for applying the per-role export projection,
 * enforcing ownership, recording the export action for auditing, and
 * generating the file in a bounded-memory manner. The client only receives
 * a short-lived download reference.
 */
export async function requestExport(
  request: ExportRequest,
  options: { signal?: AbortSignal } = {}
): Promise<ExportReference> {
  const response = await fetch('/api/exports', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(request),
    credentials: 'same-origin',
    signal: options.signal,
  });

  if (!response.ok) {
    let message = `Export request failed (${response.status})`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body?.error) message = body.error;
    } catch {
      // ignore parse errors; fall back to generic message
    }
    throw new ExportRequestError(message, response.status);
  }

  const data = (await response.json()) as Partial<ExportReference>;
  if (!data.url || !data.expiresAt || !data.exportId) {
    throw new ExportRequestError('Malformed export reference from server');
  }
  return { url: data.url, expiresAt: data.expiresAt, exportId: data.exportId };
}

/**
 * Open a short-lived export download URL. The URL is validated for expiry
 * before being opened; the server still enforces ownership and expiry.
 */
export function openExportDownload(reference: ExportReference): void {
  const expiresAt = Date.parse(reference.expiresAt);
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    throw new ExportRequestError('Export link has expired');
  }
  const link = document.createElement('a');
  link.href = reference.url;
  link.rel = 'noopener noreferrer';
  link.target = '_blank';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

/**
 * Convenience helper: request a server-generated export and open its
 * short-lived download URL.
 */
export async function downloadExport(
  request: ExportRequest,
  options: { signal?: AbortSignal } = {}
): Promise<ExportReference> {
  const reference = await requestExport(request, options);
  openExportDownload(reference);
  return reference;
}