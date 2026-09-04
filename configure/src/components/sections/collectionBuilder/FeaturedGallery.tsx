import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { FeaturedCollection } from '@/lib/collectionBuilder/featured';

interface FeaturedGalleryProps {
  items: FeaturedCollection[];
  /** Catalog slots left, so a design that will not fit says so before it is loaded. */
  headroom: number;
  busy: boolean;
  error?: string;
  onLoad: (featured: FeaturedCollection) => void;
}

const CHIP = 'rounded-full border px-2.5 py-1 text-xs leading-4 whitespace-nowrap';

export function FeaturedGallery({ items, headroom, busy, error, onLoad }: FeaturedGalleryProps) {
  return (
    <div className="mx-auto w-full max-w-6xl space-y-5 px-1 pb-6">
      <div className="space-y-1">
        <h2 className="flex items-center gap-2 text-base font-semibold">
          <Sparkles className="h-5 w-5 text-amber-400" />
          Featured collections
        </h2>
        <p className="text-sm text-muted-foreground">
          Ready-made layouts shared by their authors. Preview one to see what it holds before anything
          is added, then import it whole or keep only the parts you want.
        </p>
      </div>

      {error && <p className="text-sm text-amber-500">{error}</p>}

      <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,22rem),1fr))]">
        {items.map(featured => {
          const overBudget = featured.catalogs > headroom;
          return (
            <div
              key={featured.id}
              className="flex flex-col overflow-hidden rounded-xl border transition-colors hover:border-amber-500/40"
            >
              <div className="flex items-start gap-3 border-b bg-gradient-to-br from-amber-500/10 to-transparent p-4">
                <Sparkles className="mt-0.5 h-5 w-5 shrink-0 text-amber-400" />
                <div className="min-w-0">
                  <p className="truncate font-medium">{featured.name}</p>
                  <a
                    href={featured.authorUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                  >
                    by {featured.author}
                  </a>
                </div>
              </div>

              <div className="flex flex-1 flex-col gap-3 p-4">
                <p className="text-sm text-muted-foreground">{featured.summary}</p>

                <div className="flex flex-wrap gap-1.5">
                  <span className={`${CHIP} border-border text-muted-foreground`}>
                    {featured.detail.split(',')[0]}
                  </span>
                  <span
                    className={`${CHIP} ${
                      overBudget ? 'border-amber-600/50 text-amber-500' : 'border-border text-muted-foreground'
                    }`}
                    title={
                      overBudget
                        ? `Room for ${headroom}. You can still take the layout without the catalogs.`
                        : `Room for ${headroom}.`
                    }
                  >
                    {featured.catalogs} catalogs
                  </span>
                  {featured.classicRows ? (
                    <span
                      className={`${CHIP} border-border text-muted-foreground`}
                      title="Nuvio has no equivalent and skips them; Fusion keeps them."
                    >
                      {featured.classicRows} classic rows
                    </span>
                  ) : null}
                </div>

                {featured.note && <p className="text-xs text-muted-foreground">{featured.note}</p>}

                <Button
                  variant="outline"
                  className="mt-auto w-full"
                  disabled={busy}
                  onClick={() => onLoad(featured)}
                >
                  {busy ? 'Loading…' : 'Preview'}
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
