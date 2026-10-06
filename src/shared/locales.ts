export const LOCALES = ['en', 'fr-FR', 'fr-CA', 'pt-BR', 'pt-PT'] as const;
export type Locale = (typeof LOCALES)[number];
export const SOURCE_LOCALE: Locale = 'en';

export const LOCALE_LABELS: Record<Locale, string> = {
  en: 'English (source)',
  'fr-FR': 'Français (FR)',
  'fr-CA': 'Français (CA)',
  'pt-BR': 'Português (BR)',
  'pt-PT': 'Português (PT)',
};

export function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && (LOCALES as readonly string[]).includes(value);
}
