import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * Run an async loader and track loading / error / data.
 * `deps` re-run the loader; `reload()` re-runs it manually.
 */
export function useAsync(loader, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const loaderRef = useRef(loader);
  useLayoutEffect(() => {
    loaderRef.current = loader;
  });
  const requestId = useRef(0);

  const run = useCallback(async ({ silent = false } = {}) => {
    const id = ++requestId.current;
    if (!silent) setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await loaderRef.current();
      if (id === requestId.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (id === requestId.current) setState((s) => ({ ...s, error, loading: false }));
    }
  }, []);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, reload: run };
}

/** Wrap an async action with a pending flag. */
export function useAction(action) {
  const [pending, setPending] = useState(false);
  const actionRef = useRef(action);
  useLayoutEffect(() => {
    actionRef.current = action;
  });
  const execute = useCallback(async (...args) => {
    setPending(true);
    try {
      return await actionRef.current(...args);
    } finally {
      setPending(false);
    }
  }, []);
  return [execute, pending];
}

export function useDebouncedValue(value, delay = 350) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(t);
  }, [value, delay]);
  return debounced;
}
