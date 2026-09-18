import { Badge } from '@/components/ui/badge';
import { FUSION_CHIP, JELLYFIN_CHIP, NUVIO_CHIP } from '@/lib/collectionBuilder/terms';

/** Marks a control that only one of the two targets understands. */
export function ScopeChip({ scope }: { scope: 'nuvio' | 'fusion' | 'jellyfin' }) {
  const label = scope === 'nuvio' ? 'Nuvio only' : scope === 'fusion' ? 'Fusion only' : 'Jellyfin only';
  const tone = scope === 'nuvio' ? NUVIO_CHIP : scope === 'fusion' ? FUSION_CHIP : JELLYFIN_CHIP;
  return (
    <Badge variant="outline" className={`h-5 shrink-0 px-1.5 text-xs font-medium ${tone}`}>
      {label}
    </Badge>
  );
}
