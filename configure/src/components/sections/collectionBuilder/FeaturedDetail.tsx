import { ChevronLeft, Layers, ListOrdered, Rows3 } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import type { BuilderEntry } from '@/lib/collectionBuilder/types';
import type { FeaturedCollection } from '@/lib/collectionBuilder/featured';

interface FeaturedDetailProps {
  featured: FeaturedCollection;
  entries: BuilderEntry[];
  index: number;
  busy: boolean;
  onSelect: (index: number) => void;
  onBack: () => void;
  onImport: () => void;
  /** The same live preview the builder renders, for the entry in view. */
  children: ReactNode;
}

export function FeaturedDetail({
  featured,
  entries,
  index,
  busy,
  onSelect,
  onBack,
  onImport,
  children,
}: FeaturedDetailProps) {
  return (
    <div className="mx-auto flex w-full max-w-6xl flex-col gap-4 px-1 pb-6 @3xl:h-full">
      <div className="flex flex-col gap-3 @2xl:flex-row @2xl:items-start @2xl:justify-between">
        <div className="min-w-0 space-y-1">
          <Button variant="ghost" size="sm" className="-ml-2 h-7" onClick={onBack}>
            <ChevronLeft className="mr-1 h-4 w-4" /> All featured
          </Button>
          <h2 className="truncate text-base font-semibold">{featured.name}</h2>
          <p className="text-xs text-muted-foreground">
            by {featured.author} · {entries.length} {entries.length === 1 ? 'entry' : 'entries'} ·{' '}
            {featured.catalogs} catalogs
          </p>
        </div>
        <div className="flex items-center justify-between gap-3 @2xl:justify-end">
          <span className="text-xs text-amber-500">Just looking. Nothing is imported yet.</span>
          <Button className="shrink-0" disabled={busy} onClick={onImport}>Import this</Button>
        </div>
      </div>

      <div className="grid gap-4 @3xl:min-h-0 @3xl:flex-1 @3xl:grid-cols-[18rem_minmax(0,1fr)]">
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-lg border p-2 @3xl:max-h-none @3xl:min-h-0">
          {entries.map((entry, at) => {
            const Icon = entry.kind === 'collection' ? Layers : entry.numbered ? ListOrdered : Rows3;
            return (
              <button
                key={entry.id || at}
                type="button"
                onClick={() => onSelect(at)}
                aria-pressed={at === index}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors ${
                  at === index ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent/50'
                }`}
              >
                <Icon
                  className={`h-4 w-4 shrink-0 ${
                    entry.kind === 'collection' ? 'text-cyan-400' : 'text-violet-400'
                  }`}
                />
                <span className="truncate">{entry.title || 'Untitled'}</span>
              </button>
            );
          })}
        </div>

        <div className="rounded-lg border p-4 @3xl:min-h-0 @3xl:overflow-y-auto">{children}</div>
      </div>
    </div>
  );
}
