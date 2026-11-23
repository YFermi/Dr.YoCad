import * as React from 'react';
import {
  ArrowLeftRight,
  Box,
  Check,
  CircleDot,
  Compass,
  Hexagon,
  Ruler,
  Undo2,
  X,
  Zap,
} from 'lucide-react';
import {
  convertSmartMeasurementUnit,
  formatSmartMeasurementDisplay,
} from '@/lib/geometry';
import { useMeasureStore, type MeasureMode } from '@/stores/measureStore';
import { cn } from '@/lib/utils';

const MEASURE_TOOLS: Array<{
  mode: MeasureMode;
  label: string;
  shortLabel: string;
  hint: string;
  icon: React.ComponentType<{ className?: string }>;
}> = [
  {
    mode: 'quick',
    label: 'Quick Measure',
    shortLabel: 'Quick',
    hint: 'Hover any face, hole, or cylinder to preview dimensions — click to pin',
    icon: Zap,
  },
  {
    mode: 'smart',
    label: 'Smart Dimension',
    shortLabel: 'Smart',
    hint: 'Click 1–2 features (planes, holes, cylinders, points) — auto-detects best measurement',
    icon: Ruler,
  },
  {
    mode: 'diameter',
    label: 'Diameter',
    shortLabel: '⌀ Dia',
    hint: 'Click any circular hole rim or cylindrical surface to measure diameter',
    icon: CircleDot,
  },
  {
    mode: 'angle',
    label: 'Angle',
    shortLabel: 'Angle',
    hint: 'Click 2 planar faces or 3 points to measure angle',
    icon: Compass,
  },
  {
    mode: 'min-wall',
    label: 'Min Wall',
    shortLabel: 'Wall',
    hint: 'Click 1 part for internal wall thickness, or 2 parts for minimum clearance',
    icon: ArrowLeftRight,
  },
  {
    mode: 'area',
    label: 'Surface Area',
    shortLabel: 'Area',
    hint: 'Click any planar face or part to compute surface area',
    icon: Hexagon,
  },
  {
    mode: 'bbox',
    label: 'Bounding Box',
    shortLabel: 'BBox',
    hint: 'Click any part to display its X × Y × Z bounding box',
    icon: Box,
  },
];

/**
 * Compact measurement tool strip embedded inside ViewerToolbar.
 * Keeps the toolbar cohesive while exposing all 7 SOLIDWORKS-class measurement tools.
 */
