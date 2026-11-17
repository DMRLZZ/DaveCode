import './styles.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { AuthGate } from './components/auth/AuthGate';
import { isApiError } from './lib/api';
import { DataProvider } from './lib/data';
import { preferencesBridge } from './lib/desktop';
import { loadPreferences } from './lib/preferences';
import { updateSettings } from './lib/settings';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 10_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        // Client errors will not fix themselves; retry transient failures twice.
        if (isApiError(err) && err.status >= 400 && err.status < 500) return false;
        return count < 2;
      },
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('#root element missing from index.html');

// The preferences decide the theme and whether to skip the sign-in screen, so they are read
// before anything is painted. In the desktop app they come from the app, not this page.
const preferences = await loadPreferences();
if (preferencesBridge()) updateSettings({ theme: preferences.colorMode });

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <AuthGate>
        <DataProvider>
          <App />
        </DataProvider>
      </AuthGate>
    </QueryClientProvider>
  </StrictMode>,
);
