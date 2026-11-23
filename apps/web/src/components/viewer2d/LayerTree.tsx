import * as React from 'react';
import { Eye, EyeOff, Layers, RotateCcw } from 'lucide-react';
import type { DxfLayerManifestItem } from '@cadline/shared';
import { useViewer2DStore } from '@/stores/viewer2dStore';
import { cn } from '@/lib/utils';

interface LayerTreeProps {
  layers?: DxfLayerManifestItem[];
  mode?: '2D_DXF' | '2D_PDF' | null;
  pageCount?: number;
  activePage?: number;
  onSelectPage?: (page: number) => void;
}

export function LayerTree({
  layers: layersProp,
  mode,
  pageCount,
  activePage = 1,
  onSelectPage,
}: LayerTreeProps) {
  const storeLayers = useViewer2DStore((s) => s.layers);
  const hiddenLayers = useViewer2DStore((s) => s.hiddenLayers);
  const soloLayer = useViewer2DStore((s) => s.soloLayer);
  const activeLayerId = useViewer2DStore((s) => s.activeLayerId);
  const toggleLayerVisibility = useViewer2DStore((s) => s.toggleLayerVisibility);
  const toggleSoloLayer = useViewer2DStore((s) => s.toggleSoloLayer);
  const showAllLayers = useViewer2DStore((s) => s.showAllLayers);
  const setActiveLayer = useViewer2DStore((s) => s.setActiveLayer);

  const layers = layersProp ?? storeLayers;
  const hasHiddenOrSolo = hiddenLayers.size > 0 || soloLayer !== null;

  if (mode === '2D_PDF') {
    const pages = Array.from({ length: pageCount ?? 1 }, (_, i) => i + 1);
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
          <div className="flex items-center gap-1.5">
            <Layers className="h-3.5 w-3.5 text-primary" />
            <span className="text-xs font-semibold text-foreground">Sheets</span>
          </div>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            {pages.length} {pages.length === 1 ? 'page' : 'pages'}
          </span>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {pages.map((page) => (
            <button
              key={page}
              type="button"
              onClick={() => onSelectPage?.(page)}
              className={cn(
                'flex w-full items-center justify-between rounded-md border px-2.5 py-2 text-xs transition-colors cursor-pointer',
                activePage === page
                  ? 'border-primary/60 bg-primary/10 text-foreground'
                  : 'border-border bg-background/50 text-muted-foreground hover:text-foreground'
              )}
            >
              <span className="font-medium">Sheet {page}</span>
              <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                PDF · 2×
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5 min-w-0">
          <Layers className="h-3.5 w-3.5 shrink-0 text-primary" />
          <span className="truncate text-xs font-semibold text-foreground">
            DXF Layers
          </span>
          <span className="font-mono text-[11px] tabular-nums text-muted-foreground">
            ({layers.length})
          </span>
        </div>

        {hasHiddenOrSolo && (
          <button
            type="button"
            onClick={showAllLayers}
            className="flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10 transition-colors cursor-pointer whitespace-nowrap"
          >
            <RotateCcw className="h-3 w-3" />
            Show all
          </button>
        )}
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {layers.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">
            No DXF layers detected.
          </div>
        ) : (
          layers.map((layer) => {
            const isVisible =
              soloLayer !== null
                ? soloLayer === layer.name
                : !hiddenLayers.has(layer.name);
            const isSolo = soloLayer === layer.name;
            const isActive = activeLayerId === layer.name;

            return (
              <div
                key={layer.name}
                onClick={() => setActiveLayer(layer.name)}
                className={cn(
                  'group flex items-center justify-between gap-2 rounded-md border px-2 py-1.5 text-xs transition-colors cursor-pointer',
                  isActive
                    ? 'border-primary/50 bg-primary/10'
                    : 'border-transparent hover:border-border hover:bg-background/60'
                )}
              >
                <div className="flex min-w-0 flex-1 items-center gap-2">
                  <input
                    type="checkbox"
                    checked={isVisible}
                    onChange={(e) => {
                      e.stopPropagation();
                      toggleLayerVisibility(layer.name);
                    }}
                    aria-label={`Toggle layer ${layer.name}`}
                    className="h-3.5 w-3.5 shrink-0 accent-[#0b5fff] cursor-pointer"
                  />
                  <span
                    className="h-2.5 w-2.5 shrink-0 rounded-xs border border-white/20"
                    style={{ backgroundColor: layer.color }}
                    aria-hidden="true"
                  />
                  <span
                    className={cn(
                      'truncate font-mono text-[11px]',
                      isVisible ? 'text-foreground' : 'text-muted-foreground line-through'
                    )}
                    title={layer.name}
                  >
                    {layer.name}
                  </span>
                </div>

                <div className="flex shrink-0 items-center gap-1.5">
                  <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                    {layer.entityCount}
                  </span>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleSoloLayer(layer.name);
                    }}
                    title={isSolo ? 'Exit solo mode' : `Solo layer ${layer.name}`}
                    className={cn(
                      'rounded px-1.5 py-0.5 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap',
                      isSolo
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-border text-muted-foreground hover:text-foreground hover:bg-accent'
                    )}
                  >
                    Solo
                  </button>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      toggleLayerVisibility(layer.name);
                    }}
                    className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                    aria-label={isVisible ? `Hide ${layer.name}` : `Show ${layer.name}`}
                  >
                    {isVisible ? (
                      <Eye className="h-3 w-3" />
                    ) : (
                      <EyeOff className="h-3 w-3 opacity-60" />
                    )}
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {layers.length > 0 && (
        <div className="border-t border-border px-3 py-2 flex items-center justify-between text-[11px] text-muted-foreground">
          <span>
            {soloLayer ? `Isolated: ${soloLayer}` : `${layers.length - hiddenLayers.size}/${layers.length} visible`}
          </span>
          <button
            type="button"
            onClick={showAllLayers}
            className="text-primary hover:underline cursor-pointer whitespace-nowrap"
          >
            Show all
          </button>
        </div>
      )}
    </div>
  );
}
