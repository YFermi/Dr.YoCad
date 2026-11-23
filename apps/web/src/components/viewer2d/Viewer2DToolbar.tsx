import * as React from 'react';
import {
  ArrowUpRight,
  Camera,
  Circle,
  Cloud,
  Compass,
  Crosshair,
  Grid3X3,
  Hand,
  Hexagon,
  MapPin,
  Maximize2,
  MousePointer2,
  Pencil,
  Ruler,
  Square,
  Type,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import {
  useViewer2DStore,
  type SnapKey,
  type Viewer2DTool,
} from '@/stores/viewer2dStore';
import { cn } from '@/lib/utils';

interface ToolButtonDef {
  id: Viewer2DTool;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  group: 'nav' | 'measure' | 'markup';
}

const TOOL_BUTTONS: ToolButtonDef[] = [
  { id: 'pan', label: 'Pan (Space)', icon: Hand, group: 'nav' },
  { id: 'select', label: 'Select', icon: MousePointer2, group: 'nav' },
  { id: 'distance', label: 'Distance', icon: Ruler, group: 'measure' },
  { id: 'angle', label: 'Angle', icon: Compass, group: 'measure' },
  { id: 'area', label: 'Area', icon: Hexagon, group: 'measure' },
  { id: 'pin', label: 'Pin', icon: MapPin, group: 'markup' },
  { id: 'arrow', label: 'Arrow', icon: ArrowUpRight, group: 'markup' },
  { id: 'rect', label: 'Rectangle', icon: Square, group: 'markup' },
  { id: 'ellipse', label: 'Ellipse', icon: Circle, group: 'markup' },
  { id: 'cloud', label: 'Rev Cloud', icon: Cloud, group: 'markup' },
  { id: 'freehand', label: 'Freehand', icon: Pencil, group: 'markup' },
  { id: 'text', label: 'Text', icon: Type, group: 'markup' },
];

const SNAP_OPTIONS: Array<{ key: SnapKey; short: string; label: string }> = [
  { key: 'endpoint', short: 'END', label: 'Endpoint snap' },
  { key: 'midpoint', short: 'MID', label: 'Midpoint snap' },
  { key: 'intersection', short: 'INT', label: 'Intersection snap' },
  { key: 'grid', short: 'GRID', label: 'Grid snap' },
];

function formatZoomRatio(scale: number): string {
  if (!Number.isFinite(scale) || scale <= 0) return '1:1 @ 1:1';
  if (scale >= 1) {
    const ratio = scale >= 10 ? scale.toFixed(0) : scale.toFixed(1).replace(/\.0$/, '');
    return `${ratio}:1 @ 1:1`;
  }
  const inv = 1 / scale;
  const invStr = inv >= 10 ? inv.toFixed(0) : inv.toFixed(1).replace(/\.0$/, '');
  return `1:${invStr} @ 1:1`;
}

interface Viewer2DToolbarProps {
  showSnaps?: boolean;
}

export function Viewer2DToolbar({ showSnaps = true }: Viewer2DToolbarProps) {
  const tool = useViewer2DStore((s) => s.tool);
  const snap = useViewer2DStore((s) => s.snap);
  const gridStep = useViewer2DStore((s) => s.gridStep);
  const zoom = useViewer2DStore((s) => s.zoom);
  const units = useViewer2DStore((s) => s.units);
  const setTool = useViewer2DStore((s) => s.setTool);
  const toggleSnap = useViewer2DStore((s) => s.toggleSnap);
  const setGridStep = useViewer2DStore((s) => s.setGridStep);
  const fitToView = useViewer2DStore((s) => s.fitToView);
  const zoomIn = useViewer2DStore((s) => s.zoomIn);
  const zoomOut = useViewer2DStore((s) => s.zoomOut);
  const takeScreenshot = useViewer2DStore((s) => s.takeScreenshot);

  const navTools = TOOL_BUTTONS.filter((t) => t.group === 'nav');
  const measureTools = TOOL_BUTTONS.filter((t) => t.group === 'measure');
  const markupTools = TOOL_BUTTONS.filter((t) => t.group === 'markup');

  const renderGroup = (items: ToolButtonDef[]) =>
    items.map((item) => {
      const Icon = item.icon;
      const active = tool === item.id;
      return (
        <button
          key={item.id}
          type="button"
          onClick={() => setTool(item.id)}
          title={item.label}
          aria-label={item.label}
          aria-pressed={active}
          className={cn(
            'flex h-8 w-8 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer',
            active
              ? 'bg-primary text-primary-foreground shadow-sm'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          <Icon className="h-3.5 w-3.5" />
        </button>
      );
    });

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-20 flex max-w-[calc(100%-1.5rem)] -translate-x-1/2 flex-wrap items-center justify-center gap-1.5 rounded-lg border border-border bg-[#121721]/95 px-2.5 py-1.5 shadow-2xl backdrop-blur-sm">
      {/* Navigation tools */}
      <div className="flex items-center gap-0.5">{renderGroup(navTools)}</div>

      <div className="h-5 w-px bg-border" />

      {/* Measurement tools */}
      <div className="flex items-center gap-0.5">{renderGroup(measureTools)}</div>

      <div className="h-5 w-px bg-border" />

      {/* Markup & annotation tools */}
      <div className="flex items-center gap-0.5">{renderGroup(markupTools)}</div>

      {showSnaps && (
        <>
          <div className="h-5 w-px bg-border" />
          {/* Snap toggles */}
          <div className="flex items-center gap-1">
            <Crosshair className="h-3 w-3 text-muted-foreground" aria-hidden="true" />
            {SNAP_OPTIONS.map((opt) => {
              const enabled = snap[opt.key];
              return (
                <button
                  key={opt.key}
                  type="button"
                  onClick={() => toggleSnap(opt.key)}
                  title={opt.label}
                  aria-pressed={enabled}
                  className={cn(
                    'rounded px-1.5 py-1 font-mono text-[10px] font-medium transition-colors cursor-pointer whitespace-nowrap',
                    enabled
                      ? 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40'
                      : 'border border-transparent text-muted-foreground hover:bg-accent hover:text-foreground'
                  )}
                >
                  {opt.short}
                </button>
              );
            })}

            {snap.grid && (
              <label className="flex items-center gap-1 pl-1 text-[10px] text-muted-foreground">
                <Grid3X3 className="h-3 w-3" />
                <select
                  aria-label="Grid snap interval"
                  value={gridStep}
                  onChange={(e) => setGridStep(Number(e.target.value))}
                  className="h-6 rounded border border-border bg-background px-1 font-mono text-[10px] text-foreground"
                >
                  <option value={0.5}>0.5</option>
                  <option value={1}>1</option>
                  <option value={5}>5</option>
                  <option value={10}>10</option>
                </select>
              </label>
            )}
          </div>
        </>
      )}

      <div className="h-5 w-px bg-border" />

      {/* Zoom & Fit controls */}
      <div className="flex items-center gap-1">
        <button
          type="button"
          onClick={zoomOut}
          title="Zoom out"
          aria-label="Zoom out"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <ZoomOut className="h-3.5 w-3.5" />
        </button>

        <span
          className="min-w-[82px] text-center font-mono text-[10px] tabular-nums text-foreground whitespace-nowrap"
          title={`Zoom scale: ${(zoom * 100).toFixed(0)}%`}
        >
          {formatZoomRatio(zoom)}
        </span>

        <button
          type="button"
          onClick={zoomIn}
          title="Zoom in"
          aria-label="Zoom in"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <ZoomIn className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={fitToView}
          title="Fit sheet to view"
          aria-label="Fit sheet to view"
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="h-5 w-px bg-border" />

      {/* Units indicator & Screenshot */}
      <span
        className="px-1.5 font-mono text-[10px] font-medium uppercase text-muted-foreground whitespace-nowrap"
        title="Drawing units"
      >
        Units: {units}
      </span>

      <button
        type="button"
        onClick={takeScreenshot}
        title="Export 2D viewport as PNG"
        aria-label="Export 2D viewport as PNG"
        className="flex h-7 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-accent transition-colors cursor-pointer whitespace-nowrap"
      >
        <Camera className="h-3.5 w-3.5" />
        PNG
      </button>
    </div>
  );
}
