import {useCallback, useEffect, useMemo, useState} from 'react';
import {Languages} from 'lucide-react';
import type {Locale} from '../shared/locales';
import type {StoredTranslation, WorkbenchState} from '../shared/model';
import {allStats, resolveLocale} from '../shared/resolve';
import {api} from './api';
import {LocaleTabs} from './LocaleTabs';
import {KeyList} from './KeyList';
import {Editor} from './Editor';
import {PreviewPane} from './PreviewPane';
import {FallbackEditor} from './FallbackEditor';
import {useSaveQueue} from './useSaveQueue';

export default function App() {
  const [state, setState] = useState<WorkbenchState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locale, setLocale] = useState<Locale>('fr-CA');
  const [selectedKey, setSelectedKey] = useState<string>('checkout.title');
  const [showFallback, setShowFallback] = useState(false);

  const refresh = useCallback(async () => {
    const next = await api.state();
    setState(next);
  }, []);

  useEffect(() => {
    refresh().catch(caught => setError(caught instanceof Error ? caught.message : 'failed to load'));
  }, [refresh]);

  // A confirmed save is patched into the local snapshot immediately. The
  // list/stats all derive from `state`, so there is no second cache that
  // could keep showing a stale result.
  const onSaved = useCallback((key: string, savedLocale: Locale, cell: StoredTranslation) => {
    setState(previous => {
      if (!previous) return previous;
      return {
        ...previous,
        keys: previous.keys.map(record =>
          record.key !== key
            ? record
            : {...record, translations: {...record.translations, [savedLocale]: cell}},
        ),
      };
    });
  }, []);

  const saves = useSaveQueue({onSaved});

  const switchLocale = useCallback(
    (next: Locale) => {
      if (next === locale) return;
      saves.flushLocale(locale); // late saves must never touch the new locale
      saves.clearConflict();
      setLocale(next);
    },
    [locale, saves],
  );

  const cells = useMemo(
    () => (state ? resolveLocale(state, locale) : []),
    [state, locale],
  );
  const stats = useMemo(() => (state ? allStats(state) : []), [state]);
  const record = state?.keys.find(entry => entry.key === selectedKey) ?? null;
  const cell = cells.find(entry => entry.key === selectedKey) ?? null;

  const saveChain = async (chain: Locale[]) => {
    await api.setChain(locale, chain);
    await refresh(); // list, stats and resolve all read the new graph
  };

  if (error) {
    return (
      <main className="shell">
        <p className="fatal">⚠ {error}</p>
      </main>
    );
  }
  if (!state || !record || !cell) {
    return (
      <main className="shell">
        <p className="fatal">Loading workbench…</p>
      </main>
    );
  }

  return (
    <main className="shell">
      <header className="topbar">
        <Languages size={20} />
        <span className="brand">Locale Workbench</span>
        <small>fallback-aware translation state</small>
        <button type="button" className="ghost" onClick={() => setShowFallback(value => !value)}>
          {showFallback ? 'Close fallback settings' : 'Fallback chains'}
        </button>
      </header>

      <LocaleTabs active={locale} stats={stats} onSelect={switchLocale} />

      {showFallback && (
        <div className="fallback-drawer">
          <FallbackEditor locale={locale} chain={state.fallback[locale] ?? []} onSave={saveChain} />
        </div>
      )}

      <section className="workspace">
        <KeyList
          cells={cells}
          selectedKey={selectedKey}
          stats={stats.find(entry => entry.locale === locale)!}
          onSelect={setSelectedKey}
        />
        <section className="pane editor-pane">
          <Editor
            locale={locale}
            record={record}
            cell={cell}
            saveStatus={saves.status}
            onSaveDraft={(text, baseVersion) =>
              saves.scheduleSave(selectedKey, locale, text, baseVersion)
            }
            onSaveSource={async (source, baseVersion) => {
              await api.saveSource(selectedKey, source, baseVersion);
              await refresh();
            }}
            onMarkReviewed={async () => {
              await api.markReviewed(selectedKey, locale);
              await refresh();
            }}
          />
          {saves.conflict && (
            <ConflictDialog
              conflict={saves.conflict}
              currentLocale={locale}
              onKeepMine={() => {
                const {serverCell, attemptedText, key} = saves.conflict!;
                saves.clearConflict();
                saves.scheduleSave(key, locale, attemptedText, serverCell.version);
              }}
              onTakeTheirs={() => {
                saves.clearConflict();
                refresh();
              }}
            />
          )}
        </section>
        <PreviewPane locale={locale} entryKey={selectedKey} text={cell.text} />
      </section>
    </main>
  );
}

function ConflictDialog({
  conflict,
  currentLocale,
  onKeepMine,
  onTakeTheirs,
}: {
  conflict: NonNullable<ReturnType<typeof useSaveQueue>['conflict']>;
  currentLocale: Locale;
  onKeepMine: () => void;
  onTakeTheirs: () => void;
}) {
  if (conflict.locale !== currentLocale) return null;
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <h3>Save conflict · {conflict.key}</h3>
        <p>Another translator saved a newer version while your save was in flight.</p>
        <div className="conflict-side">
          <h4>Server (v{conflict.serverCell.version})</h4>
          <pre>{conflict.serverCell.text}</pre>
        </div>
        <div className="conflict-side">
          <h4>Your unsaved text</h4>
          <pre>{conflict.attemptedText}</pre>
        </div>
        <div className="modal-actions">
          <button type="button" className="primary" onClick={onKeepMine}>
            Overwrite with mine
          </button>
          <button type="button" onClick={onTakeTheirs}>
            Discard mine, take theirs
          </button>
        </div>
      </div>
    </div>
  );
}
