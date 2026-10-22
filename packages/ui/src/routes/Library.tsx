import { ArrowUpRight, BookOpen, Search } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Field';
import { PageHeader } from '../components/ui/Panel';
import { CREATIVE_RESOURCES, resourceBrief } from '../lib/creative-resources';
import { navigate } from '../lib/router';

const KINDS = ['All', 'Guidance', 'Components', 'Inspiration', 'AI tools'] as const;

export function Library() {
  const [kind, setKind] = useState<string>('All');
  const [query, setQuery] = useState('');
  const matching = CREATIVE_RESOURCES.filter(
    (resource) =>
      (kind === 'All' || resource.kind === kind) &&
      `${resource.name} ${resource.description}`.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Creative library"
        description="Find a direction before you build. A curated starting point for people with ideas, with guidance, components and real design references."
      />
      <div className="flex flex-wrap items-center gap-3">
        <fieldset className="flex flex-wrap gap-1" aria-label="Resource category">
          {KINDS.map((item) => (
            <Button
              key={item}
              variant={item === kind ? 'primary' : 'ghost'}
              onClick={() => setKind(item)}
              aria-pressed={item === kind}
            >
              {item}
            </Button>
          ))}
        </fieldset>
        <label htmlFor="creative-search" className="relative ml-auto w-full max-w-xs">
          <span className="sr-only">Find a creative resource</span>
          <Search aria-hidden className="absolute top-2.5 left-2.5 size-3.5 text-muted" />
          <Input
            id="creative-search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Find a resource…"
            className="pl-8"
          />
        </label>
      </div>
      <div className="grid gap-x-8 md:grid-cols-2 xl:grid-cols-3">
        {matching.map((resource) => (
          <article
            key={resource.id}
            className="flex flex-col items-start border-t border-line py-6"
          >
            <p className="text-[12px] text-accent-text">{resource.kind}</p>
            <h2 className="mt-3 text-[21px] font-medium tracking-tight text-fg">{resource.name}</h2>
            <p className="mt-3 max-w-sm flex-1 text-[13px] leading-6 text-muted">
              {resource.description}
            </p>
            <p className="mt-4 text-[11px] leading-5 text-muted">{resource.access}</p>
            <div className="mt-4 flex flex-wrap items-center gap-4">
              <Button
                size="sm"
                onClick={() => navigate(`/?brief=${encodeURIComponent(resourceBrief(resource))}`)}
              >
                Use in a goal
              </Button>
              <a
                href={resource.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-[12px] text-fg-2 hover:text-fg"
              >
                Visit source
                <ArrowUpRight aria-hidden className="size-3" />
              </a>
            </div>
          </article>
        ))}
      </div>
      {matching.length === 0 && (
        <p role="status" className="py-8 text-[13px] text-muted">
          No resources match. Try another name or category.
        </p>
      )}
      <div className="flex gap-3 border-t border-line pt-5 text-[12px] leading-6 text-muted">
        <BookOpen aria-hidden className="mt-1 size-4 shrink-0" />
        <p>
          These are curated references, not installed plugins. “Use in a goal” prepares a brief for
          your agent; it does not run code, fetch a site or connect an account. DaveCode includes
          its own design-quality guidance by default. Third-party resources keep their own licenses
          and access requirements.
        </p>
      </div>
    </div>
  );
}
