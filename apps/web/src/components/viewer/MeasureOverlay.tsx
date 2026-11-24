import * as React from 'react';
import * as THREE from 'three';
import { Line } from '@react-three/drei';
import { Pencil, Trash2, X } from 'lucide-react';
import {
  isMeasurementPointsSmart,
  smartKindToMeasurementType,
  type Measurement,
  type SmartMeasurement,
  type Vec3Tuple,
} from '@cadline/shared';
import {
  convertSmartMeasurementUnit,
  formatSmartMeasurementDisplay,
  type CircleLoop,
  type CylinderFeature,
  type GeometryFeatureIndex,
  type PlanarRegion,
  type TriangleMeshData,
} from '@/lib/geometry';
import { useMeasureStore } from '@/stores/measureStore';
import { useViewerStore } from '@/stores/viewerStore';
import { useDeleteMeasurement, useUpdateMeasurement } from '@/hooks/useAnnotations';
import { cn } from '@/lib/utils';

function buildTriangleHighlightGeometry(
  mesh: TriangleMeshData,
  triangleIndices: number[]
): THREE.BufferGeometry {
  const positions = new Float32Array(triangleIndices.length * 9);
  for (let i = 0; i < triangleIndices.length; i++) {
    const t = triangleIndices[i];
    const i0 = mesh.indices[t * 3] * 3;
    const i1 = mesh.indices[t * 3 + 1] * 3;
    const i2 = mesh.indices[t * 3 + 2] * 3;
    const out = i * 9;
    positions[out] = mesh.vertices[i0];
    positions[out + 1] = mesh.vertices[i0 + 1];
    positions[out + 2] = mesh.vertices[i0 + 2];
    positions[out + 3] = mesh.vertices[i1];
    positions[out + 4] = mesh.vertices[i1 + 1];
    positions[out + 5] = mesh.vertices[i1 + 2];
    positions[out + 6] = mesh.vertices[i2];
    positions[out + 7] = mesh.vertices[i2 + 1];
    positions[out + 8] = mesh.vertices[i2 + 2];
  }
  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.computeVertexNormals();
  return geom;
}

function FeatureHighlightMesh({
  featureId,
  index,
  emphasis,
}: {
  featureId: string;
  index: GeometryFeatureIndex;
  emphasis: 'hover' | 'selected' | 'focused';
}) {
  const plane: PlanarRegion | undefined = index.planeById.get(featureId);
  const cylinder: CylinderFeature | undefined = index.cylinderById.get(featureId);
  const circle: CircleLoop | undefined = index.circleById.get(featureId);

  const highlightGeom = React.useMemo(() => {
    if (plane) {
      const part = index.parts.get(plane.partId);
      if (part) return buildTriangleHighlightGeometry(part.mesh, plane.triangleIndices);
    }
    if (cylinder) {
      const part = index.parts.get(cylinder.partId);
      if (part) return buildTriangleHighlightGeometry(part.mesh, cylinder.triangleIndices);
    }
    return null;
  }, [plane, cylinder, index]);

  React.useEffect(() => {
    return () => {
      highlightGeom?.dispose();
    };
  }, [highlightGeom]);

  if (circle) {
    const loopPts: Vec3Tuple[] =
      circle.points3D.length > 0
        ? [...circle.points3D, circle.points3D[0]]
        : [circle.center, circle.center];
    return (
      <Line
        points={loopPts}
        color="#22c55e"
        lineWidth={emphasis === 'hover' ? 3 : 4}
      />
    );
  }

  if (!highlightGeom) return null;

  const color = cylinder ? '#f97316' : '#3b82f6';
  const opacity = emphasis === 'selected' ? 0.42 : emphasis === 'focused' ? 0.48 : 0.28;

  return (
    <mesh geometry={highlightGeom} raycast={() => undefined} renderOrder={20}>
      <meshBasicMaterial
        color={color}
        transparent
        opacity={opacity}
        side={THREE.DoubleSide}
        depthWrite={false}
        polygonOffset
        polygonOffsetFactor={-2}
        polygonOffsetUnits={-2}
      />
    </mesh>
  );
}

/**
 * Mounted inside `<Canvas>`. Renders feature hover & selection highlights
 * (blue planes, orange cylinders, green circles) and the measurement keyboard
 * shortcuts. Dimension lines, arrows, points and labels are drawn in screen
 * space by DimensionOverlay2D (outside the canvas).
 */
