import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { useMemo } from 'react';
import { cn } from '../lib/cn';

/** Render brain markdown (STATE.md, ARCHITECTURE.md). Output is sanitized with DOMPurify. */
export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => {
    const raw = marked.parse(source, { async: false, gfm: true, breaks: false });
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [source]);

  return (
    <div
      className={cn('prose-dc', className)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: sanitized by DOMPurify above
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
