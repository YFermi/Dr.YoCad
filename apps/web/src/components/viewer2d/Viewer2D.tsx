import * as React from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle,
  ExternalLink,
  FileUp,
  Send,
  X,
} from 'lucide-react';
import {
  AnnotationType,
  MeasurementType,
  isAnnotationAnchor2D,
  isMeasurementPoints2D,
  normalizeAnnotationAnchor,
  type AnnotationShape2DKind,
  type File2DSceneResponse,
  type Point2D,
} from '@cadline/shared';
import { ApiClientError, apiFetch } from '@/lib/api';
import { useViewerStore } from '@/stores/viewerStore';
import {
  useViewer2DStore,
  type ShapeDraft,
} from '@/stores/viewer2dStore';
import {
  useAnnotations,
  useCreateAnnotation,
  useCreateMeasurement,
  useMeasurements,
} from '@/hooks/useAnnotations';
import {
  computeAngle2DDeg,
  computeDistance2D,
  computePolygonArea2D,
} from '@/components/viewer2d/snapping';
import { DxfStage } from '@/components/viewer2d/DxfStage';
import { PdfStage } from '@/components/viewer2d/PdfStage';
import { Viewer2DToolbar } from '@/components/viewer2d/Viewer2DToolbar';
import { AnnotationDetailPopup } from '@/components/viewer/AnnotationDetailPopup';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';

type SceneQueryResult = File2DSceneResponse | { status: 'processing' };

function isProcessingResponse(
  data: SceneQueryResult | undefined
): data is { status: 'processing' } {
  return Boolean(data && 'status' in data && data.status === 'processing');
}

function mapToolToAnnotationType(tool: AnnotationShape2DKind): AnnotationType {
  switch (tool) {
    case 'pin':
      return AnnotationType.PIN;
    case 'arrow':
      return AnnotationType.ARROW;
    case 'cloud':
      return AnnotationType.CLOUD;
    case 'freehand':
      return AnnotationType.FREEHAND;
    case 'text':
    case 'rect':
    case 'ellipse':
      return AnnotationType.CALLOUT;
  }
}

interface PendingLabelDraft {
  tool: 'pin' | 'text';
  sheet: 'dxf' | 'pdf';
  page?: number;
  point: Point2D;
  screenPos: Point2D;
}

export interface Viewer2DSceneMeta {
  mode: '2D_DXF' | '2D_PDF' | null;
  pageCount?: number;
}

interface Viewer2DProps {
  fileId: string;
  projectId?: string;
  fileName?: string;
  versionNumber?: number;
  versionId?: string;
  shareToken?: string;
  activePage?: number;
  onActivePageChange?: (page: number) => void;
  onSceneMetaChange?: (meta: Viewer2DSceneMeta) => void;
}

