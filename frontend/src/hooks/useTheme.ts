import { useCallback, useState } from 'react';

// Dashboard colour theme, picked in Settings (the header button flips between
// black and white). Dark is the default; the choice is remembered per
// browser. index.html applies the saved theme before first paint (no flash),
// this hook only reads/changes it. Purely visual -- the client report PDF and
// emails are not affected.

export type Theme = 'dark' | 'light' | 'violet';
const STORAGE_KEY = 'serp-console-theme';

export const THEMES: { value: Theme; name: string; description: string; swatches: string[] }[] = [
  { value: 'dark', name: 'Black + Orange', description: 'Flat black, white buttons, orange details', swatches: ['#0c0c0c', '#1a1a1a', '#f5f5f5', '#dc5532', '#f08a6c'] },
  { value: 'light', name: 'White + Orange', description: 'Flat white, black buttons, orange details', swatches: ['#ffffff', '#f4f4f4', '#141414', '#dc5532', '#d9532f'] },
  { value: 'violet', name: 'Violet', description: 'The original look: violet gradients, glow and grid', swatches: ['#050507', '#121117', '#9b5cff', '#7c3aed', '#c4a6ff'] },
];

function currentTheme(): Theme {
  const t = document.documentElement.dataset.theme;
  return t === 'light' || t === 'violet' ? t : 'dark';
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
