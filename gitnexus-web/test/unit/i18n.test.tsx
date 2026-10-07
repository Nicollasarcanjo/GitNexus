import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import i18n, { LANGUAGE_STORAGE_KEY, i18nReady } from '../../src/i18n';
import { normalizeSupportedLanguage } from '../../src/i18n/languages';
import { namespaceList, resources } from '../../src/i18n/resources';
import { LanguageSwitcher } from '../../src/components/LanguageSwitcher';

function flattenKeys(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, nested]) =>
    flattenKeys(nested, prefix ? `${prefix}.${key}` : key),
  );
}

describe('web i18n', () => {
  afterEach(async () => {
    delete (i18n.getResourceBundle('en', 'settings') as Record<string, unknown> | undefined)
      ?.crossNamespaceProbe;
    delete (i18n.getResourceBundle('pt-BR', 'graph') as Record<string, unknown> | undefined)
      ?.crossNamespaceProbe;
    i18n.removeResourceBundle('en', 'fallback-test');
    await i18n.changeLanguage('en');
    window.localStorage.clear();
  });

  it('keeps every Portuguese namespace in step with its English counterpart', () => {
    expect(namespaceList).toContain('common');
    const ptNamespaces = Object.keys(resources['pt-BR'] ?? {});
    expect(ptNamespaces).toEqual(expect.arrayContaining(['common', 'errors', 'graph', 'header']));

    for (const namespace of ptNamespaces) {
      const enKeys = flattenKeys(resources.en?.[namespace]).sort();
      // Portuguese has a third plural category; `_many` has no English twin.
      const ptKeys = flattenKeys(resources['pt-BR']?.[namespace])
        .filter((key) => !key.endsWith('_many'))
        .sort();
      expect(ptKeys, namespace).toEqual(enKeys);
    }
  });

  it('switches to pt-BR, updates html lang, and returns Portuguese translations', async () => {
    await i18nReady;
    await i18n.changeLanguage('pt-BR');

    expect(i18n.t('common:progress.connecting')).toBe('Conectando ao servidor...');
    expect(document.documentElement.lang).toBe('pt-BR');
    expect(document.documentElement.dir).toBe('ltr');
  });

  it('falls back to English when the active language misses a key', async () => {
    await i18nReady;
    i18n.addResourceBundle('en', 'fallback-test', { only: 'Fallback only' });
    await i18n.changeLanguage('pt-BR');

    expect(i18n.t('fallback-test:only')).toBe('Fallback only');
  });

  it('does not fall back across unrelated namespaces', async () => {
    await i18nReady;
    i18n.addResource('en', 'settings', 'crossNamespaceProbe', 'English settings fallback');
    i18n.addResource('pt-BR', 'graph', 'crossNamespaceProbe', 'Wrong graph fallback');
    await i18n.changeLanguage('pt-BR');

    expect(i18n.t('settings:crossNamespaceProbe')).toBe('English settings fallback');
  });

  it('normalizes supported detector aliases and rejects unsupported languages', () => {
    expect(normalizeSupportedLanguage('pt')).toBe('pt-BR');
    expect(normalizeSupportedLanguage('pt-br')).toBe('pt-BR');
    expect(normalizeSupportedLanguage('pt_BR.UTF-8')).toBe('pt-BR');
    expect(normalizeSupportedLanguage('en-US')).toBe('en');
    expect(normalizeSupportedLanguage('fr')).toBeNull();
    expect(normalizeSupportedLanguage('zh-CN')).toBeNull();
  });

  it('does not cache unsupported language codes', async () => {
    await i18nReady;
    window.localStorage.clear();

    await i18n.changeLanguage('fr');

    await waitFor(() => expect(document.documentElement.lang).toBe('pt-BR'));
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).not.toBe('fr');
    expect((i18n.options.detection as { caches?: string[] }).caches).toEqual([]);
  });

  it('persists language changes from the header switcher', async () => {
    await i18nReady;
    const user = userEvent.setup();
    render(<LanguageSwitcher />);

    await user.selectOptions(screen.getByLabelText('Select language'), 'pt-BR');

    await waitFor(() => expect(document.documentElement.lang).toBe('pt-BR'));
    expect(i18n.t('common:progress.connecting')).toBe('Conectando ao servidor...');
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
  });
});
