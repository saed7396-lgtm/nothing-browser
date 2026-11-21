import { FormEvent, KeyboardEvent, useCallback, useEffect, useRef, useState } from 'react';

interface SearchResult {
  title: string;
  url: string;
  displayUrl: string;
  snippet: string;
}

type ViewState =
  | { kind: 'idle' }
  | { kind: 'search'; query: string; loading: boolean; results: SearchResult[]; error?: string }
  | { kind: 'page'; url: string; loading: boolean };

function resolveInput(raw: string): { type: 'empty' } | { type: 'url'; url: string } | { type: 'search'; query: string } {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { type: 'empty' };
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return { type: 'url', url: trimmed };
  }

  if (!/\s/.test(trimmed) && /^[a-z0-9-]+(\.[a-z0-9-]+)+([/:?#].*)?$/i.test(trimmed)) {
    return { type: 'url', url: `https://${trimmed}` };
  }

  return { type: 'search', query: trimmed };
}

export default function App() {
  const [input, setInput] = useState('');
  const [view, setView] = useState<ViewState>({ kind: 'idle' });
  const inputRef = useRef<HTMLInputElement>(null);
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const searchAbortRef = useRef<AbortController | null>(null);
  // Ephemeral in-memory tab cache for 0ms instant Back/repeat search (cleared on close)
  const memSearchCacheRef = useRef<Map<string, SearchResult[]>>(new Map());

  const runSearch = useCallback(async (query: string, pushHistory = true) => {
    searchAbortRef.current?.abort();

    const cacheKey = query.toLowerCase();
    const cached = memSearchCacheRef.current.get(cacheKey);
    if (cached) {
      if (pushHistory) {
        window.history.pushState({ kind: 'search', query, results: cached }, '', window.location.pathname);
      }
      setInput(query);
      setView({ kind: 'search', query, loading: false, results: cached });
      return;
    }

    const controller = new AbortController();
    searchAbortRef.current = controller;

    if (pushHistory) {
      window.history.pushState({ kind: 'search', query }, '', window.location.pathname);
    }

    setInput(query);
    setView({ kind: 'search', query, loading: true, results: [] });

    try {
      const response = await fetch(`/api/search?q=${encodeURIComponent(query)}`, {
        signal: controller.signal,
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });

      if (!response.ok) {
        throw new Error('Search unavailable');
      }

      const data = (await response.json()) as { results?: SearchResult[] };
      const results = data.results ?? [];
      if (results.length > 0) {
        if (memSearchCacheRef.current.size > 30) memSearchCacheRef.current.clear();
        memSearchCacheRef.current.set(cacheKey, results);
      }

      setView({
        kind: 'search',
        query,
        loading: false,
        results,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return;
      setView({
        kind: 'search',
        query,
        loading: false,
        results: [],
        error: 'Could not reach search.',
      });
    }
  }, []);

  const openUrl = useCallback((url: string, pushHistory = true) => {
    searchAbortRef.current?.abort();
    if (pushHistory) {
      window.history.pushState({ kind: 'page', url }, '', window.location.pathname);
    }
    setInput(url);
    setView({ kind: 'page', url, loading: true });
  }, []);

  const resetToNothing = useCallback((pushHistory = true) => {
    searchAbortRef.current?.abort();
    if (pushHistory) {
      window.history.pushState({ kind: 'idle' }, '', window.location.pathname);
    }
    setInput('');
    setView({ kind: 'idle' });
  }, []);

  useEffect(() => {
    window.history.replaceState({ kind: 'idle' }, '', window.location.pathname);

    const onPopState = (event: PopStateEvent) => {
      const state = event.state as { kind?: string; query?: string; url?: string; results?: SearchResult[] } | null;
      if (!state || state.kind === 'idle') {
        resetToNothing(false);
      } else if (state.kind === 'search' && state.query) {
        if (state.results && state.results.length > 0) {
          setInput(state.query);
          setView({ kind: 'search', query: state.query, loading: false, results: state.results });
        } else {
          void runSearch(state.query, false);
        }
      } else if (state.kind === 'page' && state.url) {
        openUrl(state.url, false);
      } else {
        resetToNothing(false);
      }
    };

    window.addEventListener('popstate', onPopState);
    return () => {
      window.removeEventListener('popstate', onPopState);
      searchAbortRef.current?.abort();
    };
  }, [openUrl, resetToNothing, runSearch]);

  const handleSubmit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const resolved = resolveInput(input);

    if (resolved.type === 'empty') {
      if (view.kind !== 'idle') {
        resetToNothing(true);
      }
      return;
    }

    inputRef.current?.blur();

    if (resolved.type === 'url') {
      openUrl(resolved.url, true);
    } else {
      void runSearch(resolved.query, true);
    }
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape' && view.kind !== 'idle') {
      e.preventDefault();
      resetToNothing(true);
      inputRef.current?.focus();
    }
  };

  const handleIframeLoad = () => {
    setView((prev) => (prev.kind === 'page' ? { ...prev, loading: false } : prev));

    const doc = iframeRef.current?.contentDocument;
    if (!doc) return;

    const links = doc.querySelectorAll<HTMLAnchorElement>('a[href]');
    links.forEach((anchor) => {
      anchor.addEventListener('click', (event) => {
        const href = anchor.getAttribute('href');
        if (!href) return;
        if (href.startsWith('#')) return;
        if (href.startsWith('http://') || href.startsWith('https://')) {
          event.preventDefault();
          openUrl(href, true);
        }
      });
    });
  };

  const isIdle = view.kind === 'idle';

  return (
    <div className="min-h-dvh h-dvh w-full flex flex-col bg-neutral-50 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100 selection:bg-neutral-900 selection:text-white dark:selection:bg-neutral-100 dark:selection:text-neutral-950">
      {view.kind === 'search' && (
        <main className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 pt-8 pb-24">
          <div className="w-full max-w-2xl mx-auto">
            {view.loading ? (
              <div className="space-y-6 pt-2" aria-busy="true" aria-label="Searching">
                {[0, 1, 2, 3].map((item) => (
                  <div key={item} className="space-y-2 animate-pulse">
                    <div className="h-4 w-40 bg-neutral-200 dark:bg-neutral-800 rounded" />
                    <div className="h-5 w-3/4 bg-neutral-200 dark:bg-neutral-800 rounded" />
                    <div className="h-4 w-full bg-neutral-200/70 dark:bg-neutral-800/70 rounded" />
                  </div>
                ))}
              </div>
            ) : view.error ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 pt-4">{view.error}</p>
            ) : view.results.length === 0 ? (
              <p className="text-sm text-neutral-500 dark:text-neutral-400 pt-4">No results.</p>
            ) : (
              <ol className="divide-y divide-neutral-200/70 dark:divide-neutral-800/70">
                {view.results.map((result, idx) => (
                  <li key={`${result.url}-${idx}`} className="py-5 first:pt-0">
                    <button
                      type="button"
                      onClick={() => openUrl(result.url, true)}
                      className="w-full text-left group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-900/20 dark:focus-visible:ring-neutral-100/25 rounded-lg"
                    >
                      <span className="block text-xs text-neutral-500 dark:text-neutral-400 truncate mb-1">
                        {result.displayUrl}
                      </span>
                      <span className="block text-base font-medium text-neutral-900 dark:text-neutral-100 group-hover:underline underline-offset-4">
                        {result.title}
                      </span>
                      {result.snippet && (
                        <span className="block text-sm text-neutral-600 dark:text-neutral-400 mt-1.5 leading-relaxed line-clamp-2">
                          {result.snippet}
                        </span>
                      )}
                    </button>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </main>
      )}

      {view.kind === 'page' && (
        <main className="flex-1 min-h-0 relative bg-white dark:bg-neutral-950">
          {view.loading && (
            <div
              aria-hidden="true"
              className="absolute top-0 left-0 right-0 h-0.5 bg-neutral-900 dark:bg-neutral-100 animate-pulse z-10"
            />
          )}
          <iframe
            ref={iframeRef}
            title="nothing browser viewport"
            src={`/api/page?url=${encodeURIComponent(view.url)}`}
            sandbox="allow-same-origin"
            referrerPolicy="no-referrer"
            onLoad={handleIframeLoad}
            className="w-full h-full border-0 bg-white"
          />
        </main>
      )}

      <div
        className={
          isIdle
            ? 'flex-1 flex items-center justify-center px-4 sm:px-6'
            : 'fixed bottom-0 left-0 right-0 z-20 px-4 sm:px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] bg-neutral-50/90 dark:bg-neutral-950/90 backdrop-blur-md border-t border-neutral-200/80 dark:border-neutral-800/80'
        }
      >
        <form onSubmit={handleSubmit} role="search" className="w-full max-w-xl mx-auto">
          <input
            ref={inputRef}
            type="search"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Search or enter URL"
            aria-label="Search or enter URL"
            inputMode="search"
            enterKeyHint="go"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="none"
            spellCheck={false}
            autoFocus={isIdle}
            className="w-full min-h-[48px] h-12 sm:h-13 px-5 rounded-2xl bg-white dark:bg-neutral-900 border border-neutral-200 dark:border-neutral-800 text-[15px] text-neutral-900 dark:text-neutral-100 placeholder:text-neutral-400 dark:placeholder:text-neutral-500 shadow-xs transition-[border-color,box-shadow] duration-150 focus:outline-none focus-visible:border-neutral-400 dark:focus-visible:border-neutral-600 focus-visible:ring-2 focus-visible:ring-neutral-900/10 dark:focus-visible:ring-neutral-100/15"
          />
        </form>
      </div>
    </div>
  );
}
