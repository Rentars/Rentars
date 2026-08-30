/**
 * Shared email layout module — Rentars branded HTML wrapper and plaintext fallback.
 *
 * Usage:
 *   import { renderEmail } from '@/services/emailLayout.js';
 *
 *   const { html, text } = renderEmail({
 *     title: 'Booking Confirmed',
 *     body: '<p>Your booking is confirmed!</p>',
 *     preheader: 'Your stay at Sunset Villa is confirmed.',
 *     preferencesUrl: 'https://rentars.app/preferences/manage?token=xxx',
 *   });
 */

const BRAND_COLOR = '#2563EB'; // blue-600
const BRAND_COLOR_DARK = '#1D4ED8'; // blue-700
const FOOTER_BG = '#F9FAFB'; // gray-50
const TEXT_COLOR = '#111827'; // gray-900
const MUTED_COLOR = '#6B7280'; // gray-500
const BORDER_COLOR = '#E5E7EB'; // gray-200

const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://rentars.app';
const SUPPORT_URL = `${FRONTEND_URL}/support`;

export interface EmailTemplateOptions {
  /** Appears in the <title> tag and the pre-header preview text. */
  title: string;
  /**
   * Main body content — raw HTML. Keep it to semantic text elements:
   * <p>, <strong>, <a>, <ul>, <li>, <hr />, <table> etc.
   * Do NOT include <html>, <head>, or <body> — the layout wraps those.
   */
  body: string;
  /**
   * Short sentence shown as preview text in email clients (hidden in body).
   * Falls back to `title` if omitted.
   */
  preheader?: string;
  /**
   * Signed per-recipient URL to the preference management page.
   * When provided it appears as "Manage preferences · Unsubscribe" in the footer.
   * Omit for purely transactional security emails (password reset, etc.).
   */
  preferencesUrl?: string;
  /**
   * When true the email is marked as transactional / security-critical in the
   * footer copy so recipients understand it cannot be unsubscribed from.
   */
  isEssential?: boolean;
}

export interface RenderedEmail {
  html: string;
  text: string;
}

// ─── HTML renderer ────────────────────────────────────────────────────────────

/**
 * Wraps body HTML in the full branded Rentars email layout.
 * All styles are inlined for maximum email-client compatibility.
 */
export function renderEmail(options: EmailTemplateOptions): RenderedEmail {
  const { title, body, preheader, preferencesUrl, isEssential = false } = options;
  const previewText = preheader ?? title;

  const footerLinks = buildFooterLinks(preferencesUrl, isEssential);
  const essentialNotice = isEssential
    ? `<p style="margin:8px 0 0;font-size:12px;color:${MUTED_COLOR};">
         This is an essential account or security email. You will continue to receive it
         regardless of notification preferences.
       </p>`
    : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${escapeHtml(title)}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
</head>
<body style="margin:0;padding:0;background-color:#F3F4F6;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">

  <!-- Pre-header hidden preview text -->
  <span style="display:none;max-height:0;overflow:hidden;mso-hide:all;">
    ${escapeHtml(previewText)}&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;&#847;&zwnj;&nbsp;
  </span>

  <!-- Outer wrapper -->
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
         style="background-color:#F3F4F6;min-width:100%;">
    <tr>
      <td align="center" style="padding:32px 16px;">

        <!-- Card -->
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
               style="max-width:600px;background-color:#FFFFFF;border-radius:12px;border:1px solid ${BORDER_COLOR};overflow:hidden;">

          <!-- Header -->
          <tr>
            <td style="background-color:${BRAND_COLOR};padding:24px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <a href="${FRONTEND_URL}" style="text-decoration:none;">
                      <span style="font-size:22px;font-weight:700;color:#FFFFFF;letter-spacing:-0.5px;">
                        Rentars
                      </span>
                    </a>
                  </td>
                  <td align="right">
                    <span style="font-size:12px;color:rgba(255,255,255,0.75);">
                      Decentralized rental platform
                    </span>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td style="padding:32px 32px 24px;color:${TEXT_COLOR};font-size:16px;line-height:1.6;">
              ${body}
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color:${FOOTER_BG};border-top:1px solid ${BORDER_COLOR};padding:20px 32px;">
              <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td style="font-size:12px;color:${MUTED_COLOR};line-height:1.6;">
                    <p style="margin:0 0 6px;">${footerLinks}</p>
                    ${essentialNotice}
                    <p style="margin:8px 0 0;">
                      &copy; ${new Date().getFullYear()} Rentars &mdash;
                      <a href="${FRONTEND_URL}" style="color:${MUTED_COLOR};">${FRONTEND_URL.replace(/^https?:\/\//, '')}</a>
                    </p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>
</body>
</html>`;

  const text = renderPlaintext(options);

  return { html, text };
}

// ─── Plaintext renderer ───────────────────────────────────────────────────────

/**
 * Generates a clean plaintext fallback from the template options.
 * Strips HTML tags from `body` and appends footer links.
 */
export function renderPlaintext(options: EmailTemplateOptions): string {
  const { title, body, preferencesUrl, isEssential = false } = options;
  const stripped = stripHtml(body);

  const lines: string[] = [
    `RENTARS`,
    `${'─'.repeat(40)}`,
    ``,
    title.toUpperCase(),
    ``,
    stripped,
    ``,
    `${'─'.repeat(40)}`,
    `Need help? ${SUPPORT_URL}`,
  ];

  if (preferencesUrl) {
    lines.push(`Manage notification preferences: ${preferencesUrl}`);
  }

  if (isEssential) {
    lines.push(
      `This is a required account or security notification — it cannot be unsubscribed from.`,
    );
  }

  lines.push(``, `© ${new Date().getFullYear()} Rentars — ${FRONTEND_URL}`);

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildFooterLinks(preferencesUrl: string | undefined, isEssential: boolean): string {
  const supportLink = `<a href="${SUPPORT_URL}" style="color:${MUTED_COLOR};text-decoration:underline;">Support</a>`;

  if (isEssential) {
    return `${supportLink} &middot; This email is required for account security and cannot be disabled.`;
  }

  if (preferencesUrl) {
    const absoluteUrl = preferencesUrl.startsWith('http') ? preferencesUrl : `${FRONTEND_URL}${preferencesUrl}`;
    const prefsLink = `<a href="${escapeHtmlAttribute(absoluteUrl)}" style="color:${MUTED_COLOR};text-decoration:underline;">Manage preferences</a>`;
    const unsubLink = `<a href="${escapeHtmlAttribute(absoluteUrl)}&unsubscribe=1" style="color:${MUTED_COLOR};text-decoration:underline;">Unsubscribe</a>`;
    return `${supportLink} &middot; ${prefsLink} &middot; ${unsubLink}`;
  }

  return supportLink;
}

/** Minimal HTML escaping for user-supplied strings placed in HTML context. */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

/** Escape strings for use in HTML attributes (double-quoted). */
function escapeHtmlAttribute(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Strip HTML tags for plaintext generation. */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(h[1-6]|p|div|section|article|blockquote)>/gi, '\n')
    .replace(/<\/li>/gi, '\n')
    .replace(/<\/tr>/gi, '\n')
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, '')
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