export function MeasureOverlay3D() {
  const mode = useMeasureStore((s) => s.mode);
  const hoveredFeatureId = useMeasureStore((s) => s.hoveredFeatureId);
  const focusedFeatureId = useMeasureStore((s) => s.focusedFeatureId);
  const selection = useMeasureStore((s) => s.selection);
  const featureIndex = useMeasureStore((s) => s.featureIndex);
  const cancel = useMeasureStore((s) => s.cancel);
  const removeLastSelection = useMeasureStore((s) => s.removeLastSelection);
  const commitResult = useMeasureStore((s) => s.commitResult);


  // Global keyboard shortcuts for measurement workflow (ESC, Backspace, Enter)
  React.useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable)
      ) {
        return;
      }
      const state = useMeasureStore.getState();
      if (state.mode === 'off' && !state.editingMeasurementId) return;

      if (e.key === 'Escape') {
        e.preventDefault();
        cancel();
      } else if (e.key === 'Backspace' && state.selection.length > 0) {
        e.preventDefault();
        removeLastSelection();
      } else if (e.key === 'Enter' && state.pendingResult) {
        e.preventDefault();
        commitResult();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [cancel, removeLastSelection, commitResult]);

  const selectedFeatureIds = React.useMemo(() => {
    const ids = new Set<string>();
    for (const ref of selection) {
      if (ref.featureId) ids.add(ref.featureId);
    }
    return Array.from(ids);
  }, [selection]);

  return (
    <group>
      {/* Feature surface highlights */}
      {featureIndex && hoveredFeatureId && mode !== 'off' && (
        <FeatureHighlightMesh
          featureId={hoveredFeatureId}
          index={featureIndex}
          emphasis="hover"
        />
      )}

      {featureIndex &&
        selectedFeatureIds.map((fid) => (
          <FeatureHighlightMesh
            key={`sel-${fid}`}
            featureId={fid}
            index={featureIndex}
            emphasis="selected"
          />
        ))}

      {featureIndex && focusedFeatureId && (
        <FeatureHighlightMesh
          featureId={focusedFeatureId}
          index={featureIndex}
          emphasis="focused"
        />
      )}

    </group>
  );
}

interface MeasureLabelOverlayProps {
  fileId?: string;
  canEdit?: boolean;
}

/**
 * React-19-safe DOM overlay mounted outside `<Canvas>` for the Quick Measure
 * hover tooltip and the double-click measurement edit popup. Dimension labels
 * are rendered by DimensionOverlay2D.
 */
