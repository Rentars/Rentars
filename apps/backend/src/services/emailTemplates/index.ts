/**
 * Email template i18n system — Issue 645
 *
 * Each locale file exports an `EmailTemplateMessages` object whose keys are
 * notification template IDs and values are functions that receive typed data
 * and return `{ subject, preheader, body }` strings.
 *
 * Safe variable substitution:
 *  - Data is passed as typed objects, never as raw template-string interpolation
 *    on the caller side.
 *  - All values inserted into HTML bodies are passed through escapeHtml()
 *    from emailLayout.ts before the final render.
 *  - Each template records its own `templateVersion` string so a delivered
 *    notification can be traced back to the exact copy it used.
 *
 * Fallback strategy:
 *  - getEmailTemplates(locale) returns the locale's messages if available,
 *    otherwise falls back to 'en'.
 *  - A missing key within a locale also falls back to 'en'.
 *  - This means adding a new template to 'en' is safe before other locales
 *    are translated.
 */

import type { Locale } from './locales/types.js';
import en from './locales/en.js';
import es from './locales/es.js';
import fr from './locales/fr.js';
import pt from './locales/pt.js';

export type { EmailTemplateMessages, TemplateData } from './locales/types.js';
export type { Locale };

const LOCALE_MAP: Record<Locale, typeof en> = { en, es, fr, pt };

/**
 * Returns the template messages for the given locale, falling back to 'en'
 * for any keys that are missing in the requested locale.
 */
export function getEmailTemplates(locale: Locale = 'en'): typeof en {
  const messages = LOCALE_MAP[locale] ?? en;
  // Merge: fill any missing keys from the English fallback
  return new Proxy(messages, {
    get(target, key: string) {
      return (target as any)[key] ?? (en as any)[key];
    },
  }) as typeof en;
}

export const SUPPORTED_EMAIL_LOCALES: ReadonlyArray<Locale> = ['en', 'es', 'fr', 'pt'];

export function isValidEmailLocale(value: unknown): value is Locale {
  return SUPPORTED_EMAIL_LOCALES.includes(value as Locale);
}

/**
 * Current template version — bump this string whenever template copy changes
 * so delivered notifications can be traced to their exact version.
 */
export const TEMPLATE_VERSION = '2026-09-27.1';