export function MeasureToolbar() {
  const mode = useMeasureStore((s) => s.mode);
  const displayUnit = useMeasureStore((s) => s.displayUnit);
  const setMode = useMeasureStore((s) => s.setMode);
  const setDisplayUnit = useMeasureStore((s) => s.setDisplayUnit);

  return (
    <div className="flex items-center gap-0.5">
      {MEASURE_TOOLS.map((tool) => {
        const Icon = tool.icon;
        const active = mode === tool.mode;
        return (
          <button
            key={tool.mode}
            type="button"
            onClick={() => setMode(active ? 'off' : tool.mode)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1.5 text-xs transition-colors cursor-pointer',
              active
                ? 'bg-primary text-primary-foreground font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title={`${tool.label} — ${tool.hint}`}
            aria-label={tool.label}
            aria-pressed={active}
          >
            <Icon className="h-3.5 w-3.5" />
            <span className="hidden xl:inline font-mono text-[11px]">
              {tool.shortLabel}
            </span>
          </button>
        );
      })}

      {/* Compact mm / in display unit toggle */}
      <button
        type="button"
        onClick={() => setDisplayUnit(displayUnit === 'mm' ? 'in' : 'mm')}
        className="ml-0.5 rounded border border-border bg-background px-1.5 py-1 font-mono text-[10px] uppercase text-muted-foreground hover:border-primary/60 hover:text-foreground transition-colors cursor-pointer"
        title="Toggle measurement display units (mm / in)"
        aria-label="Toggle measurement unit"
      >
        {displayUnit}
      </button>
    </div>
  );
}

/**
 * Top-left HUD banner shown whenever a Smart Measurement tool is active.
 * Displays active mode instructions, selected entity chain, live result + related
 * dimensions, and Save / Undo / Clear actions.
 */
export function MeasureStatusHud({ canPersist = true }: { canPersist?: boolean }) {
  const mode = useMeasureStore((s) => s.mode);
  const selection = useMeasureStore((s) => s.selection);
  const pendingResult = useMeasureStore((s) => s.pendingResult);
  const relatedResults = useMeasureStore((s) => s.relatedResults);
  const pendingError = useMeasureStore((s) => s.pendingError);
  const extractingFeatures = useMeasureStore((s) => s.extractingFeatures);
  const features = useMeasureStore((s) => s.features);
  const displayUnit = useMeasureStore((s) => s.displayUnit);
  const commitResult = useMeasureStore((s) => s.commitResult);
  const removeLastSelection = useMeasureStore((s) => s.removeLastSelection);
  const clearSelection = useMeasureStore((s) => s.clearSelection);
  const setMode = useMeasureStore((s) => s.setMode);

  if (mode === 'off') return null;

  const toolMeta = MEASURE_TOOLS.find((t) => t.mode === mode);
  const modeLabel =
    toolMeta?.label ?? (mode === 'surface' ? 'Part Inspection' : 'Measure');
  const modeHint =
    toolMeta?.hint ??
    'Inspecting part geometry & features. Click features to measure or switch tools below.';

  const formatVal = (m: typeof pendingResult) => {
    if (!m) return '';
    return formatSmartMeasurementDisplay(convertSmartMeasurementUnit(m, displayUnit));
  };

  return (
    <div className="pointer-events-auto absolute left-4 top-4 z-20 flex max-w-md flex-col gap-2 rounded-lg border border-primary/50 bg-[#121721] px-3.5 py-2.5 text-xs shadow-2xl">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="h-2 w-2 rounded-full bg-sky-400" />
          <span className="font-mono text-[11px] font-semibold uppercase tracking-wide text-sky-300">
            {modeLabel}
          </span>
          {extractingFeatures ? (
            <span className="font-mono text-[10px] text-amber-300">
              Analyzing mesh...
            </span>
          ) : (
            <span className="font-mono text-[10px] text-muted-foreground">
              {features.length} feature{features.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={() => setMode('off')}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
          title="Exit measure mode (Esc)"
          aria-label="Exit measure mode"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <p className="text-[11px] leading-snug text-muted-foreground">{modeHint}</p>

      {selection.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          {selection.map((ref, idx) => (
            <span
              key={`${ref.partId}-${idx}`}
              className="rounded border border-sky-500/40 bg-sky-500/10 px-1.5 py-0.5 font-mono text-[10px] text-sky-200"
            >
              {idx + 1}. {ref.label ?? ref.kind}
            </span>
          ))}
          <button
            type="button"
            onClick={removeLastSelection}
            className="inline-flex items-center gap-0.5 rounded border border-border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
            title="Remove last selection (Backspace)"
          >
            <Undo2 className="h-2.5 w-2.5" />
            Undo
          </button>
        </div>
      )}

      {pendingError && (
        <p className="rounded border border-amber-500/40 bg-amber-500/10 px-2 py-1 text-[11px] text-amber-300">
          {pendingError}
        </p>
      )}

      {pendingResult && (
        <div className="space-y-1.5 rounded-md border border-sky-500/40 bg-background/80 px-2.5 py-2">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-mono text-sm font-semibold tabular-nums text-sky-300">
                {formatVal(pendingResult)}
              </p>
              {pendingResult.label && (
                <p className="font-mono text-[10px] text-muted-foreground">
                  {pendingResult.label}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={clearSelection}
                className="rounded border border-border px-2 py-1 font-mono text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
              >
                Clear
              </button>
              <button
                type="button"
                onClick={commitResult}
                className="inline-flex items-center gap-1 rounded bg-primary px-2.5 py-1 font-mono text-[10px] font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer"
                title="Save measurement (Enter)"
              >
                <Check className="h-3 w-3" />
                {canPersist ? 'Save' : 'Pin'}
              </button>
            </div>
          </div>

          {pendingResult.note && (
            <p className="text-[10px] text-amber-300/90">{pendingResult.note}</p>
          )}

          {relatedResults.length > 0 && (
            <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-1.5">
              {relatedResults.map((rel) => (
                <span
                  key={rel.id}
                  className="rounded border border-violet-500/40 bg-violet-500/10 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-violet-200"
                >
                  {rel.label ? `${rel.label}: ` : ''}
                  {formatVal(rel)}
                </span>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