export function MeasureLabelOverlay({
  fileId,
  canEdit = true,
}: MeasureLabelOverlayProps) {
  const mode = useMeasureStore((s) => s.mode);
  const quickPreview = useMeasureStore((s) => s.quickPreview);
  const hoveredScreenPos = useMeasureStore((s) => s.hoveredScreenPos);
  const persistedResults = useMeasureStore((s) => s.persistedResults);
  const displayUnit = useMeasureStore((s) => s.displayUnit);
  const editingMeasurementId = useMeasureStore((s) => s.editingMeasurementId);
  const setEditingMeasurementId = useMeasureStore((s) => s.setEditingMeasurementId);

  const persistedRaw = useViewerStore((s) => s.persistedMeasurements);
  const updateMeasurement = useUpdateMeasurement(fileId ?? '');
  const deleteMeasurement = useDeleteMeasurement(fileId ?? '');

  const editingTarget = React.useMemo(() => {
    if (!editingMeasurementId) return null;
    return persistedResults.find((m) => m.id === editingMeasurementId) ?? null;
  }, [editingMeasurementId, persistedResults]);

  const [draftLabel, setDraftLabel] = React.useState('');
  const [draftUnit, setDraftUnit] = React.useState<'mm' | 'in'>('mm');

  React.useEffect(() => {
    if (!editingTarget) return;
    setDraftLabel(editingTarget.label ?? '');
    const isIn =
      editingTarget.unit === 'in' ||
      editingTarget.unit === 'in²' ||
      editingTarget.unit === 'in³';
    setDraftUnit(isIn ? 'in' : 'mm');
  }, [editingTarget]);

  const handleSaveEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTarget || !fileId) return;
    const converted = convertSmartMeasurementUnit(editingTarget, draftUnit);
    const updatedSmart: SmartMeasurement = {
      ...converted,
      label: draftLabel.trim() || undefined,
    };

    // Preserve existing raw coordinates if present
    const rawMatch: Measurement | undefined = (persistedRaw ?? []).find(
      (m) => m.id === editingTarget.id
    );
    const existingCoords =
      rawMatch && isMeasurementPointsSmart(rawMatch.points)
        ? rawMatch.points.coordinates
        : undefined;

    await updateMeasurement.mutateAsync({
      id: editingTarget.id,
      body: {
        value: updatedSmart.value,
        unit: updatedSmart.unit,
        points: {
          smart: updatedSmart,
          ...(existingCoords ? { coordinates: existingCoords } : {}),
        },
      },
    });
    setEditingMeasurementId(null);
  };

  const handleDeleteEdit = async () => {
    if (!editingTarget || !fileId) return;
    await deleteMeasurement.mutateAsync(editingTarget.id);
    setEditingMeasurementId(null);
  };

  const formatForDisplay = (m: SmartMeasurement) => {
    const converted = convertSmartMeasurementUnit(m, displayUnit);
    return formatSmartMeasurementDisplay(converted);
  };

  return (
    <>
      {/* Quick Measure floating cursor tooltip */}
      {mode === 'quick' && quickPreview && hoveredScreenPos && (
        <div
          style={{
            transform: `translate3d(${(hoveredScreenPos.x + 14).toFixed(0)}px, ${(hoveredScreenPos.y - 28).toFixed(0)}px, 0)`,
          }}
          className="pointer-events-none absolute left-0 top-0 z-20 flex flex-col gap-0.5 rounded-md border border-sky-500/70 bg-[#0d131f] px-2.5 py-1.5 shadow-2xl"
        >
          <span className="font-mono text-xs font-semibold tabular-nums text-sky-300">
            {formatForDisplay(quickPreview)}
          </span>
          {quickPreview.label && (
            <span className="font-mono text-[10px] text-slate-400">
              {quickPreview.label}
            </span>
          )}
        </div>
      )}

      {/* Double-click Edit Measurement popup */}
      {editingTarget && canEdit && (
        <div className="absolute right-4 top-4 z-30 w-72 rounded-lg border border-border bg-[#121721] p-3.5 text-xs shadow-2xl">
          <div className="mb-2.5 flex items-center justify-between">
            <div className="flex items-center gap-1.5 font-semibold text-foreground">
              <Pencil className="h-3.5 w-3.5 text-amber-400" />
              <span>Edit Measurement</span>
            </div>
            <button
              type="button"
              onClick={() => setEditingMeasurementId(null)}
              className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
              aria-label="Close measurement editor"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>

          <form onSubmit={handleSaveEdit} className="space-y-2.5">
            <div>
              <label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
                Label
              </label>
              <input
                type="text"
                value={draftLabel}
                onChange={(e) => setDraftLabel(e.target.value)}
                placeholder="e.g. Bore diameter, Flange wall..."
                className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                autoFocus
              />
            </div>

            {editingTarget.unit !== 'deg' && (
              <div>
                <label className="mb-1 block font-mono text-[10px] uppercase text-muted-foreground">
                  Display Unit
                </label>
                <div className="flex rounded border border-border bg-background p-0.5">
                  {(['mm', 'in'] as const).map((u) => (
                    <button
                      key={u}
                      type="button"
                      onClick={() => setDraftUnit(u)}
                      className={cn(
                        'flex-1 rounded py-1 font-mono text-[11px] transition-colors cursor-pointer',
                        draftUnit === u
                          ? 'bg-primary text-primary-foreground'
                          : 'text-muted-foreground hover:text-foreground'
                      )}
                    >
                      {u === 'mm' ? 'Metric (mm)' : 'Imperial (in)'}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-1">
              <button
                type="button"
                onClick={handleDeleteEdit}
                disabled={deleteMeasurement.isPending}
                className="inline-flex items-center gap-1 rounded border border-red-500/40 bg-red-500/10 px-2 py-1 text-[11px] font-medium text-red-400 hover:bg-red-500/20 cursor-pointer"
              >
                <Trash2 className="h-3 w-3" />
                Delete
              </button>

              <button
                type="submit"
                disabled={updateMeasurement.isPending}
                className="inline-flex items-center gap-1 rounded bg-primary px-3 py-1 text-[11px] font-medium text-primary-foreground hover:bg-primary/90 cursor-pointer"
              >
                {updateMeasurement.isPending ? 'Saving...' : 'Save'}
              </button>
            </div>
          </form>
        </div>
      )}
    </>
  );
}

export { smartKindToMeasurementType };
