import * as React from 'react';
import { useThree, type ThreeEvent } from '@react-three/fiber';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import {
  AnnotationType,
  type AnnotationAnchor3D,
  type CreateAnnotationRequest,
  type Vec3Tuple,
} from '@cadline/shared';
import { MapPin, X } from 'lucide-react';
import { useViewerStore } from '@/stores/viewerStore';
import { useCreateAnnotation } from '@/hooks/useAnnotations';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export type CaptureAnnotationHitFn = (
  event: ThreeEvent<MouseEvent>,
  partId: string | null
) => void;

interface AnnotationCreateToolProps {
  captureHitRef: React.RefObject<CaptureAnnotationHitFn | null>;
}

/**
 * Mounted inside <Canvas>. Captures the active R3F camera + OrbitControls
 * pose together with the raycast surface point, normal, and partId.
 */
export function AnnotationCreateTool({ captureHitRef }: AnnotationCreateToolProps) {
  const { camera, controls } = useThree();
  const startAnnotationDraft = useViewerStore((s) => s.startAnnotationDraft);

  React.useEffect(() => {
    const capture: CaptureAnnotationHitFn = (event, partId) => {
      const orbitControls = controls as OrbitControlsImpl | null;
      const targetVec = orbitControls?.target;
      const position: Vec3Tuple = [
        Number(event.point.x.toFixed(3)),
        Number(event.point.y.toFixed(3)),
        Number(event.point.z.toFixed(3)),
      ];
      const normal: Vec3Tuple | undefined = event.face?.normal
        ? [
            Number(event.face.normal.x.toFixed(4)),
            Number(event.face.normal.y.toFixed(4)),
            Number(event.face.normal.z.toFixed(4)),
          ]
        : undefined;

      const cameraPosition: Vec3Tuple = [
        Number(camera.position.x.toFixed(3)),
        Number(camera.position.y.toFixed(3)),
        Number(camera.position.z.toFixed(3)),
      ];
      const cameraTarget: Vec3Tuple = targetVec
        ? [
            Number(targetVec.x.toFixed(3)),
            Number(targetVec.y.toFixed(3)),
            Number(targetVec.z.toFixed(3)),
          ]
        : [0, 0, 0];

      const anchor: AnnotationAnchor3D = {
        kind: '3d',
        position,
        ...(normal ? { normal } : {}),
        cameraPose: {
          position: cameraPosition,
          target: cameraTarget,
          zoom: Number.isFinite(camera.zoom) && camera.zoom > 0 ? camera.zoom : 1,
        },
        ...(partId ? { partId } : {}),
      };

      startAnnotationDraft(anchor);
    };

    captureHitRef.current = capture;
    return () => {
      captureHitRef.current = null;
    };
  }, [camera, controls, captureHitRef, startAnnotationDraft]);

  return null;
}

interface AnnotationDraftFormProps {
  fileId: string;
  versionId?: string;
}

/**
 * Floating top-center card over the 3D viewport for labeling & persisting
 * a newly placed annotation draft.
 */
export function AnnotationDraftForm({ fileId, versionId }: AnnotationDraftFormProps) {
  const annotationDraft = useViewerStore((s) => s.annotationDraft);
  const setAnnotationDraftLabel = useViewerStore((s) => s.setAnnotationDraftLabel);
  const cancelAnnotationDraft = useViewerStore((s) => s.cancelAnnotationDraft);
  const setAnnotationMode = useViewerStore((s) => s.setAnnotationMode);
  const addAnnotationLocal = useViewerStore((s) => s.addAnnotationLocal);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);

  const createAnnotation = useCreateAnnotation(fileId);
  const inputRef = React.useRef<HTMLInputElement | null>(null);

  React.useEffect(() => {
    if (annotationDraft) {
      inputRef.current?.focus();
    }
  }, [annotationDraft]);

  if (!annotationDraft) return null;

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!versionId) return;

    const requestBody: CreateAnnotationRequest = {
      versionId,
      type: AnnotationType.PIN,
      label: annotationDraft.label.trim() || 'Untitled annotation',
      payload: {
        anchor: annotationDraft.anchor,
      },
    };

    try {
      const saved = await createAnnotation.mutateAsync(requestBody);
      addAnnotationLocal(saved);
      cancelAnnotationDraft();
      setAnnotationMode(false);
      selectAnnotation(saved.id);
    } catch {
      // Error toast is handled by useCreateAnnotation
    }
  };

  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 w-full max-w-md -translate-x-1/2 px-3">
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2.5 rounded-lg border border-primary/60 bg-[#121721] p-3 shadow-2xl"
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <MapPin className="h-3.5 w-3.5 text-amber-400" />
            <span>New 3D Annotation Pin</span>
          </div>
          <button
            type="button"
            onClick={cancelAnnotationDraft}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
            aria-label="Cancel annotation draft"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        <Input
          ref={inputRef}
          value={annotationDraft.label}
          onChange={(e) => setAnnotationDraftLabel(e.target.value)}
          placeholder="Label this callout (e.g. Check flange clearance)..."
          maxLength={240}
          className="h-8 bg-background text-xs"
        />

        <div className="flex items-center justify-between gap-2">
          <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
            XYZ: {annotationDraft.anchor.position.map((n) => n.toFixed(1)).join(', ')} mm
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={cancelAnnotationDraft}
              disabled={createAnnotation.isPending}
              className="h-7 px-2.5 text-xs"
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="sm"
              disabled={!versionId || createAnnotation.isPending}
              className="h-7 px-3 text-xs"
            >
              {createAnnotation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </div>
      </form>
    </div>
  );
}
