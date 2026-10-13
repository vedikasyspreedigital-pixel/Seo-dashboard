import { useCallback, useState } from 'react';

// Dashboard colour theme. Dark is the default; the choice is remembered per
// browser. index.html applies the saved theme before first paint (no flash),
// this hook only reads/changes it. Purely visual -- the client report PDF and
// emails are not affected.

export type Theme = 'dark' | 'light';
const STORAGE_KEY = 'serp-console-theme';

function currentTheme(): Theme {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
}

export function useTheme() {
  const [theme, setThemeState] = useState<Theme>(currentTheme);
  const setTheme = useCallback((next: Theme) => {
    document.documentElement.dataset.theme = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // storage blocked (private window) -- the theme still applies for this visit
    }
    setThemeState(next);
  }, []);
  const toggleTheme = useCallback(() => setTheme(currentTheme() === 'light' ? 'dark' : 'light'), [setTheme]);
  return { theme, setTheme, toggleTheme };
}
