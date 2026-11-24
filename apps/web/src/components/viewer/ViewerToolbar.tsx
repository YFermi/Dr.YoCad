import * as React from 'react';
import {
  Camera,
  Crosshair,
  Layers,
  MapPin,
  Maximize2,
  Orbit,
  RefreshCw,
  RotateCcw,
  RotateCw,
  Scissors,
  Trash2,
} from 'lucide-react';
import {
  useViewerStore,
  type CameraControlMode,
  type CameraPreset,
  type ViewMode,
} from '@/stores/viewerStore';
import { useMeasureStore } from '@/stores/measureStore';
import { MeasureToolbar } from '@/components/viewer/MeasureToolbar';
import { cn } from '@/lib/utils';

const VIEW_MODES: Array<{ value: ViewMode; label: string }> = [
  { value: 'shaded', label: 'Shaded' },
  { value: 'shadedEdges', label: 'Edges' },
  { value: 'wireframe', label: 'Wireframe' },
  { value: 'xray', label: 'X-Ray' },
];

const CAMERA_PRESETS: Array<{ value: CameraPreset; label: string; shortLabel?: string }> = [
  { value: 'front', label: 'Front' },
  { value: 'back', label: 'Back' },
  { value: 'top', label: 'Top' },
  { value: 'bottom', label: 'Bottom', shortLabel: 'Bot' },
  { value: 'left', label: 'Left' },
  { value: 'right', label: 'Right' },
  { value: 'iso', label: 'Iso' },
];

interface ViewerToolbarProps {
  canAnnotate?: boolean;
}

