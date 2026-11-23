import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import {
  FileStatus,
  MeasurementType,
  smartKindToMeasurementType,
  type CreateMeasurementRequest,
  type FileGlbResponse,
  type FileStatusResponse,
  type FileTreeResponse,
  type MeasurementPoint3D,
  type PartNode,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { useViewerStore } from '@/stores/viewerStore';
import { useMeasureStore } from '@/stores/measureStore';
import {
  useAnnotations,
  useCreateMeasurement,
  useMeasurements,
} from '@/hooks/useAnnotations';
import { Viewer3D } from '@/components/viewer/Viewer3D';
import { ViewerToolbar } from '@/components/viewer/ViewerToolbar';
import { MeasureStatusHud } from '@/components/viewer/MeasureToolbar';
import { AnnotationDraftForm } from '@/components/viewer/AnnotationCreateTool';
import { AnnotationDetailPopup } from '@/components/viewer/AnnotationDetailPopup';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast';

interface ViewerLoaderProps {
  fileId: string;
  fileName: string;
  versionNumber?: number;
  versionId?: string;
  shareToken?: string;
}

export function ViewerLoader({
  fileId,
  fileName,
  versionNumber,
  versionId,
  shareToken,
}: ViewerLoaderProps) {
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const modelUrl = useViewerStore((s) => s.modelUrl);
  const annotationMode = useViewerStore((s) => s.annotationMode);
  const annotationDraft = useViewerStore((s) => s.annotationDraft);
  const lastCompletedMeasurement = useViewerStore((s) => s.lastCompletedMeasurement);
  const setModel = useViewerStore((s) => s.setModel);
  const setAnnotations = useViewerStore((s) => s.setAnnotations);
  const setPersistedMeasurements = useViewerStore((s) => s.setPersistedMeasurements);
  const removeLocalMeasurement = useViewerStore((s) => s.removeLocalMeasurement);
  const consumeCompletedMeasurement = useViewerStore((s) => s.consumeCompletedMeasurement);

  const lastCommittedSmart = useMeasureStore((s) => s.lastCommittedSmart);
  const consumeCommittedSmart = useMeasureStore((s) => s.consumeCommittedSmart);
  const removeLocalSmartResult = useMeasureStore((s) => s.removeLocalResult);
  const setPersistedSmartMeasurements = useMeasureStore((s) => s.setPersistedMeasurements);
  const resetMeasureForModel = useMeasureStore((s) => s.resetForModel);

  const versionQuerySuffix = versionNumber ? `?v=${versionNumber}` : '';

  const statusQuery = useQuery({
    queryKey: ['file-status', fileId, versionNumber ?? 'latest', shareToken ?? 'auth'],
    queryFn: () =>
      apiFetch<FileStatusResponse>(`/files/${fileId}/status${versionQuerySuffix}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      }),
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === FileStatus.PROCESSING || status === FileStatus.UPLOADING) {
        return 3000;
      }
      return false;
    },
  });

  const currentStatus = statusQuery.data?.status;

  const assetsQuery = useQuery({
    queryKey: [
      'file-viewer-assets',
      fileId,
      versionNumber ?? 'latest',
      shareToken ?? 'auth',
    ],
    enabled: currentStatus === FileStatus.READY,
    queryFn: async () => {
      const [glb, tree] = await Promise.all([
        apiFetch<FileGlbResponse>(`/files/${fileId}/glb${versionQuerySuffix}`, {
          shareToken,
          skipAuth: Boolean(shareToken),
        }),
        apiFetch<FileTreeResponse>(`/files/${fileId}/tree${versionQuerySuffix}`, {
          shareToken,
          skipAuth: Boolean(shareToken),
        }),
      ]);
      return { glb, tree };
    },
  });

  // Sync persisted annotations & measurements for the active file version
  const annotationsQuery = useAnnotations(fileId, versionId, shareToken);
  const measurementsQuery = useMeasurements(fileId, versionId, shareToken);
  const createMeasurement = useCreateMeasurement(fileId);

  React.useEffect(() => {
    if (annotationsQuery.data) {
      setAnnotations(annotationsQuery.data);
    }
  }, [annotationsQuery.data, setAnnotations]);

  React.useEffect(() => {
    if (measurementsQuery.data) {
      setPersistedMeasurements(measurementsQuery.data);
      setPersistedSmartMeasurements(measurementsQuery.data);
    }
  }, [measurementsQuery.data, setPersistedMeasurements, setPersistedSmartMeasurements]);

  // Auto-persist completed legacy distance/angle measurements (Session 3 B7)
  React.useEffect(() => {
    if (!lastCompletedMeasurement) return;
    const completed = lastCompletedMeasurement;
    consumeCompletedMeasurement();

    if (shareToken || !user || !versionId) {
      return;
    }

    const requestBody: CreateMeasurementRequest = {
      versionId,
      type:
        completed.type === 'angle'
          ? MeasurementType.ANGLE
          : MeasurementType.DISTANCE,
      value: Number(completed.value.toFixed(4)),
      unit: completed.unit,
      points: {
        coordinates: completed.points.map((p) => ({
          x: Number(p.x.toFixed(4)),
          y: Number(p.y.toFixed(4)),
          z: Number(p.z.toFixed(4)),
        })),
      },
    };

    void createMeasurement
      .mutateAsync(requestBody)
      .then(() => {
        removeLocalMeasurement(completed.id);
      })
      .catch(() => {
        // Keep local measurement visible if persistence fails; hook displays error toast
      });
  }, [
    lastCompletedMeasurement,
    consumeCompletedMeasurement,
    shareToken,
    user,
    versionId,
    createMeasurement,
    removeLocalMeasurement,
  ]);

  // Auto-persist committed Session 7 SmartMeasurements via existing Session 3 measurements API
  React.useEffect(() => {
    if (!lastCommittedSmart) return;
    const smart = lastCommittedSmart;
    consumeCommittedSmart();

    if (shareToken || !user || !versionId) {
      return;
    }

    const coordinates: MeasurementPoint3D[] = [];
    if (smart.lineStart && smart.angleVertex && smart.lineEnd) {
      coordinates.push(
        { x: smart.lineStart[0], y: smart.lineStart[1], z: smart.lineStart[2] },
        { x: smart.angleVertex[0], y: smart.angleVertex[1], z: smart.angleVertex[2] },
        { x: smart.lineEnd[0], y: smart.lineEnd[1], z: smart.lineEnd[2] }
      );
    } else if (smart.lineStart && smart.lineEnd) {
      coordinates.push(
        { x: smart.lineStart[0], y: smart.lineStart[1], z: smart.lineStart[2] },
        { x: smart.lineEnd[0], y: smart.lineEnd[1], z: smart.lineEnd[2] }
      );
    }

    const requestBody: CreateMeasurementRequest = {
      versionId,
      type: smartKindToMeasurementType(smart.kind),
      value: Number(smart.value.toFixed(4)),
      unit: smart.unit,
      points: {
        smart,
        ...(coordinates.length >= 2 ? { coordinates } : {}),
      },
    };

    void createMeasurement
      .mutateAsync(requestBody)
      .then(() => {
        removeLocalSmartResult(smart.id);
      })
      .catch(() => {
        // Keep local smart measurement visible if persistence fails
      });
  }, [
    lastCommittedSmart,
    consumeCommittedSmart,
    shareToken,
    user,
    versionId,
    createMeasurement,
    removeLocalSmartResult,
  ]);

  React.useEffect(() => {
    if (!assetsQuery.data?.glb?.url) return;
    const rawTree = assetsQuery.data.tree?.partTree;
    const safeTree: PartNode[] =
      rawTree && rawTree.length > 0
        ? rawTree
        : [{ id: 'part-1', name: fileName, children: [] }];
    setModel(assetsQuery.data.glb.url, safeTree);
  }, [assetsQuery.data, fileName, setModel]);

  React.useEffect(() => {
    return () => {
      setModel(null, []);
      setAnnotations(null);
      setPersistedMeasurements(null);
      setPersistedSmartMeasurements(null);
      resetMeasureForModel();
    };
  }, [
    fileId,
    versionNumber,
    setModel,
    setAnnotations,
    setPersistedMeasurements,
    setPersistedSmartMeasurements,
    resetMeasureForModel,
  ]);

  const reconvertMutation = useMutation({
    mutationFn: () =>
      apiFetch(`/files/${fileId}/reconvert${versionQuerySuffix}`, {
        method: 'POST',
      }),
    onSuccess: async () => {
      toast.info('Conversion requeued', 'Processing 3D geometry...');
      await queryClient.invalidateQueries({
        queryKey: ['file-status', fileId],
      });
    },
    onError: (err) => {
      toast.error(
        'Could not retry conversion',
        err instanceof Error ? err.message : 'Unexpected error'
      );
    },
  });

  if (statusQuery.isLoading) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117]">
        <Spinner size="lg" />
        <p className="font-mono text-xs text-muted-foreground">
          Checking model status...
        </p>
      </div>
    );
  }

  if (statusQuery.error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117] p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm font-medium text-foreground">
          Unable to inspect model status
        </p>
        <p className="max-w-md font-mono text-xs text-muted-foreground">
          {statusQuery.error instanceof Error
            ? statusQuery.error.message
            : 'Unexpected error'}
        </p>
      </div>
    );
  }

  if (
    currentStatus === FileStatus.PROCESSING ||
    currentStatus === FileStatus.UPLOADING
  ) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117] p-6 text-center">
        <Spinner size="lg" />
        <p className="text-sm font-medium text-foreground">
          Converting CAD geometry to 3D...
        </p>
        <p className="max-w-md font-mono text-xs text-muted-foreground">
          Tessellating solids and extracting assembly hierarchy for{' '}
          <span className="text-foreground">{fileName}</span>. Polling every 3s.
        </p>
      </div>
    );
  }

  if (currentStatus === FileStatus.FAILED) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0d1117] p-6 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-lg border border-red-500/30 bg-red-500/10 text-red-400">
          <AlertTriangle className="h-6 w-6" />
        </div>
        <div className="space-y-1">
          <p className="text-sm font-semibold text-foreground">
            3D Conversion Failed
          </p>
          <p className="max-w-md font-mono text-xs text-muted-foreground">
            {statusQuery.data?.error ||
              'The CAD converter could not process this file format.'}
          </p>
        </div>
        {!shareToken && (
          <Button
            size="sm"
            variant="outline"
            disabled={reconvertMutation.isPending}
            onClick={() => reconvertMutation.mutate()}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 ${reconvertMutation.isPending ? 'animate-spin' : ''}`}
            />
            {reconvertMutation.isPending ? 'Requeuing...' : 'Retry conversion'}
          </Button>
        )}
      </div>
    );
  }

  if (assetsQuery.isLoading || !modelUrl) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117]">
        <Spinner size="lg" />
        <p className="font-mono text-xs text-muted-foreground">
          Fetching converted GLB &amp; part tree...
        </p>
      </div>
    );
  }

  if (assetsQuery.error) {
    return (
      <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0d1117] p-6 text-center">
        <AlertTriangle className="h-8 w-8 text-red-400" />
        <p className="text-sm font-medium text-foreground">
          Failed to fetch 3D model URL
        </p>
        <p className="max-w-md font-mono text-xs text-muted-foreground">
          {assetsQuery.error instanceof Error
            ? assetsQuery.error.message
            : 'Unexpected error'}
        </p>
      </div>
    );
  }

  return (
    <div className="relative h-full w-full overflow-hidden">
      {annotationMode && !annotationDraft && (
        <div className="pointer-events-none absolute left-4 top-4 z-20 rounded-md border border-amber-500/60 bg-[#121721] px-3 py-1.5 font-mono text-xs text-amber-300 shadow-lg">
          Annotation tool: click any surface on the model to place a 3D pin
        </div>
      )}

      <MeasureStatusHud canPersist={!shareToken && Boolean(user)} />

      <Viewer3D
        modelUrl={modelUrl}
        fileId={fileId}
        fileName={fileName}
        versionId={versionId}
        shareToken={shareToken}
        canEditMeasurements={!shareToken && Boolean(user)}
      />

      {!shareToken && user && (
        <AnnotationDraftForm fileId={fileId} versionId={versionId} />
      )}

      <AnnotationDetailPopup
        fileId={fileId}
        versionId={versionId}
        shareToken={shareToken}
      />

      <ViewerToolbar canAnnotate={!shareToken && Boolean(user)} />
    </div>
  );
}
