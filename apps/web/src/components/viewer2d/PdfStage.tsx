import * as React from 'react';
import {
  Group,
  Image as KonvaImage,
  Layer,
  Rect,
  Stage,
  Text,
} from 'react-konva';
import type Konva from 'konva';
import {
  isAnnotationAnchor2D,
  normalizeAnnotationAnchor,
  type Annotation,
  type File2DPageResponse,
  type Measurement,
  type PdfPageManifest,
  type Point2D,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import {
  useViewer2DStore,
  type ShapeDraft,
} from '@/stores/viewer2dStore';
import { MarkupOverlayLayer } from '@/components/viewer2d/MarkupOverlayLayer';
import { RemoteCursors2DLayer } from '@/components/viewer2d/RemoteCursors2DLayer';
import { usePresenceStore } from '@/stores/presenceStore';
import { useCursorStore } from '@/stores/cursorStore';
import {
  emitRealtimeCursorMove,
  emitRealtimeViewportSync,
} from '@/hooks/useRealtimeSync';

interface PdfStageProps {
  fileId: string;
  fileName?: string;
  versionNumber?: number;
  shareToken?: string;
  pageManifest: PdfPageManifest;
  activePage: number;
  onActivePageChange?: (page: number) => void;
  annotations: Annotation[];
  measurements: Measurement[];
  selectedAnnotationId: string | null;
  onSelectAnnotation: (id: string | null) => void;
  onRequestPinOrText: (input: {
    tool: 'pin' | 'text';
    point: Point2D;
    page: number;
    screenPos: Point2D;
  }) => void;
}

const PAGE_GAP = 20;
const MIN_ZOOM_FACTOR = 0.1;
const MAX_ZOOM_FACTOR = 20;

interface PageLayout {
  page: number;
  y: number;
  width: number;
  height: number;
}

export function PdfStage({
  fileId,
  fileName,
  versionNumber,
  shareToken,
  pageManifest,
  activePage,
  onActivePageChange,
  annotations,
  measurements,
  selectedAnnotationId,
  onSelectAnnotation,
  onRequestPinOrText,
}: PdfStageProps) {
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const stageRef = React.useRef<Konva.Stage | null>(null);
  const [size, setSize] = React.useState<{ width: number; height: number }>({
    width: 800,
    height: 600,
  });

  const [pageImages, setPageImages] = React.useState<Map<number, HTMLImageElement>>(
    () => new Map()
  );
  const [loadingPages, setLoadingPages] = React.useState(true);
  const [pageError, setPageError] = React.useState<string | null>(null);

  const [scale, setScale] = React.useState(1);
  const [position, setPosition] = React.useState<Point2D>({ x: 0, y: 0 });
  const fitScaleRef = React.useRef(1);
  const initializedRef = React.useRef(false);
  const lastFocusedPagePropRef = React.useRef<number>(activePage);

  const [spacePressed, setSpacePressed] = React.useState(false);
  const isPanningRef = React.useRef(false);
  const panStartRef = React.useRef<{ pointer: Point2D; pos: Point2D } | null>(null);
  const isDrawingRef = React.useRef(false);
  const lastTouchDistRef = React.useRef<number | null>(null);
  const lastTouchCenterRef = React.useRef<Point2D | null>(null);
  const animFrameRef = React.useRef<number | null>(null);

  const tool = useViewer2DStore((s) => s.tool);
  const draftShape = useViewer2DStore((s) => s.draftShape);
  const beginShape = useViewer2DStore((s) => s.beginShape);
  const updateShape = useViewer2DStore((s) => s.updateShape);
  const commitShape = useViewer2DStore((s) => s.commitShape);
  const cancelShape = useViewer2DStore((s) => s.cancelShape);
  const setViewportTransform = useViewer2DStore((s) => s.setViewportTransform);
  const registerStageHandlers = useViewer2DStore((s) => s.registerStageHandlers);
  const activeFollowUserId = usePresenceStore((s) => s.activeUserId);
  const remoteViewportPose = useCursorStore((s) => s.remoteViewportPose);
  const scaleRef = React.useRef(scale);
  const positionRef = React.useRef(position);
  scaleRef.current = scale;
  positionRef.current = position;

  // Broadcast 2D PDF viewport pan/zoom/page at <= 15 Hz when not following
  React.useEffect(() => {
    if (!initializedRef.current || activeFollowUserId !== null) return;
    emitRealtimeViewportSync({
      scale,
      offsetX: position.x,
      offsetY: position.y,
      page: activePage,
    });
  }, [activeFollowUserId, activePage, position.x, position.y, scale]);

  // Smoothly lerp (0.15 per frame) to followed user's PDF viewport
  React.useEffect(() => {
    if (activeFollowUserId === null || !remoteViewportPose) return;
    let rafId = 0;
    const targetScale = remoteViewportPose.scale;
    const targetX = remoteViewportPose.offsetX;
    const targetY = remoteViewportPose.offsetY;

    const step = () => {
      if (usePresenceStore.getState().activeUserId === null) return;
      const curScale = scaleRef.current;
      const curPos = positionRef.current;
      const nextScale = curScale + (targetScale - curScale) * 0.15;
      const nextX = curPos.x + (targetX - curPos.x) * 0.15;
      const nextY = curPos.y + (targetY - curPos.y) * 0.15;

      scaleRef.current = nextScale;
      positionRef.current = { x: nextX, y: nextY };
      setScale(nextScale);
      setPosition({ x: nextX, y: nextY });
      setViewportTransform(nextScale, nextX, nextY);

      const done =
        Math.abs(targetScale - nextScale) < 0.0005 &&
        Math.abs(targetX - nextX) < 0.25 &&
        Math.abs(targetY - nextY) < 0.25;
      if (!done) {
        rafId = requestAnimationFrame(step);
      }
    };

    rafId = requestAnimationFrame(step);
    return () => cancelAnimationFrame(rafId);
  }, [activeFollowUserId, remoteViewportPose, setViewportTransform]);

  // Measure container
  React.useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const update = () => {
      const rect = el.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setSize({ width: rect.width, height: rect.height });
      }
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Fetch presigned/API page URLs and load PNG images
  React.useEffect(() => {
    let cancelled = false;
    setLoadingPages(true);
    setPageError(null);

    const loadAllPages = async () => {
      try {
        const count = Math.max(pageManifest.pageCount, 1);
        const qs = versionNumber ? `?v=${versionNumber}` : '';
        const loaded = new Map<number, HTMLImageElement>();

        await Promise.all(
          Array.from({ length: count }, (_, idx) => idx + 1).map(async (pageNum) => {
            const resp = await apiFetch<File2DPageResponse>(
              `/files/${fileId}/2d/page/${pageNum}${qs}`,
              {
                shareToken,
                skipAuth: Boolean(shareToken),
              }
            );
            const img = await new Promise<HTMLImageElement>((resolve, reject) => {
              const image = new window.Image();
              image.crossOrigin = 'anonymous';
              image.onload = () => resolve(image);
              image.onerror = () =>
                reject(new Error(`Failed to load PDF sheet ${pageNum}`));
              image.src = resp.url;
            });
            loaded.set(pageNum, img);
          })
        );

        if (!cancelled) {
          setPageImages(loaded);
          setLoadingPages(false);
        }
      } catch (err) {
        if (!cancelled) {
          setPageError(
            err instanceof Error ? err.message : 'Failed to load PDF sheets'
          );
          setLoadingPages(false);
        }
      }
    };

    void loadAllPages();
    return () => {
      cancelled = true;
    };
  }, [fileId, pageManifest.pageCount, shareToken, versionNumber]);

  // Compute vertical page stack layout with 20px gaps
  const { pageLayouts, pageYOffsets, maxPageWidth } = React.useMemo(() => {
    const layouts: PageLayout[] = [];
    const offsets = new Map<number, number>();
    let cursorY = 0;
    let maxW = pageManifest.pageSize.width || 1200;

    for (let p = 1; p <= Math.max(pageManifest.pageCount, 1); p += 1) {
      const img = pageImages.get(p);
      const w = img?.naturalWidth || pageManifest.pageSize.width || 1200;
      const h = img?.naturalHeight || pageManifest.pageSize.height || 850;
      if (w > maxW) maxW = w;
      layouts.push({ page: p, y: cursorY, width: w, height: h });
      offsets.set(p, cursorY);
      cursorY += h + PAGE_GAP;
    }

    return { pageLayouts: layouts, pageYOffsets: offsets, maxPageWidth: maxW };
  }, [pageImages, pageManifest.pageCount, pageManifest.pageSize.height, pageManifest.pageSize.width]);

  const animateToView = React.useCallback(
    (targetScale: number, targetPos: Point2D) => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
      const startScale = scale;
      const startPos = { ...position };
      const startTime = performance.now();
      const duration = 260;

      const step = (now: number) => {
        const t = Math.min((now - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - t, 3);
        const curScale = startScale + (targetScale - startScale) * eased;
        const curX = startPos.x + (targetPos.x - startPos.x) * eased;
        const curY = startPos.y + (targetPos.y - startPos.y) * eased;
        setScale(curScale);
        setPosition({ x: curX, y: curY });
        setViewportTransform(curScale, curX, curY);
        if (t < 1) {
          animFrameRef.current = requestAnimationFrame(step);
        } else {
          animFrameRef.current = null;
        }
      };

      animFrameRef.current = requestAnimationFrame(step);
    },
    [position, scale, setViewportTransform]
  );

  React.useEffect(() => {
    return () => {
      if (animFrameRef.current !== null) {
        cancelAnimationFrame(animFrameRef.current);
      }
    };
  }, []);

  const fitPage = React.useCallback(
    (pageNumber: number, animate = false) => {
      if (size.width <= 0 || size.height <= 0 || pageLayouts.length === 0) return;
      const target =
        pageLayouts.find((pl) => pl.page === pageNumber) ?? pageLayouts[0];
      const pad = 40;
      const availW = Math.max(size.width - pad * 2, 100);
      const availH = Math.max(size.height - pad * 2, 100);
      const nextScale = Math.min(availW / target.width, availH / target.height);
      fitScaleRef.current = nextScale;

      const nextPos = {
        x: size.width / 2 - (target.width / 2) * nextScale,
        y: size.height / 2 - (target.y + target.height / 2) * nextScale,
      };

      if (animate) {
        animateToView(nextScale, nextPos);
      } else {
        setScale(nextScale);
        setPosition(nextPos);
        setViewportTransform(nextScale, nextPos.x, nextPos.y);
      }
    },
    [animateToView, pageLayouts, setViewportTransform, size.height, size.width]
  );

  // Initial fit on activePage once images/dimensions settle
  React.useEffect(() => {
    if (!initializedRef.current && size.width > 0 && size.height > 0 && !loadingPages) {
      initializedRef.current = true;
      fitPage(activePage, false);
    }
  }, [activePage, fitPage, loadingPages, size.height, size.width]);

  // Respond when user selects a different sheet in LayerTree
  React.useEffect(() => {
    if (!initializedRef.current) return;
    if (lastFocusedPagePropRef.current !== activePage) {
      lastFocusedPagePropRef.current = activePage;
      fitPage(activePage, true);
    }
  }, [activePage, fitPage]);

  // Keyboard shortcuts
  React.useEffect(() => {
    const isEditable = (target: EventTarget | null) =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable);

    const onKeyDown = (e: KeyboardEvent) => {
      if (isEditable(e.target)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        setSpacePressed(true);
      } else if (e.key === 'Escape') {
        cancelShape();
      } else if (e.key === 'Enter') {
        const current = useViewer2DStore.getState().draftShape;
        if (current && current.tool === 'area' && current.points.length >= 3) {
          void commitShape();
        }
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpacePressed(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [cancelShape, commitShape]);

  // Register imperative toolbar & CommentsPanel handlers
  React.useEffect(() => {
    const zoomStep = (factor: number) => {
      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const nextScale = Math.max(minScale, Math.min(maxScale, scale * factor));
      const cx = size.width / 2;
      const cy = size.height / 2;
      const stageX = (cx - position.x) / scale;
      const stageY = (cy - position.y) / scale;
      const nextPos = {
        x: cx - stageX * nextScale,
        y: cy - stageY * nextScale,
      };
      setScale(nextScale);
      setPosition(nextPos);
      setViewportTransform(nextScale, nextPos.x, nextPos.y);
    };

    const screenshot = () => {
      const stage = stageRef.current;
      if (!stage) return;
      const dataUrl = stage.toDataURL({ pixelRatio: 2, mimeType: 'image/png' });
      const link = document.createElement('a');
      link.download = `${(fileName ?? 'sheet').replace(/\.[^.]+$/, '')}-pdf.png`;
      link.href = dataUrl;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
    };

    const focusAnnotation = (annotationId: string) => {
      const match = annotations.find((a) => a.id === annotationId);
      if (!match) return;
      const anchor = normalizeAnnotationAnchor(match.payload?.anchor);
      if (!isAnnotationAnchor2D(anchor)) return;

      const pageNum = anchor.page ?? 1;
      const pageOffset = pageYOffsets.get(pageNum) ?? 0;
      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const preferredScale = Math.max(
        scale,
        Math.min(maxScale, Math.max(minScale, fitScaleRef.current * 1.8))
      );
      const targetPos = {
        x: size.width / 2 - anchor.x * preferredScale,
        y: size.height / 2 - (pageOffset + anchor.y) * preferredScale,
      };
      onActivePageChange?.(pageNum);
      animateToView(preferredScale, targetPos);
    };

    registerStageHandlers({
      fit: () => fitPage(activePage, true),
      zoomStep,
      screenshot,
      focusAnnotation,
    });
  }, [
    activePage,
    animateToView,
    annotations,
    fileName,
    fitPage,
    onActivePageChange,
    pageYOffsets,
    position.x,
    position.y,
    registerStageHandlers,
    scale,
    setViewportTransform,
    size.height,
    size.width,
  ]);

  const pointerToPagePoint = React.useCallback(
    (pointer: Point2D, lockedPage?: number): { page: number; point: Point2D } => {
      const safeScale = Math.max(scale, 0.0001);
      const stageX = (pointer.x - position.x) / safeScale;
      const stageY = (pointer.y - position.y) / safeScale;

      if (lockedPage !== undefined) {
        const offset = pageYOffsets.get(lockedPage) ?? 0;
        return {
          page: lockedPage,
          point: { x: stageX, y: stageY - offset },
        };
      }

      for (const layout of pageLayouts) {
        if (stageY >= layout.y && stageY <= layout.y + layout.height + PAGE_GAP / 2) {
          return {
            page: layout.page,
            point: { x: stageX, y: stageY - layout.y },
          };
        }
      }

      const fallback = pageLayouts[0] ?? { page: 1, y: 0 };
      return {
        page: fallback.page,
        point: { x: stageX, y: stageY - fallback.y },
      };
    },
    [pageLayouts, pageYOffsets, position.x, position.y, scale]
  );

  const handleWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const zoomBy = 1.12;
    const direction = e.evt.deltaY > 0 ? -1 : 1;
    const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
    const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
    const nextScale = Math.max(
      minScale,
      Math.min(maxScale, direction > 0 ? scale * zoomBy : scale / zoomBy)
    );

    const mousePointTo = {
      x: (pointer.x - position.x) / scale,
      y: (pointer.y - position.y) / scale,
    };
    const nextPos = {
      x: pointer.x - mousePointTo.x * nextScale,
      y: pointer.y - mousePointTo.y * nextScale,
    };
    setScale(nextScale);
    setPosition(nextPos);
    setViewportTransform(nextScale, nextPos.x, nextPos.y);
  };

  const handleMouseDown = (e: Konva.KonvaEventObject<MouseEvent>) => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const isMiddleClick = e.evt.button === 1;
    if (tool === 'pan' || spacePressed || isMiddleClick) {
      e.evt.preventDefault();
      isPanningRef.current = true;
      panStartRef.current = { pointer, pos: { ...position } };
      return;
    }

    if (e.evt.button !== 0) return;

    if (tool === 'select') {
      if (e.target === stage) {
        onSelectAnnotation(null);
      }
      return;
    }

    const lockedPage = draftShape?.page;
    const { page, point } = pointerToPagePoint(pointer, lockedPage);
    onActivePageChange?.(page);

    if (tool === 'pin' || tool === 'text') {
      onRequestPinOrText({
        tool,
        page,
        point,
        screenPos: { x: pointer.x, y: pointer.y },
      });
      return;
    }

    if (tool === 'distance') {
      if (!draftShape || draftShape.tool !== 'distance') {
        beginShape({
          tool: 'distance',
          sheet: 'pdf',
          page,
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], point],
          currentPoint: undefined,
        });
        void commitShape();
      }
      return;
    }

    if (tool === 'angle') {
      if (!draftShape || draftShape.tool !== 'angle') {
        beginShape({
          tool: 'angle',
          sheet: 'pdf',
          page,
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else if (draftShape.points.length === 1) {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], point],
          currentPoint: point,
        });
      } else {
        updateShape({
          ...draftShape,
          points: [draftShape.points[0], draftShape.points[1], point],
          currentPoint: undefined,
        });
        void commitShape();
      }
      return;
    }

    if (tool === 'area') {
      if (!draftShape || draftShape.tool !== 'area') {
        beginShape({
          tool: 'area',
          sheet: 'pdf',
          page,
          points: [point],
          currentPoint: point,
          color: '#f59e0b',
        });
      } else {
        const first = draftShape.points[0];
        const distPx = Math.hypot(point.x - first.x, point.y - first.y) * scale;
        if (draftShape.points.length >= 3 && distPx <= 12) {
          updateShape({ ...draftShape, currentPoint: undefined });
          void commitShape();
        } else {
          updateShape({
            ...draftShape,
            points: [...draftShape.points, point],
            currentPoint: point,
          });
        }
      }
      return;
    }

    isDrawingRef.current = true;
    const colorByTool: Record<'arrow' | 'rect' | 'ellipse' | 'cloud' | 'freehand', string> = {
      arrow: '#38bdf8',
      rect: '#0b5fff',
      ellipse: '#a855f7',
      cloud: '#f43f5e',
      freehand: '#22c55e',
    };

    const nextDraft: ShapeDraft = {
      tool,
      sheet: 'pdf',
      page,
      points: [point],
      currentPoint: point,
      color: colorByTool[tool],
    };
    beginShape(nextDraft);
  };

  const handleMouseMove = () => {
    const stage = stageRef.current;
    if (!stage) return;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    if (isPanningRef.current && panStartRef.current) {
      const dx = pointer.x - panStartRef.current.pointer.x;
      const dy = pointer.y - panStartRef.current.pointer.y;
      const nextPos = {
        x: panStartRef.current.pos.x + dx,
        y: panStartRef.current.pos.y + dy,
      };
      setPosition(nextPos);
      setViewportTransform(scale, nextPos.x, nextPos.y);
      return;
    }

    const hoverHit = pointerToPagePoint(pointer);
    emitRealtimeCursorMove({
      x: hoverHit.point.x,
      y: hoverHit.point.y,
      sheet: 'pdf',
      page: hoverHit.page,
    });

    const activeDraft = useViewer2DStore.getState().draftShape;
    if (!activeDraft) return;
    const { point } = pointerToPagePoint(pointer, activeDraft.page);

    if (
      activeDraft.tool === 'distance' ||
      activeDraft.tool === 'angle' ||
      activeDraft.tool === 'area'
    ) {
      updateShape({ ...activeDraft, currentPoint: point });
      return;
    }

    if (!isDrawingRef.current) return;

    if (activeDraft.tool === 'freehand') {
      const prev = activeDraft.points[activeDraft.points.length - 1];
      if (!prev || Math.hypot(point.x - prev.x, point.y - prev.y) * scale >= 3) {
        updateShape({
          ...activeDraft,
          points: [...activeDraft.points, point],
          currentPoint: undefined,
        });
      }
    } else {
      updateShape({ ...activeDraft, currentPoint: point });
    }
  };

  const handleMouseUp = () => {
    if (isPanningRef.current) {
      isPanningRef.current = false;
      panStartRef.current = null;
      return;
    }

    if (!isDrawingRef.current) return;
    isDrawingRef.current = false;

    const activeDraft = useViewer2DStore.getState().draftShape;
    if (!activeDraft) return;

    if (activeDraft.tool === 'freehand') {
      if (activeDraft.points.length >= 2) {
        void commitShape();
      } else {
        cancelShape();
      }
      return;
    }

    const endPt = activeDraft.currentPoint;
    const startPt = activeDraft.points[0];
    if (
      startPt &&
      endPt &&
      Math.hypot(endPt.x - startPt.x, endPt.y - startPt.y) * scale >= 4
    ) {
      updateShape({
        ...activeDraft,
        points: [startPt, endPt],
        currentPoint: undefined,
      });
      void commitShape();
    } else {
      cancelShape();
    }
  };

  const handleDblClick = () => {
    const activeDraft = useViewer2DStore.getState().draftShape;
    if (activeDraft && activeDraft.tool === 'area' && activeDraft.points.length >= 3) {
      updateShape({ ...activeDraft, currentPoint: undefined });
      void commitShape();
    }
  };

  const handleTouchMove = (e: Konva.KonvaEventObject<TouchEvent>) => {
    const touches = e.evt.touches;
    if (touches.length !== 2) return;
    e.evt.preventDefault();

    const t1 = touches[0];
    const t2 = touches[1];
    const center = {
      x: (t1.clientX + t2.clientX) / 2,
      y: (t1.clientY + t2.clientY) / 2,
    };
    const dist = Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);

    if (lastTouchDistRef.current !== null && lastTouchCenterRef.current !== null) {
      const rect = containerRef.current?.getBoundingClientRect();
      const relCenter = {
        x: center.x - (rect?.left ?? 0),
        y: center.y - (rect?.top ?? 0),
      };
      const factor = dist / Math.max(lastTouchDistRef.current, 1);
      const minScale = fitScaleRef.current * MIN_ZOOM_FACTOR;
      const maxScale = fitScaleRef.current * MAX_ZOOM_FACTOR;
      const nextScale = Math.max(minScale, Math.min(maxScale, scale * factor));
      const dx = center.x - lastTouchCenterRef.current.x;
      const dy = center.y - lastTouchCenterRef.current.y;

      const worldPt = {
        x: (relCenter.x - position.x) / scale,
        y: (relCenter.y - position.y) / scale,
      };
      const nextPos = {
        x: relCenter.x - worldPt.x * nextScale + dx,
        y: relCenter.y - worldPt.y * nextScale + dy,
      };
      setScale(nextScale);
      setPosition(nextPos);
      setViewportTransform(nextScale, nextPos.x, nextPos.y);
    }

    lastTouchDistRef.current = dist;
    lastTouchCenterRef.current = center;
  };

  const handleTouchEnd = () => {
    lastTouchDistRef.current = null;
    lastTouchCenterRef.current = null;
  };

  const invScale = 1 / Math.max(scale, 0.0001);
  const cursorClass =
    tool === 'pan' || spacePressed
      ? 'cursor-grab active:cursor-grabbing'
      : tool === 'select'
        ? 'cursor-default'
        : 'cursor-crosshair';

  return (
    <div
      ref={containerRef}
      className={`relative h-full w-full overflow-hidden bg-[#0d1117] select-none ${cursorClass}`}
    >
      {pageError ? (
        <div className="flex h-full items-center justify-center p-6 text-center text-xs text-red-300">
          {pageError}
        </div>
      ) : (
        <Stage
          ref={stageRef}
          width={size.width}
          height={size.height}
          scaleX={scale}
          scaleY={scale}
          x={position.x}
          y={position.y}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
          onMouseLeave={() => {
            isPanningRef.current = false;
          }}
          onDblClick={handleDblClick}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Rasterized PDF Sheet Stack */}
          <Layer listening={false}>
            {pageLayouts.map((layout) => {
              const img = pageImages.get(layout.page);
              const xOffset = (maxPageWidth - layout.width) / 2;
              return (
                <Group key={layout.page} x={xOffset} y={layout.y}>
                  <Rect
                    width={layout.width}
                    height={layout.height}
                    fill="#ffffff"
                    stroke="#334155"
                    strokeWidth={1.5 * invScale}
                    shadowColor="#000000"
                    shadowBlur={18}
                    shadowOpacity={0.45}
                  />
                  {img && (
                    <KonvaImage
                      image={img}
                      width={layout.width}
                      height={layout.height}
                    />
                  )}
                  <Text
                    x={0}
                    y={-18 * invScale}
                    text={`SHEET ${layout.page} / ${pageManifest.pageCount}`}
                    fontSize={10 * invScale}
                    fontFamily="JetBrains Mono, monospace"
                    fill="#94a3b8"
                  />
                </Group>
              );
            })}
          </Layer>

          {/* Shared 2D Markup & Measurements Overlay */}
          <MarkupOverlayLayer
            annotations={annotations}
            measurements={measurements}
            draftShape={draftShape}
            snapIndicator={null}
            selectedAnnotationId={selectedAnnotationId}
            onSelectAnnotation={(id) => onSelectAnnotation(id)}
            scale={scale}
            flipY={false}
            pageYOffsets={pageYOffsets}
            units="px"
          />

          {/* Remote Collaborator Cursors */}
          <RemoteCursors2DLayer
            sheet="pdf"
            scale={scale}
            flipY={false}
            pageYOffsets={pageYOffsets}
          />
        </Stage>
      )}

      {/* Top-left sheet badge */}
      <div className="pointer-events-none absolute top-3 left-3 z-10 flex items-center gap-2.5 rounded-md border border-border/80 bg-[#121721]/90 px-2.5 py-1 font-mono text-[10px] tabular-nums text-muted-foreground backdrop-blur-xs">
        <span className="text-foreground/90">PDF</span>
        <span>
          Sheet {activePage} / {pageManifest.pageCount}
        </span>
        {loadingPages && <span className="text-sky-400">Rendering sheets…</span>}
      </div>
    </div>
  );
}
