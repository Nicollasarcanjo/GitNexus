export type SupportedLanguage = 'pt-BR' | 'en';

export interface LanguageMetadata {
  code: SupportedLanguage;
  nativeName: string;
  englishName: string;
  dir: 'ltr' | 'rtl';
}

export const DEFAULT_LANGUAGE: SupportedLanguage = 'pt-BR';

export const SUPPORTED_LANGUAGES: LanguageMetadata[] = [
  {
    code: 'pt-BR',
    nativeName: 'Português (Brasil)',
    englishName: 'Portuguese (Brazil)',
    dir: 'ltr',
  },
  { code: 'en', nativeName: 'English', englishName: 'English', dir: 'ltr' },
];

export const SUPPORTED_LANGUAGE_CODES = SUPPORTED_LANGUAGES.map((language) => language.code);

export function normalizeSupportedLanguage(
  code: string | undefined | null,
): SupportedLanguage | null {
  const normalized = code?.trim().split('.')[0]?.replace(/_/g, '-').toLowerCase();
  if (!normalized) return null;
  if (normalized === 'en' || normalized.startsWith('en-')) return 'en';
  if (normalized === 'pt' || normalized.startsWith('pt-')) return 'pt-BR';
  return null;
}

export function getLanguageMetadata(code: string | undefined): LanguageMetadata {
  const normalized = normalizeSupportedLanguage(code);
  return (
    SUPPORTED_LANGUAGES.find((language) => language.code === normalized) ?? SUPPORTED_LANGUAGES[0]
  );
}
