import * as React from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowLeft,
  MessageSquare,
  PanelLeft,
  PanelRight,
  Ruler,
  Share2,
  Sparkles,
} from 'lucide-react';
import {
  computeAvatarColor,
  type DesignFile,
  type SharePermission,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { useRealtimeSync } from '@/hooks/useRealtimeSync';
import { usePresenceStore } from '@/stores/presenceStore';
import { useAiStore } from '@/stores/aiStore';
import { useMeasureStore } from '@/stores/measureStore';
import { PartTree } from '@/components/viewer/PartTree';
import { ViewerLoader } from '@/components/viewer/ViewerLoader';
import { LayerTree } from '@/components/viewer2d/LayerTree';
import { Viewer2D, type Viewer2DSceneMeta } from '@/components/viewer2d/Viewer2D';
import { CommentsPanel } from '@/components/right-panel/CommentsPanel';
import { MeasurementsPanel } from '@/components/right-panel/MeasurementsPanel';
import { AIPanel } from '@/components/right-panel/AIPanel';
import { FollowingBanner, PresenceBar } from '@/components/realtime/PresenceBar';
import { ActivityFeed } from '@/components/realtime/ActivityFeed';
import { ShareDialog } from '@/components/ShareDialog';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

const TWO_D_EXTENSIONS = new Set(['dxf', 'pdf', 'dwg']);

function is2DFileExtension(ext: string | undefined): boolean {
  if (!ext) return false;
  return TWO_D_EXTENSIONS.has(ext.toLowerCase().replace(/^\./, ''));
}

interface FileViewerPageProps {
  sharedFile?: DesignFile;
  sharedPermission?: SharePermission;
  shareToken?: string;
}

type RightSidebarTab = 'comments' | 'measurements' | 'activity' | 'ai';

export function FileViewerPage({
  sharedFile,
  sharedPermission,
  shareToken,
}: FileViewerPageProps = {}) {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const [rightTab, setRightTab] = React.useState<RightSidebarTab>('comments');
  const [leftOpen, setLeftOpen] = React.useState(true);
  const [rightOpen, setRightOpen] = React.useState(true);
  const [shareOpen, setShareOpen] = React.useState(false);
  const [scene2DMeta, setScene2DMeta] = React.useState<Viewer2DSceneMeta>({
    mode: null,
  });

  const requestedAiTabSeq = useAiStore((s) => s.requestedTabSeq);
  React.useEffect(() => {
    if (requestedAiTabSeq > 0) {
      setRightOpen(true);
      setRightTab('ai');
    }
  }, [requestedAiTabSeq]);

  const requestedMeasureTabSeq = useMeasureStore((s) => s.requestedPanelSeq);
  React.useEffect(() => {
    if (requestedMeasureTabSeq > 0) {
      setRightOpen(true);
      setRightTab('measurements');
    }
  }, [requestedMeasureTabSeq]);

  const fileId = sharedFile?.id ?? id;

  const fileQuery = useQuery({
    queryKey: ['file', fileId, shareToken ?? 'auth'],
    queryFn: () =>
      apiFetch<DesignFile>(`/files/${fileId}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      }),
    enabled: Boolean(fileId) && !sharedFile,
  });

  const file = sharedFile ?? fileQuery.data;

  const versionParamRaw = searchParams.get('v');
  const parsedVersion = versionParamRaw ? Number(versionParamRaw) : undefined;
  const selectedVersion =
    parsedVersion && Number.isInteger(parsedVersion) && parsedVersion > 0
      ? parsedVersion
      : file?.currentVersion;

  const handleVersionChange = (nextVersion: number) => {
    const next = new URLSearchParams(searchParams);
    next.set('v', String(nextVersion));
    setSearchParams(next, { replace: true });
  };

  const pageParamRaw = searchParams.get('page');
  const parsedPage = pageParamRaw ? Number(pageParamRaw) : 1;
  const activePage =
    Number.isInteger(parsedPage) && parsedPage >= 1 ? parsedPage : 1;

  const handlePageChange = React.useCallback(
    (nextPage: number) => {
      const next = new URLSearchParams(searchParams);
      next.set('page', String(nextPage));
      setSearchParams(next, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const activeFollowUserId = usePresenceStore((s) => s.activeUserId);
  const presenceUsers = usePresenceStore((s) => s.users);
  const followedLeader = activeFollowUserId
    ? presenceUsers.find((u) => u.userId === activeFollowUserId)
    : undefined;
  const followGlowColor = activeFollowUserId
    ? followedLeader?.avatarColor || computeAvatarColor(activeFollowUserId)
    : null;

  const versions = file?.versions ?? [];
  const activeVersionRecord =
    versions.find((v) => v.versionNumber === selectedVersion) ?? versions[0];
  const activeVersionId = activeVersionRecord?.id;

  // Single real-time collaboration hook mounted once per FileViewer
  useRealtimeSync({
    fileId: file?.id,
    versionId: activeVersionId,
    shareToken,
    onFollowPageChange: handlePageChange,
  });

  if (!sharedFile && fileQuery.isLoading) {
    return (
      <div className="flex flex-1 items-center justify-center gap-3 bg-background text-xs text-muted-foreground">
        <Spinner />
        <span>Loading design file...</span>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 bg-background p-6 text-center">
        <p className="text-sm font-medium text-red-300">
          {fileQuery.error instanceof Error
            ? fileQuery.error.message
            : 'Design file not found'}
        </p>
        <Link to="/projects">
          <Button variant="outline" size="sm">
            <ArrowLeft className="h-3.5 w-3.5" />
            Back to Projects
          </Button>
        </Link>
      </div>
    );
  }

  const is2D = is2DFileExtension(file.extension);

  return (
    <div
      className={cn(
        'flex flex-col bg-background text-foreground overflow-hidden',
        sharedFile ? 'h-screen' : 'h-[calc(100vh-3.5rem)]'
      )}
    >
      {/* Top viewer bar */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-3 border-b border-border bg-card px-3">
        <div className="flex min-w-0 items-center gap-2.5">
          {!sharedFile ? (
            <Link
              to={`/projects/${file.projectId}`}
              className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md border border-border bg-background text-muted-foreground hover:text-foreground transition-colors"
              title="Back to project"
              aria-label="Back to project"
            >
              <ArrowLeft className="h-4 w-4" />
            </Link>
          ) : (
            <span className="rounded border border-primary/40 bg-primary/15 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
              Shared · {sharedPermission}
            </span>
          )}

          <button
            type="button"
            onClick={() => setLeftOpen((prev) => !prev)}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer',
              leftOpen
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            )}
            title="Toggle model tree"
            aria-label="Toggle model tree"
          >
            <PanelLeft className="h-4 w-4" />
          </button>

          <div className="min-w-0">
            <p className="truncate text-sm font-semibold leading-tight text-foreground">
              {file.name}
            </p>
            <p className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {file.extension.toUpperCase()} · {formatBytes(file.sizeBytes)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2.5">
          {/* Active room collaborators & Follow-view controls */}
          <PresenceBar />

          {/* Version selector synced with ?v=<versionNumber> */}
          <select
            aria-label="Select file version"
            value={selectedVersion ?? file.currentVersion}
            onChange={(e) => handleVersionChange(Number(e.target.value))}
            className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {versions.length > 0 ? (
              versions.map((ver) => (
                <option key={ver.id} value={ver.versionNumber}>
                  v{ver.versionNumber} ({ver.status})
                </option>
              ))
            ) : (
              <option value={file.currentVersion}>v{file.currentVersion}</option>
            )}
          </select>

          {!sharedFile && (
            <Button size="sm" onClick={() => setShareOpen(true)}>
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          )}

          <button
            type="button"
            onClick={() => setRightOpen((prev) => !prev)}
            className={cn(
              'flex h-8 w-8 shrink-0 items-center justify-center rounded-md border transition-colors cursor-pointer',
              rightOpen
                ? 'border-primary/40 bg-primary/10 text-primary'
                : 'border-border bg-background text-muted-foreground hover:text-foreground'
            )}
            title="Toggle review panel"
            aria-label="Toggle review panel"
          >
            <PanelRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Main 3-pane workspace */}
      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Left sidebar: LayerTree for 2D or PartTree for 3D (260px) */}
        {leftOpen && (
          <aside className="w-[260px] shrink-0 border-r border-border bg-card overflow-hidden">
            {is2D ? (
              <LayerTree
                mode={scene2DMeta.mode}
                pageCount={scene2DMeta.pageCount}
                activePage={activePage}
                onSelectPage={handlePageChange}
              />
            ) : (
              <PartTree fallbackName={file.name} />
            )}
          </aside>
        )}

        {/* Center viewport: 2D Konva stage or 3D Three.js stage */}
        <section
          className="relative min-w-0 flex-1 bg-[#0d1117]"
          style={
            followGlowColor
              ? {
                  boxShadow: `inset 0 0 0 2px ${followGlowColor}, inset 0 0 24px ${followGlowColor}33`,
                }
              : undefined
          }
        >
          <FollowingBanner />
          {is2D ? (
            <Viewer2D
              fileId={file.id}
              projectId={file.projectId}
              fileName={file.name}
              versionNumber={selectedVersion}
              versionId={activeVersionId}
              shareToken={shareToken}
              activePage={activePage}
              onActivePageChange={handlePageChange}
              onSceneMetaChange={setScene2DMeta}
            />
          ) : (
            <ViewerLoader
              fileId={file.id}
              fileName={file.name}
              versionNumber={selectedVersion}
              versionId={activeVersionId}
              shareToken={shareToken}
            />
          )}
        </section>

        {/* Right sidebar: Comments | Measure | Activity | AI (320px) */}
        {rightOpen && (
          <aside className="flex w-[320px] shrink-0 flex-col border-l border-border bg-card min-h-0">
            <div className="grid shrink-0 grid-cols-4 border-b border-border">
              <button
                type="button"
                onClick={() => setRightTab('comments')}
                className={cn(
                  'flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium border-b-2 transition-colors cursor-pointer',
                  rightTab === 'comments'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <MessageSquare className="h-3.5 w-3.5" />
                Notes
              </button>
              <button
                type="button"
                onClick={() => setRightTab('measurements')}
                className={cn(
                  'flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium border-b-2 transition-colors cursor-pointer',
                  rightTab === 'measurements'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Ruler className="h-3.5 w-3.5" />
                Measure
              </button>
              <button
                type="button"
                onClick={() => setRightTab('activity')}
                className={cn(
                  'flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium border-b-2 transition-colors cursor-pointer',
                  rightTab === 'activity'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Activity className="h-3.5 w-3.5" />
                Feed
              </button>
              <button
                type="button"
                onClick={() => setRightTab('ai')}
                className={cn(
                  'flex items-center justify-center gap-1 py-2.5 text-[11px] font-medium border-b-2 transition-colors cursor-pointer',
                  rightTab === 'ai'
                    ? 'border-primary text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}
              >
                <Sparkles className="h-3.5 w-3.5" />
                AI
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-hidden">
              {rightTab === 'comments' && (
                <CommentsPanel
                  fileId={file.id}
                  versionId={activeVersionId}
                  shareToken={shareToken}
                />
              )}

              {rightTab === 'measurements' && (
                <MeasurementsPanel
                  fileId={file.id}
                  versionId={activeVersionId}
                  shareToken={shareToken}
                />
              )}

              {rightTab === 'activity' && (
                <ActivityFeed projectId={file.projectId} compact />
              )}

              {rightTab === 'ai' && (
                <AIPanel
                  fileId={file.id}
                  versionId={activeVersionId}
                  is2D={is2D}
                  shareToken={shareToken}
                />
              )}
            </div>
          </aside>
        )}
      </div>

      {!sharedFile && (
        <ShareDialog
          open={shareOpen}
          onOpenChange={setShareOpen}
          fileId={file.id}
          resourceName={file.name}
        />
      )}
    </div>
  );
}
