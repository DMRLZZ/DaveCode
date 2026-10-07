import { createContext, type ReactNode, useContext } from 'react';
import { PLAIN_THEME, type Theme } from '../ui/theme';

const ThemeContext = createContext<Theme>(PLAIN_THEME);

export function ThemeProvider({ theme, children }: { theme: Theme; children?: ReactNode }) {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