export function Viewer2D({
  fileId,
  projectId,
  fileName,
  versionNumber,
  versionId,
  shareToken,
  activePage = 1,
  onActivePageChange,
  onSceneMetaChange,
}: Viewer2DProps) {
  const [pendingPopover, setPendingPopover] = React.useState<PendingLabelDraft | null>(
    null
  );
  const [popoverInput, setPopoverInput] = React.useState('');

  // Reset 2D store on file/version change
  const reset2DState = useViewer2DStore((s) => s.reset2DState);
  const setLayers = useViewer2DStore((s) => s.setLayers);
  const setUnits = useViewer2DStore((s) => s.setUnits);
  const setSelection2D = useViewer2DStore((s) => s.setSelection);
  const registerCommitHandler = useViewer2DStore((s) => s.registerCommitHandler);
  const setTool = useViewer2DStore((s) => s.setTool);

  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const selectAnnotation3DStore = useViewerStore((s) => s.selectAnnotation);
  const setAnnotationsInStore = useViewerStore((s) => s.setAnnotations);
  const setPersistedMeasurementsInStore = useViewerStore(
    (s) => s.setPersistedMeasurements
  );

  React.useEffect(() => {
    reset2DState();
    setPendingPopover(null);
    return () => {
      reset2DState();
    };
  }, [fileId, versionId, reset2DState]);

  // Fetch 2D scene graph (DXF) or page manifest (PDF), polling on 202
  const sceneQuery = useQuery<SceneQueryResult, ApiClientError>({
    queryKey: ['file-2d-scene', fileId, versionNumber ?? 'current', shareToken ?? 'auth'],
    queryFn: () => {
      const qs = versionNumber ? `?v=${versionNumber}` : '';
      return apiFetch<SceneQueryResult>(`/files/${fileId}/2d/scene${qs}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      });
    },
    refetchInterval: (query) =>
      isProcessingResponse(query.state.data) ? 1500 : false,
    retry: (failureCount, err) => {
      if (err instanceof ApiClientError && (err.status === 422 || err.status === 400 || err.status === 404)) {
        return false;
      }
      return failureCount < 2;
    },
  });

  // Load persisted annotations & measurements for this version
  const annotationsQuery = useAnnotations(fileId, versionId, shareToken);
  const measurementsQuery = useMeasurements(fileId, versionId, shareToken);
  const createAnnotation = useCreateAnnotation(fileId);
  const createMeasurement = useCreateMeasurement(fileId);

  React.useEffect(() => {
    if (annotationsQuery.data) {
      setAnnotationsInStore(annotationsQuery.data);
    }
  }, [annotationsQuery.data, setAnnotationsInStore]);

  React.useEffect(() => {
    if (measurementsQuery.data) {
      setPersistedMeasurementsInStore(measurementsQuery.data);
    }
  }, [measurementsQuery.data, setPersistedMeasurementsInStore]);

  // Sync DXF layers / PDF page count into stores & parent FileViewer
  React.useEffect(() => {
    const data = sceneQuery.data;
    if (!data || isProcessingResponse(data)) {
      onSceneMetaChange?.({ mode: null });
      return;
    }

    if (data.mode === '2D_DXF') {
      setLayers(data.layers);
      setUnits(data.bounds.units || data.scene.units || 'mm');
      onSceneMetaChange?.({ mode: '2D_DXF' });
    } else {
      setLayers([]);
      setUnits('px');
      onSceneMetaChange?.({
        mode: '2D_PDF',
        pageCount: data.pageManifest.pageCount,
      });
    }
  }, [onSceneMetaChange, sceneQuery.data, setLayers, setUnits]);

  const handleSelectAnnotation = React.useCallback(
    (id: string | null) => {
      setSelection2D(id);
      selectAnnotation3DStore(id);
    },
    [selectAnnotation3DStore, setSelection2D]
  );

  // Register commitHandler so DxfStage / PdfStage drafts persist via React Query
  React.useEffect(() => {
    const handler = async (draft: ShapeDraft) => {
      if (!versionId || shareToken) return;
      const state = useViewer2DStore.getState();
      const unit = draft.sheet === 'dxf' ? state.units || 'mm' : 'px';

      if (draft.tool === 'distance' && draft.points.length >= 2) {
        const value = computeDistance2D(draft.points[0], draft.points[1]);
        await createMeasurement.mutateAsync({
          versionId,
          type: MeasurementType.DISTANCE,
          value: Number(value.toFixed(3)),
          unit,
          points: {
            points2d: draft.points.slice(0, 2),
            sheet: draft.sheet,
            ...(draft.page !== undefined ? { page: draft.page } : {}),
          },
        });
        return;
      }

      if (draft.tool === 'angle' && draft.points.length >= 3) {
        const deg = computeAngle2DDeg(
          draft.points[0],
          draft.points[1],
          draft.points[2]
        );
        await createMeasurement.mutateAsync({
          versionId,
          type: MeasurementType.ANGLE,
          value: Number(deg.toFixed(2)),
          unit: '°',
          points: {
            points2d: draft.points.slice(0, 3),
            sheet: draft.sheet,
            ...(draft.page !== undefined ? { page: draft.page } : {}),
          },
        });
        return;
      }

      if (draft.tool === 'area' && draft.points.length >= 3) {
        const area = computePolygonArea2D(draft.points);
        await createMeasurement.mutateAsync({
          versionId,
          type: MeasurementType.AREA,
          value: Number(area.toFixed(3)),
          unit: `${unit}²`,
          points: {
            points2d: draft.points,
            sheet: draft.sheet,
            ...(draft.page !== undefined ? { page: draft.page } : {}),
          },
        });
        return;
      }

      // Markup annotation (arrow, rect, ellipse, cloud, freehand, pin, text)
      if (
        draft.tool === 'pin' ||
        draft.tool === 'arrow' ||
        draft.tool === 'rect' ||
        draft.tool === 'ellipse' ||
        draft.tool === 'cloud' ||
        draft.tool === 'freehand' ||
        draft.tool === 'text'
      ) {
        const anchorPt = draft.points[0] ?? { x: 0, y: 0 };
        const defaultLabelByTool: Record<AnnotationShape2DKind, string> = {
          pin: '2D Pin',
          arrow: 'Arrow callout',
          rect: 'Rectangle markup',
          ellipse: 'Ellipse markup',
          cloud: 'Revision cloud',
          freehand: 'Freehand sketch',
          text: draft.text || 'Text note',
        };

        const created = await createAnnotation.mutateAsync({
          versionId,
          type: mapToolToAnnotationType(draft.tool),
          label: draft.label || defaultLabelByTool[draft.tool],
          payload: {
            anchor: {
              kind: '2d',
              sheet: draft.sheet,
              ...(draft.page !== undefined ? { page: draft.page } : {}),
              x: Number(anchorPt.x.toFixed(3)),
              y: Number(anchorPt.y.toFixed(3)),
              view: {
                scale: state.zoom || 1,
                offsetX: state.offsetX || 0,
                offsetY: state.offsetY || 0,
              },
            },
            shape: {
              shapeType: draft.tool,
              color: draft.color,
              strokeWidth: 2,
              points: draft.points,
              ...(draft.text ? { text: draft.text, fontSize: 13 } : {}),
            },
          },
        });

        handleSelectAnnotation(created.id);
      }
    };

    registerCommitHandler(handler);
    return () => registerCommitHandler(null);
  }, [
    createAnnotation,
    createMeasurement,
    handleSelectAnnotation,
    registerCommitHandler,
    shareToken,
    versionId,
  ]);

  const handleSubmitPopover = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!pendingPopover || !versionId || shareToken) {
      setPendingPopover(null);
      return;
    }

    const trimmed = popoverInput.trim();
    const labelText =
      trimmed || (pendingPopover.tool === 'pin' ? '2D Review Pin' : 'Callout');
    const state = useViewer2DStore.getState();

    const draft: ShapeDraft = {
      tool: pendingPopover.tool,
      sheet: pendingPopover.sheet,
      page: pendingPopover.page,
      points: [pendingPopover.point],
      label: labelText,
      text: pendingPopover.tool === 'text' ? labelText : undefined,
      color: pendingPopover.tool === 'pin' ? '#0b5fff' : '#38bdf8',
    };

    setPendingPopover(null);
    setPopoverInput('');
    setTool('select');

    if (state.commitHandler) {
      await state.commitHandler(draft);
    }
  };

  // Filter annotations & measurements to 2D entries
  const annotations2D = React.useMemo(
    () =>
      (annotationsQuery.data ?? []).filter((ann) =>
        isAnnotationAnchor2D(normalizeAnnotationAnchor(ann.payload?.anchor))
      ),
    [annotationsQuery.data]
  );

  const measurements2D = React.useMemo(
    () =>
      (measurementsQuery.data ?? []).filter((m) =>
        isMeasurementPoints2D(m.points)
      ),
    [measurementsQuery.data]
  );

  // Loading / Processing states
  if (sceneQuery.isLoading || isProcessingResponse(sceneQuery.data)) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117] p-6 text-center">
        <Spinner />
        <p className="text-sm font-medium text-foreground">
          {isProcessingResponse(sceneQuery.data)
            ? 'Converting 2D drawing…'
            : 'Loading 2D drawing…'}
        </p>
        <p className="max-w-sm text-xs text-muted-foreground">
          Parsing vector layers and sheet geometry for crisp pan, zoom, and markup.
        </p>
      </div>
    );
  }

  // FAILED / DWG proprietary format state
  if (sceneQuery.isError || !sceneQuery.data) {
    const errMessage =
      sceneQuery.error?.message ||
      'Unable to display this 2D drawing.';
    const isDwg =
      errMessage.toLowerCase().includes('dwg') ||
      (fileName?.toLowerCase().endsWith('.dwg') ?? false);

    return (
      <div className="flex h-full w-full flex-col items-center justify-center bg-[#0d1117] p-8 text-center">
        <div className="w-full max-w-md rounded-lg border border-amber-500/30 bg-[#121721] p-6 shadow-xl space-y-4">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-md border border-amber-500/40 bg-amber-500/10 text-amber-400">
            <AlertTriangle className="h-5 w-5" />
          </div>

          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold text-foreground">
              {isDwg ? 'Unsupported Proprietary DWG Format' : '2D Conversion Failed'}
            </h2>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {errMessage}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
            {projectId ? (
              <Link to={`/projects/${projectId}`}>
                <Button size="sm">
                  <FileUp className="h-3.5 w-3.5" />
                  Upload DXF instead
                </Button>
              </Link>
            ) : (
              <Link to="/projects">
                <Button size="sm">
                  <FileUp className="h-3.5 w-3.5" />
                  Upload DXF instead
                </Button>
              </Link>
            )}

            <a
              href="https://wiki.freecad.org/FreeCAD_and_DWG_Import"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex h-8 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-accent transition-colors"
            >
              How to convert DWG → DXF
              <ExternalLink className="h-3 w-3 text-muted-foreground" />
            </a>
          </div>
        </div>
      </div>
    );
  }

  const sceneData = sceneQuery.data;

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0d1117]">
      {sceneData.mode === '2D_DXF' ? (
        <DxfStage
          scene={sceneData.scene}
          layers={sceneData.layers}
          bounds={sceneData.bounds}
          fileName={fileName}
          annotations={annotations2D}
          measurements={measurements2D}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={handleSelectAnnotation}
          onRequestPinOrText={({ tool, point, screenPos }) => {
            if (shareToken) return;
            setPendingPopover({
              tool,
              sheet: 'dxf',
              point,
              screenPos,
            });
            setPopoverInput('');
          }}
        />
      ) : (
        <PdfStage
          fileId={fileId}
          fileName={fileName}
          versionNumber={versionNumber}
          shareToken={shareToken}
          pageManifest={sceneData.pageManifest}
          activePage={activePage}
          onActivePageChange={onActivePageChange}
          annotations={annotations2D}
          measurements={measurements2D}
          selectedAnnotationId={selectedAnnotationId}
          onSelectAnnotation={handleSelectAnnotation}
          onRequestPinOrText={({ tool, page, point, screenPos }) => {
            if (shareToken) return;
            setPendingPopover({
              tool,
              sheet: 'pdf',
              page,
              point,
              screenPos,
            });
            setPopoverInput('');
          }}
        />
      )}

      {/* Floating popover for Pin label / Text callout creation */}
      {pendingPopover && (
        <form
          onSubmit={handleSubmitPopover}
          style={{
            left: Math.min(Math.max(pendingPopover.screenPos.x + 12, 16), 520),
            top: Math.max(pendingPopover.screenPos.y - 24, 16),
          }}
          className="absolute z-30 flex w-64 items-center gap-1.5 rounded-lg border border-primary/60 bg-[#121721] p-2 shadow-2xl"
        >
          <Input
            value={popoverInput}
            onChange={(e) => setPopoverInput(e.target.value)}
            placeholder={
              pendingPopover.tool === 'pin'
                ? 'Pin label (e.g. Check bore Ø8)…'
                : 'Callout text…'
            }
            className="h-7 bg-background text-xs"
            maxLength={240}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setPendingPopover(null);
              }
            }}
          />
          <Button
            type="submit"
            size="sm"
            className="h-7 px-2"
            disabled={createAnnotation.isPending}
            aria-label="Save annotation"
          >
            <Send className="h-3 w-3" />
          </Button>
          <button
            type="button"
            onClick={() => setPendingPopover(null)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            aria-label="Cancel"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </form>
      )}

      {/* Bottom floating 2D toolbar */}
      <Viewer2DToolbar showSnaps={sceneData.mode === '2D_DXF'} />

      {/* Linked Annotation Detail Popup (shared with 3D review flow) */}
      <AnnotationDetailPopup
        fileId={fileId}
        versionId={versionId}
        shareToken={shareToken}
      />
    </div>
  );
}
