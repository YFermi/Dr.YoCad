import * as React from 'react';
import {
  ArrowLeftRight,
  Box,
  CircleDot,
  Compass,
  Hexagon,
  Layers,
  Pencil,
  Ruler,
  Trash2,
  X,
} from 'lucide-react';
import {
  MeasurementType,
  UserRole,
  isMeasurementPoints2D,
  isMeasurementPointsSmart,
  normalizeMeasurementToSmart,
  type ExtractedFeature,
  type Measurement,
  type PartMetricsSummary,
} from '@cadline/shared';
import { useAuthStore } from '@/lib/auth';
import { useViewerStore } from '@/stores/viewerStore';
import { useMeasureStore } from '@/stores/measureStore';
import {
  featureToMeasurementReference,
  formatSmartMeasurementDisplay,
} from '@/lib/geometry';
import { useDeleteMeasurement, useMeasurements } from '@/hooks/useAnnotations';
import { cn, formatRelativeTime } from '@/lib/utils';
import { aggregatePartSummaries, collectLeafPartIds, findPartNode } from '@/lib/partTree';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

interface MeasurementsPanelProps {
  fileId: string;
  versionId?: string;
  shareToken?: string;
  compact?: boolean;
}

function PartInspectionCard({
  summary,
  partFeatures,
  focusedFeatureId,
  onSelectFeature,
  onClose,
}: {
  summary: PartMetricsSummary;
  partFeatures: ExtractedFeature[];
  focusedFeatureId: string | null;
  onSelectFeature: (feat: ExtractedFeature) => void;
  onClose: () => void;
}) {
  return (
    <div className="border-b border-border bg-card/70 p-3 space-y-2.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Box className="h-3.5 w-3.5 shrink-0 text-sky-400" />
            <p className="truncate text-xs font-semibold text-foreground">
              {summary.partName}
            </p>
          </div>
          <p className="font-mono text-[10px] text-muted-foreground">
            Part Geometry Inspector
          </p>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
          title="Close part inspector"
          aria-label="Close part inspector"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Physical metrics grid */}
      <div className="grid grid-cols-2 gap-1.5 text-[11px]">
        <div className="col-span-2 rounded border border-border bg-background/70 px-2 py-1.5">
          <span className="block font-mono text-[9px] uppercase text-muted-foreground">
            Bounding Box (X × Y × Z)
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-sky-300">
            {summary.bboxDims[0].toFixed(2)} × {summary.bboxDims[1].toFixed(2)} ×{' '}
            {summary.bboxDims[2].toFixed(2)} mm
          </span>
        </div>

        <div className="rounded border border-border bg-background/70 px-2 py-1.5">
          <span className="block font-mono text-[9px] uppercase text-muted-foreground">
            Surface Area
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {summary.surfaceArea.toFixed(1)} mm²
          </span>
        </div>

        <div className="rounded border border-border bg-background/70 px-2 py-1.5">
          <span className="block font-mono text-[9px] uppercase text-muted-foreground">
            Volume
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {summary.volume.toFixed(1)} mm³
          </span>
        </div>

        <div className="rounded border border-border bg-background/70 px-2 py-1.5">
          <span className="block font-mono text-[9px] uppercase text-muted-foreground">
            Triangles
          </span>
          <span className="font-mono text-xs font-semibold tabular-nums text-foreground">
            {summary.triangleCount.toLocaleString()}
          </span>
        </div>

        <div className="rounded border border-border bg-background/70 px-2 py-1.5">
          <span className="block font-mono text-[9px] uppercase text-muted-foreground">
            Center of Mass
          </span>
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            {summary.centroid[0].toFixed(1)}, {summary.centroid[1].toFixed(1)},{' '}
            {summary.centroid[2].toFixed(1)}
          </span>
        </div>
      </div>

      {/* Extracted L2 Features list */}
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <span className="font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            Features ({partFeatures.length})
          </span>
          <span className="font-mono text-[9px] text-muted-foreground">
            Click to focus &amp; measure
          </span>
        </div>

        {partFeatures.length === 0 ? (
          <p className="rounded border border-dashed border-border px-2 py-2 text-[11px] text-muted-foreground">
            No analytic planes, holes, or cylinders detected on this part.
          </p>
        ) : (
          <div className="max-h-44 space-y-1 overflow-y-auto pr-0.5">
            {partFeatures.map((feat) => {
              const isFocused = focusedFeatureId === feat.id;
              const badgeColor =
                feat.kind === 'cylinder'
                  ? 'border-orange-500/40 bg-orange-500/15 text-orange-300'
                  : feat.kind === 'circle'
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                    : 'border-sky-500/40 bg-sky-500/15 text-sky-300';
              return (
                <button
                  key={feat.id}
                  type="button"
                  onClick={() => onSelectFeature(feat)}
                  className={cn(
                    'flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left transition-colors cursor-pointer',
                    isFocused
                      ? 'border-primary bg-primary/15 text-foreground'
                      : 'border-border bg-background/60 text-muted-foreground hover:border-primary/40 hover:text-foreground'
                  )}
                >
                  <span className="truncate font-mono text-[11px]">
                    {feat.summaryLabel}
                  </span>
                  <span
                    className={cn(
                      'shrink-0 rounded border px-1 py-0.5 font-mono text-[9px] uppercase',
                      badgeColor
                    )}
                  >
                    {feat.kind}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export function MeasurementsPanel({
  fileId,
  versionId,
  shareToken,
  compact = false,
}: MeasurementsPanelProps) {
  const user = useAuthStore((s) => s.user);
  const setPersistedMeasurements = useViewerStore((s) => s.setPersistedMeasurements);
  const clearLocalMeasurements = useViewerStore((s) => s.clearMeasurements);
  const requestCameraPose = useViewerStore((s) => s.requestCameraPose);

  const inspectedPartId = useMeasureStore((s) => s.inspectedPartId);
  const clearInspectedPart = useMeasureStore((s) => s.clearInspectedPart);
  const partSummaries = useMeasureStore((s) => s.partSummaries);
  const features = useMeasureStore((s) => s.features);
  const focusedFeatureId = useMeasureStore((s) => s.focusedFeatureId);
  const focusFeature = useMeasureStore((s) => s.focusFeature);
  const addSelection = useMeasureStore((s) => s.addSelection);
  const setEditingMeasurementId = useMeasureStore((s) => s.setEditingMeasurementId);
  const setPersistedSmart = useMeasureStore((s) => s.setPersistedMeasurements);

  const [confirmClearOpen, setConfirmClearOpen] = React.useState(false);
  const [clearingAll, setClearingAll] = React.useState(false);

  const measurementsQuery = useMeasurements(fileId, versionId, shareToken);
  const deleteMeasurement = useDeleteMeasurement(fileId);

  React.useEffect(() => {
    if (measurementsQuery.data) {
      setPersistedMeasurements(measurementsQuery.data);
      setPersistedSmart(measurementsQuery.data);
    }
  }, [measurementsQuery.data, setPersistedMeasurements, setPersistedSmart]);

  const items: Measurement[] = measurementsQuery.data ?? [];
  const isAdmin =
    user?.role === UserRole.ADMIN || user?.role === UserRole.OWNER;

  const canDelete = (m: Measurement) =>
    Boolean(user) && !shareToken && (m.userId === user?.id || isAdmin);

  const deletableItems = items.filter(canDelete);

  // Resolve inspected part summary (fallback to single part if tree id differs from mesh id).
  // Assembly / sub-assembly nodes have no mesh (and no summary) of their own:
  // aggregate the summaries of their leaf parts instead of showing nothing.
  const partTree = useViewerStore((s) => s.partTree);
  const activeSummary: PartMetricsSummary | null = React.useMemo(() => {
    if (!inspectedPartId) return null;
    const exact = partSummaries.find((p) => p.partId === inspectedPartId);
    if (exact) return exact;
    const node = findPartNode(partTree, inspectedPartId);
    if (node && node.children.length > 0) {
      const leafIds = new Set(collectLeafPartIds(node));
      const leaves = partSummaries.filter((p) => leafIds.has(p.partId));
      if (leaves.length > 0) return aggregatePartSummaries(node.id, node.name, leaves);
    }
    if (partSummaries.length === 1) return partSummaries[0];
    return null;
  }, [inspectedPartId, partSummaries, partTree]);

  const activePartFeatures = React.useMemo(() => {
    if (!activeSummary) return [];
    const idSet = new Set(activeSummary.featureIds);
    return features.filter((f) => idSet.has(f.id) || f.partId === activeSummary.partId);
  }, [activeSummary, features]);

  const handleFocusFeature = (feat: ExtractedFeature) => {
    focusFeature(feat.id);
    addSelection(featureToMeasurementReference(feat));

    // Compute a smooth viewing pose looking toward the feature anchor
    const [ax, ay, az] = feat.anchor;
    const dir = feat.normal ?? feat.axis ?? [0.6, 0.5, 0.6];
    const len = Math.hypot(dir[0], dir[1], dir[2]) || 1;
    const span = Math.max(
      feat.diameter ? feat.diameter * 3.5 : 0,
      feat.extentU ?? 0,
      feat.extentV ?? 0,
      35
    );
    const dist = Math.max(span * 1.4, 45);
    requestCameraPose({
      position: [
        ax + (dir[0] / len) * dist + dist * 0.25,
        ay + (dir[1] / len) * dist + dist * 0.25,
        az + (dir[2] / len) * dist + dist * 0.25,
      ],
      target: [ax, ay, az],
      zoom: 1,
    });
  };

  const handleClearAll = async () => {
    if (deletableItems.length === 0) {
      setConfirmClearOpen(false);
      return;
    }

    setClearingAll(true);
    try {
      await Promise.all(
        deletableItems.map((m) => deleteMeasurement.mutateAsync(m.id))
      );
      clearLocalMeasurements();
      useMeasureStore.setState({ localResults: [] });
      setConfirmClearOpen(false);
    } catch (err) {
      toast.error(
        'Could not clear all measurements',
        err instanceof Error ? err.message : undefined
      );
    } finally {
      setClearingAll(false);
    }
  };

  if (measurementsQuery.isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 p-6 text-xs text-muted-foreground">
        <Spinner size="sm" />
        <span>Loading measurements...</span>
      </div>
    );
  }

  return (
    <div className={compact ? 'space-y-2' : 'flex h-full flex-col'}>
      {!compact && activeSummary && (
        <PartInspectionCard
          summary={activeSummary}
          partFeatures={activePartFeatures}
          focusedFeatureId={focusedFeatureId}
          onSelectFeature={handleFocusFeature}
          onClose={clearInspectedPart}
        />
      )}

      {!compact && (
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="font-mono text-[11px] text-muted-foreground">
            {items.length} saved on this version
          </span>
          {deletableItems.length > 0 && (
            <button
              type="button"
              onClick={() => setConfirmClearOpen(true)}
              className="flex items-center gap-1 rounded px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/10 transition-colors cursor-pointer"
            >
              <Trash2 className="h-3 w-3" />
              Clear all
            </button>
          )}
        </div>
      )}

      <div className={compact ? 'space-y-1.5' : 'flex-1 space-y-2 overflow-y-auto p-3'}>
        {items.length === 0 ? (
          <div className="rounded-md border border-dashed border-border px-3 py-6 text-center space-y-1">
            <p className="text-xs text-muted-foreground">
              No saved measurements on this version.
            </p>
            <p className="text-[10px] text-muted-foreground/80">
              Use Quick Measure or Smart Dimension in the toolbar, or right-click a part in the Model Tree.
            </p>
          </div>
        ) : (
          items.map((m) => {
            const is2D = isMeasurementPoints2D(m.points);
            const isSmart = isMeasurementPointsSmart(m.points);
            const smart = normalizeMeasurementToSmart(m);
            const kind = smart?.kind;
            const isAngle = kind === 'angle' || m.type === MeasurementType.ANGLE;
            const isDia = kind === 'diameter' || kind === 'radius';
            const isWall = kind === 'min-wall';
            const isBbox = kind === 'bbox';
            const isArea = kind === 'area' || kind === 'volume' || m.type === MeasurementType.AREA;

            const displayValue = smart
              ? formatSmartMeasurementDisplay(smart)
              : isAngle
                ? `${m.value.toFixed(1)}${m.unit}`
                : `${m.value.toFixed(2)} ${m.unit}`;

            return (
              <div
                key={m.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border bg-background/70 px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-2">
                  <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded border border-amber-500/40 bg-amber-500/15 text-amber-300">
                    {isAngle ? (
                      <Compass className="h-3.5 w-3.5" />
                    ) : isDia ? (
                      <CircleDot className="h-3.5 w-3.5" />
                    ) : isWall ? (
                      <ArrowLeftRight className="h-3.5 w-3.5" />
                    ) : isBbox ? (
                      <Box className="h-3.5 w-3.5" />
                    ) : isArea ? (
                      <Hexagon className="h-3.5 w-3.5" />
                    ) : (
                      <Ruler className="h-3.5 w-3.5" />
                    )}
                  </span>
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5">
                      <p className="truncate font-mono text-xs font-semibold tabular-nums text-amber-300">
                        {displayValue}
                      </p>
                      <span className="shrink-0 rounded border border-border px-1 font-mono text-[9px] uppercase text-muted-foreground">
                        {is2D ? '2D' : isSmart && kind ? kind : '3D'}
                      </span>
                    </div>
                    {smart?.label && (
                      <p className="truncate text-[11px] text-foreground/90">
                        {smart.label}
                      </p>
                    )}
                    <p className="truncate text-[10px] text-muted-foreground">
                      {m.author?.name ?? 'Engineer'} · {formatRelativeTime(m.createdAt)}
                    </p>
                  </div>
                </div>

                {canDelete(m) && (
                  <div className="flex shrink-0 items-center gap-0.5">
                    {!is2D && (
                      <button
                        type="button"
                        onClick={() => setEditingMeasurementId(m.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground transition-colors cursor-pointer"
                        title="Edit label or units"
                        aria-label="Edit measurement"
                      >
                        <Pencil className="h-3 w-3" />
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => deleteMeasurement.mutate(m.id)}
                      disabled={deleteMeasurement.isPending}
                      className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 transition-colors cursor-pointer"
                      title="Delete measurement"
                      aria-label="Delete measurement"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}

        {compact && deletableItems.length > 0 && (
          <button
            type="button"
            onClick={() => setConfirmClearOpen(true)}
            className="flex w-full items-center justify-center gap-1 rounded border border-red-500/30 bg-red-500/5 py-1.5 text-[11px] font-medium text-red-400 hover:bg-red-500/15 transition-colors cursor-pointer"
          >
            <Trash2 className="h-3 w-3" />
            Clear all measurements ({deletableItems.length})
          </button>
        )}
      </div>

      {/* Part feature summary footer when not currently inspecting a single part */}
      {!compact && !activeSummary && partSummaries.length > 0 && (
        <div className="border-t border-border bg-card/40 px-3 py-2">
          <div className="flex items-center justify-between text-[10px] text-muted-foreground">
            <span className="inline-flex items-center gap-1 font-mono">
              <Layers className="h-3 w-3 text-sky-400" />
              {partSummaries.length} part{partSummaries.length === 1 ? '' : 's'} ·{' '}
              {features.length} features indexed
            </span>
            <button
              type="button"
              onClick={() => useMeasureStore.getState().inspectPart(partSummaries[0].partId)}
              className="font-mono text-sky-400 hover:underline cursor-pointer"
            >
              Inspect
            </button>
          </div>
        </div>
      )}

      <Dialog open={confirmClearOpen} onOpenChange={setConfirmClearOpen}>
        <DialogContent onClose={() => setConfirmClearOpen(false)}>
          <DialogHeader>
            <DialogTitle>Clear all measurements?</DialogTitle>
            <DialogDescription>
              This will permanently delete {deletableItems.length} saved measurement
              {deletableItems.length === 1 ? '' : 's'} on this version.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setConfirmClearOpen(false)}
              disabled={clearingAll}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              onClick={handleClearAll}
              disabled={clearingAll}
            >
              {clearingAll ? 'Deleting...' : 'Delete all'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
