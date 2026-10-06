import type {Locale} from '../shared/types';
import type {LocaleStats} from '../shared/fallback';

export interface LocaleRow {
  key: string;
  sourceVersion: number;
  text: string | null;
  source: Locale | null;
  via: 'own' | 'fallback' | 'missing';
  ownState: 'missing' | 'blank' | 'text';
  version: number | null;
  stale: boolean;
}

export interface LocaleView {
  locale: Locale;
  chain: Locale[];
  stats: LocaleStats;
  rows: LocaleRow[];
}

export interface WorkbenchState {
  sourceLocale: Locale;
  locales: Locale[];
  chains: Record<Locale, Locale[]>;
  stats: LocaleStats[];
  perLocale: Record<Locale, LocaleView>;
}

export interface MessageDetailEntry {
  value: string | null;
  version: number;
  basedOnSourceVersion: number;
  stale: boolean;
}

export interface MessageDetail {
  key: string;
  sourceText: string;
  sourceVersion: number;
  entries: Partial<Record<Locale, MessageDetailEntry | null>>;
}

async function jsonOrThrow(response: Response) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(body.error ?? `HTTP ${response.status}`), {response, body});
  return body;
}

export const api = {
  state(): Promise<WorkbenchState> {
    return fetch('/api/state').then(jsonOrThrow);
  },
  localeView(locale: Locale): Promise<LocaleView> {
    return fetch(`/api/locales/${locale}`).then(jsonOrThrow);
  },
  message(key: string): Promise<MessageDetail> {
    return fetch(`/api/messages/${key}`).then(jsonOrThrow);
  },
  setChain(locale: Locale, chain: Locale[]): Promise<WorkbenchState> {
    return fetch(`/api/fallbacks/${locale}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({chain}),
    }).then(jsonOrThrow);
  },
  saveSource(key: string, text: string) {
    return fetch(`/api/messages/${key}/source`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text}),
    }).then(jsonOrThrow);
  },
  saveTranslation(
    key: string,
    locale: Locale,
    payload: {value: string | null; expectedVersion: number | null; editor: number; seq: number; force?: boolean},
  ) {
    return fetch(`/api/messages/${key}/translations/${locale}`, {
      method: 'PUT',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify(payload),
    }).then(async response => ({status: response.status, body: await response.json().catch(() => ({}))}));
  },
  review(key: string, locale: Locale) {
    return fetch(`/api/messages/${key}/review/${locale}`, {method: 'POST'}).then(jsonOrThrow);
  },
  preview(text: string, locale: Locale, values: Record<string, number | string>) {
    return fetch('/api/preview', {
      method: 'POST',
      headers: {'content-type': 'application/json'},
      body: JSON.stringify({text, locale, values}),
    }).then(jsonOrThrow);
  },
};