export function ViewerToolbar({ canAnnotate = true }: ViewerToolbarProps) {
  const viewMode = useViewerStore((s) => s.viewMode);
  const sectionPlane = useViewerStore((s) => s.sectionPlane);
  const annotationMode = useViewerStore((s) => s.annotationMode);
  const cameraControlMode = useViewerStore((s) => s.cameraControlMode);
  const selectedPartIdForNormal = useViewerStore((s) => s.selectedPartIdForNormal);
  const lastSelectedFace = useViewerStore((s) => s.lastSelectedFace);

  const setViewMode = useViewerStore((s) => s.setViewMode);
  const setSectionPlane = useViewerStore((s) => s.setSectionPlane);
  const setAnnotationMode = useViewerStore((s) => s.setAnnotationMode);
  const setCameraControlMode = useViewerStore((s) => s.setCameraControlMode);
  const clearMeasurements = useViewerStore((s) => s.clearMeasurements);
  const requestCameraPreset = useViewerStore((s) => s.requestCameraPreset);
  const requestCameraRoll = useViewerStore((s) => s.requestCameraRoll);
  const requestNormalToSelection = useViewerStore((s) => s.requestNormalToSelection);
  const takeScreenshot = useViewerStore((s) => s.takeScreenshot);
  const resetView = useViewerStore((s) => s.resetView);

  const localSmartCount = useMeasureStore((s) => s.localResults.length);
  const setMeasureMode = useMeasureStore((s) => s.setMode);
  const clearSmartSelection = useMeasureStore((s) => s.clearSelection);

  const [sectionOpen, setSectionOpen] = React.useState(false);
  const [navSettingsOpen, setNavSettingsOpen] = React.useState(false);

  const hasNormalTarget = Boolean(selectedPartIdForNormal || lastSelectedFace);

  const cycleViewMode = () => {
    const idx = VIEW_MODES.findIndex((m) => m.value === viewMode);
    const next = VIEW_MODES[(idx + 1) % VIEW_MODES.length];
    setViewMode(next.value);
  };

  const currentViewLabel =
    VIEW_MODES.find((m) => m.value === viewMode)?.label ?? 'Shaded';

  const handleSelectNavMode = (mode: CameraControlMode) => {
    setCameraControlMode(mode);
  };

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-col items-center gap-2 px-4">
      {sectionOpen && (
        <div className="pointer-events-auto flex flex-wrap items-center gap-3 rounded-lg border border-border bg-[#121721] px-4 py-2.5 text-xs shadow-2xl">
          <label className="flex items-center gap-2 font-medium text-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={sectionPlane.enabled}
              onChange={(e) => setSectionPlane({ enabled: e.target.checked })}
              className="h-3.5 w-3.5 accent-primary cursor-pointer"
            />
            Section cut
          </label>

          <div className="h-4 w-px bg-border" />

          <div className="flex items-center gap-1">
            {(['x', 'y', 'z'] as const).map((axis) => (
              <button
                key={axis}
                type="button"
                onClick={() => setSectionPlane({ axis, enabled: true })}
                className={cn(
                  'h-6 w-7 rounded font-mono text-[11px] uppercase transition-colors cursor-pointer',
                  sectionPlane.axis === axis && sectionPlane.enabled
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-background text-muted-foreground hover:text-foreground border border-border'
                )}
              >
                {axis}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2">
            <span className="font-mono text-[11px] text-muted-foreground">Offset</span>
            <input
              type="range"
              min={-1}
              max={1}
              step={0.02}
              value={sectionPlane.offset}
              onChange={(e) =>
                setSectionPlane({ offset: Number(e.target.value), enabled: true })
              }
              className="w-28 accent-primary cursor-pointer"
              aria-label="Section plane offset"
            />
            <span className="w-10 text-right font-mono text-[11px] tabular-nums text-muted-foreground">
              {Math.round(sectionPlane.offset * 100)}%
            </span>
          </div>
        </div>
      )}

      {navSettingsOpen && (
        <div className="pointer-events-auto flex flex-col gap-2.5 rounded-lg border border-border bg-[#121721] px-4 py-3 text-xs shadow-2xl max-w-md">
          <div className="flex items-center justify-between gap-4">
            <span className="font-medium text-foreground">3D Navigation Style</span>
            <div className="flex items-center rounded border border-border bg-background p-0.5">
              <button
                type="button"
                onClick={() => handleSelectNavMode('trackball')}
                className={cn(
                  'rounded px-2.5 py-1 font-mono text-[11px] transition-colors cursor-pointer',
                  cameraControlMode === 'trackball'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Free (CAD)
              </button>
              <button
                type="button"
                onClick={() => handleSelectNavMode('orbit')}
                className={cn(
                  'rounded px-2.5 py-1 font-mono text-[11px] transition-colors cursor-pointer',
                  cameraControlMode === 'orbit'
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                Orbit (Turntable)
              </button>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-x-4 gap-y-1 font-mono text-[10px] text-muted-foreground">
            <span>Left drag: {cameraControlMode === 'trackball' ? 'Orbit around the pressed point' : 'Turntable orbit'}</span>
            <span>Wheel: Zoom to cursor</span>
            <span>Middle / Shift+Left: Pan</span>
            <span>Ctrl+Wheel: Fine zoom (10%)</span>
            {cameraControlMode === 'trackball' ? (
              <>
                <span>Edge drag / Q, E: Roll (±15°)</span>
                <span>Right drag: Dolly · F: Fit</span>
                <span>Space: View cube</span>
                <span>Double-click part: Focus</span>
              </>
            ) : (
              <>
                <span>Right drag: Zoom dolly</span>
                <span>Double-click part: Focus</span>
              </>
            )}
          </div>
        </div>
      )}

      {/* Solid opaque HUD bar (no backdrop-filter over WebGL canvas) */}
      <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-1 rounded-lg border border-border bg-[#121721] px-2 py-1.5 shadow-2xl">
        {/* Standard CAD View Presets (Front/Back/Top/Bottom/Left/Right/Iso) */}
        <div className="flex items-center gap-0.5 pr-1">
          {CAMERA_PRESETS.map((preset) => (
            <button
              key={preset.value}
              type="button"
              onClick={() => requestCameraPreset(preset.value)}
              className="rounded px-1.5 py-1.5 font-mono text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
              title={`${preset.label} view: snaps the orientation, re-centers the orbit pivot on the model and fits it (use this when you are lost)`}
            >
              {preset.shortLabel ?? preset.label}
            </button>
          ))}
        </div>

        <div className="h-5 w-px bg-border" />

        {/* Roll ±15° & Normal to Selection */}
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => requestCameraRoll(-15)}
            disabled={cameraControlMode !== 'trackball'}
            className={cn(
              'rounded p-1.5 transition-colors',
              cameraControlMode === 'trackball'
                ? 'text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer'
                : 'text-muted-foreground/35 cursor-not-allowed'
            )}
            title={
              cameraControlMode === 'trackball'
                ? 'Roll camera left 15° (Q)'
                : 'Switch to Trackball mode to roll camera'
            }
            aria-label="Roll left 15 degrees"
          >
            <RotateCcw className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={() => requestCameraRoll(15)}
            disabled={cameraControlMode !== 'trackball'}
            className={cn(
              'rounded p-1.5 transition-colors',
              cameraControlMode === 'trackball'
                ? 'text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer'
                : 'text-muted-foreground/35 cursor-not-allowed'
            )}
            title={
              cameraControlMode === 'trackball'
                ? 'Roll camera right 15° (E)'
                : 'Switch to Trackball mode to roll camera'
            }
            aria-label="Roll right 15 degrees"
          >
            <RotateCw className="h-3.5 w-3.5" />
          </button>

          <button
            type="button"
            onClick={requestNormalToSelection}
            disabled={!hasNormalTarget}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1.5 text-xs transition-colors',
              hasNormalTarget
                ? 'text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer'
                : 'text-muted-foreground/35 cursor-not-allowed'
            )}
            title={
              hasNormalTarget
                ? 'Align camera normal to selected face or part'
                : 'Select a face or part first to orient normal to selection'
            }
            aria-label="Normal to selection"
          >
            <Crosshair className="h-3.5 w-3.5" />
            <span className="hidden lg:inline font-mono text-[11px]">Normal</span>
          </button>
        </div>

        <div className="h-5 w-px bg-border" />

        {/* View mode cycle */}
        <button
          type="button"
          onClick={cycleViewMode}
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1.5 text-xs transition-colors cursor-pointer',
            viewMode !== 'shaded'
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
          title="Cycle display mode (Shaded / Edges / Wireframe / X-Ray)"
        >
          <Layers className="h-3.5 w-3.5" />
          <span className="font-mono text-[11px]">{currentViewLabel}</span>
        </button>

        {/* Section plane popover toggle */}
        <button
          type="button"
          onClick={() => {
            setNavSettingsOpen(false);
            setSectionOpen((prev) => !prev);
          }}
          className={cn(
            'flex items-center gap-1.5 rounded px-2 py-1.5 text-xs transition-colors cursor-pointer',
            sectionPlane.enabled || sectionOpen
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
          title="Toggle section plane"
        >
          <Scissors className="h-3.5 w-3.5" />
          <span className="hidden xl:inline font-mono text-[11px]">Section</span>
        </button>

        <div className="h-5 w-px bg-border" />

        {/* 3D Pin Annotation tool */}
        {canAnnotate && (
          <button
            type="button"
            onClick={() => {
              if (!annotationMode) setMeasureMode('off');
              setAnnotationMode(!annotationMode);
            }}
            className={cn(
              'flex items-center gap-1.5 rounded px-2 py-1.5 text-xs transition-colors cursor-pointer',
              annotationMode
                ? 'bg-amber-500 text-slate-950 font-medium'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
            title="Place a 3D annotation pin on any model surface"
          >
            <MapPin className="h-3.5 w-3.5" />
            <span className="hidden xl:inline font-mono text-[11px]">Pin</span>
          </button>
        )}

        {/* Session 7: Smart Measurement Toolbar */}
        <MeasureToolbar />

        {localSmartCount > 0 && (
          <button
            type="button"
            onClick={() => {
              clearMeasurements();
              clearSmartSelection();
              useMeasureStore.setState({ localResults: [] });
            }}
            className="flex items-center gap-1 rounded px-2 py-1.5 text-xs text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            title="Clear unsaved local measurements"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="font-mono text-[11px] tabular-nums">
              ({localSmartCount})
            </span>
          </button>
        )}

        <div className="h-5 w-px bg-border" />

        {/* Navigation mode toggle (Trackball vs Orbit), Fit, Screenshot, Reset */}
        <button
          type="button"
          onClick={() => {
            setSectionOpen(false);
            setNavSettingsOpen((prev) => !prev);
          }}
          className={cn(
            'flex items-center gap-1 rounded px-2 py-1.5 text-xs transition-colors cursor-pointer',
            navSettingsOpen
              ? 'bg-primary/15 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
          title={`Navigation mode: ${cameraControlMode === 'trackball' ? 'Free (pivot on the point you drag, full rotation and roll)' : 'Turntable Orbit'}. Click to switch.`}
          aria-label="Navigation mode settings"
        >
          <Orbit className="h-3.5 w-3.5" />
          <span className="hidden md:inline font-mono text-[11px]">
            {cameraControlMode === 'trackball' ? 'Free' : 'Orbit'}
          </span>
        </button>

        <button
          type="button"
          onClick={() => requestCameraPreset('fit')}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
          title="Fit to view (F): frame the whole model and re-center the orbit pivot, keeping the current orientation"
          aria-label="Fit to view"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={takeScreenshot}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
          title="Download PNG screenshot"
          aria-label="Download screenshot"
        >
          <Camera className="h-3.5 w-3.5" />
        </button>

        <button
          type="button"
          onClick={() => {
            setSectionOpen(false);
            setNavSettingsOpen(false);
            setMeasureMode('off');
            resetView();
          }}
          className="rounded p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
          title="Reset camera, visibility, and section"
          aria-label="Reset view"
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}
