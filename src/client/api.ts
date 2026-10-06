import type {Locale} from '../shared/locales';
import type {StoredTranslation, WorkbenchState} from '../shared/model';
import type {Values} from '../shared/message';
import type {ResolvedCell} from '../shared/model';

export interface ResolveResult extends ResolvedCell {
  rendered: string;
}

async function request<T>(input: string, init?: RequestInit): Promise<T> {
  const response = await fetch(input, {
    headers: {'content-type': 'application/json'},
    ...init,
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw Object.assign(new Error(body.error ?? `request failed (${response.status})`), {
      status: response.status,
      body,
    });
  }
  return body as T;
}

export const api = {
  state: () => request<WorkbenchState>('/api/state'),

  resolve: (locale: Locale, key: string, values: Values, delayMs?: number) =>
    request<ResolveResult>('/api/resolve', {
      method: 'POST',
      body: JSON.stringify({locale, key, values, _delay: delayMs}),
    }),

  setChain: (locale: Locale, chain: Locale[]) =>
    request<{locale: Locale; chain: Locale[]}>(`/api/fallback/${locale}`, {
      method: 'PUT',
      body: JSON.stringify({chain}),
    }),

  saveTranslation: (
    key: string,
    locale: Locale,
    text: string,
    baseVersion: number,
    delayMs?: number,
  ) =>
    request<{key: string; locale: Locale; cell: StoredTranslation}>(
      `/api/keys/${encodeURIComponent(key)}/translations/${locale}`,
      {method: 'PUT', body: JSON.stringify({text, baseVersion, _delay: delayMs})},
    ),

  markReviewed: (key: string, locale: Locale) =>
    request<{cell: StoredTranslation}>(
      `/api/keys/${encodeURIComponent(key)}/translations/${locale}/review`,
      {method: 'POST', body: '{}'},
    ),

  saveSource: (key: string, source: string, baseVersion: number) =>
    request<{record: WorkbenchState['keys'][number]}>(
      `/api/keys/${encodeURIComponent(key)}/source`,
      {method: 'PUT', body: JSON.stringify({source, baseVersion})},
    ),

  addKey: (key: string, source: string) =>
    request<WorkbenchState['keys'][number]>('/api/keys', {
      method: 'POST',
      body: JSON.stringify({key, source}),
    }),
};
