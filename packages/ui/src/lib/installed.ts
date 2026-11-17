import { useEffect, useState } from 'react';
import { detectInstalled } from './desktop';

/** Which agent CLIs or Windows shells are installed; undefined until the app answers. */
export function useInstalled(what: 'agents' | 'shells'): Map<string, boolean> | undefined {
  const [found, setFound] = useState<Map<string, boolean>>();
  useEffect(() => {
    let live = true;
    void detectInstalled(what).then((map) => {
      if (live) setFound(map);
    });
    return () => {
      live = false;
    };
  }, [what]);
  return found;
}
