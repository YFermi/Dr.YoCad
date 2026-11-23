import * as React from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Circle,
  CornerDownRight,
  MapPin,
  MessageSquare,
  Ruler,
  Send,
  Trash2,
  X,
} from 'lucide-react';
import {
  UserRole,
  isAnnotationAnchor2D,
  normalizeAnnotationAnchor,
  type CommentWithReplies,
  type CreateCommentRequest,
} from '@cadline/shared';
import { useAuthStore } from '@/lib/auth';
import { useViewerStore } from '@/stores/viewerStore';
import { useViewer2DStore } from '@/stores/viewer2dStore';
import { usePresenceStore } from '@/stores/presenceStore';
import {
  useComments,
  useCreateComment,
  useDeleteComment,
  useUpdateComment,
} from '@/hooks/useAnnotations';
import { MeasurementsPanel } from '@/components/right-panel/MeasurementsPanel';
import { cn, formatRelativeTime, getInitials } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';

type FilterTab = 'all' | 'unresolved' | 'version';

const EMAIL_MENTION_REGEX = /(@[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})/g;

function renderBodyWithMentions(body: string): React.ReactNode {
  const parts = body.split(EMAIL_MENTION_REGEX);
  return parts.map((segment, index) => {
    if (segment.startsWith('@') && segment.includes('@', 1)) {
      return (
        <span
          key={`${segment}-${index}`}
          className="inline-flex items-center rounded border border-primary/40 bg-primary/15 px-1.5 py-0.2 font-mono text-[11px] font-medium text-sky-300"
        >
          {segment}
        </span>
      );
    }
    return <React.Fragment key={index}>{segment}</React.Fragment>;
  });
}

interface CommentsPanelProps {
  fileId: string;
  versionId?: string;
  shareToken?: string;
}

export function CommentsPanel({ fileId, versionId, shareToken }: CommentsPanelProps) {
  const user = useAuthStore((s) => s.user);
  const annotations = useViewerStore((s) => s.annotations);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const setCommentFilters = useViewerStore((s) => s.setCommentFilters);
  const persistedMeasurements = useViewerStore((s) => s.persistedMeasurements);
  const recentCommentIds = usePresenceStore((s) => s.recentCommentIds);

  const [filterTab, setFilterTab] = React.useState<FilterTab>('all');
  const [composerBody, setComposerBody] = React.useState('');
  const [replyingToId, setReplyingToId] = React.useState<string | null>(null);
  const [replyDraft, setReplyDraft] = React.useState('');
  const [measurementsOpen, setMeasurementsOpen] = React.useState(false);

  const threadRefs = React.useRef<Map<string, HTMLDivElement>>(new Map());

  const queryFilters = React.useMemo(
    () => ({
      ...(filterTab === 'unresolved' ? { resolved: false } : {}),
      ...(filterTab === 'version' && versionId ? { versionId } : {}),
    }),
    [filterTab, versionId]
  );

  React.useEffect(() => {
    setCommentFilters({
      onlyUnresolved: filterTab === 'unresolved',
      versionId: filterTab === 'version' ? versionId : undefined,
    });
  }, [filterTab, versionId, setCommentFilters]);

  const commentsQuery = useComments(fileId, queryFilters, shareToken);
  const createComment = useCreateComment(fileId);
  const updateComment = useUpdateComment(fileId);
  const deleteComment = useDeleteComment(fileId);

  const visibleAnnotations = React.useMemo(() => {
    const list = annotations ?? [];
    if (!versionId) return list;
    return list.filter((a) => a.versionId === versionId);
  }, [annotations, versionId]);

  const annotationIndexMap = React.useMemo(() => {
    const map = new Map<string, number>();
    visibleAnnotations.forEach((ann, idx) => {
      map.set(ann.id, idx + 1);
    });
    return map;
  }, [visibleAnnotations]);

  const handleFocusAnnotation = React.useCallback(
    (annotationId: string) => {
      selectAnnotation(annotationId);
      const match = visibleAnnotations.find((a) => a.id === annotationId);
      if (match) {
        const anchor = normalizeAnnotationAnchor(match.payload?.anchor);
        if (isAnnotationAnchor2D(anchor)) {
          useViewer2DStore.getState().focusAnnotation(annotationId);
        }
      }
    },
    [selectAnnotation, visibleAnnotations]
  );

  // Auto-scroll to the thread linked with a clicked 3D annotation pin
  React.useEffect(() => {
    if (!selectedAnnotationId) return;
    const match = (commentsQuery.data?.items ?? []).find(
      (c) => c.annotationId === selectedAnnotationId
    );
    if (!match) return;
    const node = threadRefs.current.get(match.id);
    if (node) {
      node.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [selectedAnnotationId, commentsQuery.data?.items]);

  const isAdmin =
    user?.role === UserRole.ADMIN || user?.role === UserRole.OWNER;

  const canModify = (ownerId: string) =>
    Boolean(user) && !shareToken && (user?.id === ownerId || isAdmin);

  const selectedPinNumber = selectedAnnotationId
    ? annotationIndexMap.get(selectedAnnotationId)
    : undefined;

  const handlePostComment = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = composerBody.trim();
    if (!trimmed) return;

    const body: CreateCommentRequest = {
      body: trimmed,
      ...(selectedAnnotationId ? { annotationId: selectedAnnotationId } : {}),
    };

    setComposerBody('');
    try {
      await createComment.mutateAsync(body);
    } catch {
      setComposerBody(trimmed);
    }
  };

  const handlePostReply = async (parent: CommentWithReplies, event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = replyDraft.trim();
    if (!trimmed) return;

    const body: CreateCommentRequest = {
      body: trimmed,
      parentId: parent.id,
      ...(parent.annotationId ? { annotationId: parent.annotationId } : {}),
    };

    setReplyDraft('');
    setReplyingToId(null);
    try {
      await createComment.mutateAsync(body);
    } catch {
      setReplyDraft(trimmed);
      setReplyingToId(parent.id);
    }
  };

  const items = commentsQuery.data?.items ?? [];
  const summary = commentsQuery.data?.summary;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Filter tabs */}
      <div className="flex shrink-0 items-center gap-1 border-b border-border px-2.5 py-2">
        {(
          [
            {
              key: 'all',
              label: `All${summary ? ` (${summary.totalTopLevel})` : ''}`,
            },
            {
              key: 'unresolved',
              label: `Unresolved${summary ? ` (${summary.unresolvedTopLevel})` : ''}`,
            },
            { key: 'version', label: 'This version' },
          ] as const
        ).map((tab) => (
          <button
            key={tab.key}
            type="button"
            onClick={() => setFilterTab(tab.key)}
            className={cn(
              'rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
              filterTab === tab.key
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {/* Scrollable threads + collapsible measurements */}
      <div className="min-h-0 flex-1 overflow-y-auto p-3 space-y-3">
        {commentsQuery.isLoading ? (
          <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
            <Spinner size="sm" />
            <span>Loading comments...</span>
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center rounded-md border border-dashed border-border px-4 py-8 text-center">
            <MessageSquare className="mb-2 h-5 w-5 text-muted-foreground" />
            <p className="text-xs text-muted-foreground">
              No comments yet. Click the annotation tool to add one.
            </p>
          </div>
        ) : (
          items.map((comment) => {
            const pinNum = comment.annotationId
              ? annotationIndexMap.get(comment.annotationId)
              : undefined;
            const isHighlighted =
              Boolean(selectedAnnotationId) &&
              comment.annotationId === selectedAnnotationId;
            const isFlashing = Boolean(recentCommentIds[comment.id]);
            const authorAllowed = canModify(comment.userId);

            return (
              <div
                key={comment.id}
                ref={(node) => {
                  if (node) {
                    threadRefs.current.set(comment.id, node);
                  } else {
                    threadRefs.current.delete(comment.id);
                  }
                }}
                onClick={() => {
                  if (comment.annotationId) {
                    handleFocusAnnotation(comment.annotationId);
                  }
                }}
                className={cn(
                  'rounded-md border p-2.5 text-xs transition-colors duration-200',
                  comment.annotationId ? 'cursor-pointer' : '',
                  isFlashing
                    ? 'border-sky-400 bg-primary/25'
                    : isHighlighted
                      ? 'border-primary bg-primary/10'
                      : 'border-border bg-background/60 hover:border-border/90'
                )}
              >
                {/* Thread header */}
                <div className="flex items-start justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-2">
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 font-mono text-[10px] font-semibold text-primary">
                      {getInitials(comment.author?.name, comment.author?.email)}
                    </div>
                    <div className="min-w-0">
                      <p className="truncate font-medium leading-tight text-foreground">
                        {comment.author?.name ?? 'Reviewer'}
                      </p>
                      <p className="text-[10px] text-muted-foreground">
                        {formatRelativeTime(comment.createdAt)}
                      </p>
                    </div>
                  </div>

                  <div
                    className="flex shrink-0 items-center gap-1"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {pinNum !== undefined && (
                      <button
                        type="button"
                        onClick={() =>
                          comment.annotationId &&
                          handleFocusAnnotation(comment.annotationId)
                        }
                        className="flex items-center gap-0.5 rounded bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-primary hover:bg-primary/25 cursor-pointer"
                        title={`Focus annotation #${pinNum}`}
                      >
                        <MapPin className="h-2.5 w-2.5" />#{pinNum}
                      </button>
                    )}

                    {authorAllowed && (
                      <button
                        type="button"
                        onClick={() =>
                          updateComment.mutate({
                            id: comment.id,
                            body: { resolved: !comment.resolved },
                          })
                        }
                        className={cn(
                          'rounded p-0.5 transition-colors cursor-pointer',
                          comment.resolved
                            ? 'text-emerald-400 hover:bg-emerald-500/10'
                            : 'text-muted-foreground hover:bg-accent hover:text-foreground'
                        )}
                        title={comment.resolved ? 'Mark unresolved' : 'Mark resolved'}
                        aria-label={comment.resolved ? 'Mark unresolved' : 'Mark resolved'}
                      >
                        {comment.resolved ? (
                          <CheckCircle2 className="h-3.5 w-3.5" />
                        ) : (
                          <Circle className="h-3.5 w-3.5" />
                        )}
                      </button>
                    )}

                    {authorAllowed && (
                      <button
                        type="button"
                        onClick={() => deleteComment.mutate(comment.id)}
                        className="rounded p-0.5 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
                        title="Delete comment"
                        aria-label="Delete comment"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </div>

                {/* Body */}
                <p
                  className={cn(
                    'mt-2 whitespace-pre-wrap break-words leading-relaxed',
                    comment.resolved
                      ? 'text-muted-foreground line-through decoration-muted-foreground/60'
                      : 'text-foreground/95'
                  )}
                >
                  {renderBodyWithMentions(comment.body)}
                </p>

                {/* Thread footer */}
                <div
                  className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground"
                  onClick={(e) => e.stopPropagation()}
                >
                  <span>
                    {comment.replies.length}{' '}
                    {comment.replies.length === 1 ? 'reply' : 'replies'}
                  </span>
                  {!shareToken && user && (
                    <button
                      type="button"
                      onClick={() =>
                        setReplyingToId((prev) =>
                          prev === comment.id ? null : comment.id
                        )
                      }
                      className="flex items-center gap-1 text-[11px] font-medium text-primary hover:underline cursor-pointer"
                    >
                      <CornerDownRight className="h-3 w-3" />
                      Reply
                    </button>
                  )}
                </div>

                {/* One-level nested replies */}
                {comment.replies.length > 0 && (
                  <div
                    className="mt-2.5 space-y-2 border-l-2 border-border pl-2.5"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {comment.replies.map((reply) => (
                      <div
                        key={reply.id}
                        className={cn(
                          'space-y-0.5 rounded px-1 py-0.5 transition-colors duration-200',
                          recentCommentIds[reply.id] && 'bg-primary/25'
                        )}
                      >
                        <div className="flex items-center justify-between gap-1">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-accent font-mono text-[8px] font-semibold text-foreground">
                              {getInitials(reply.author?.name, reply.author?.email)}
                            </span>
                            <span className="truncate font-medium text-foreground">
                              {reply.author?.name ?? 'Reviewer'}
                            </span>
                            <span className="text-[10px] text-muted-foreground">
                              {formatRelativeTime(reply.createdAt)}
                            </span>
                          </div>
                          {canModify(reply.userId) && (
                            <button
                              type="button"
                              onClick={() => deleteComment.mutate(reply.id)}
                              className="rounded p-0.5 text-muted-foreground hover:text-red-400 cursor-pointer"
                              aria-label="Delete reply"
                            >
                              <Trash2 className="h-3 w-3" />
                            </button>
                          )}
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed text-muted-foreground">
                          {renderBodyWithMentions(reply.body)}
                        </p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Inline reply composer */}
                {replyingToId === comment.id && !shareToken && user && (
                  <form
                    onSubmit={(e) => handlePostReply(comment, e)}
                    onClick={(e) => e.stopPropagation()}
                    className="mt-2.5 flex items-center gap-1.5"
                  >
                    <input
                      type="text"
                      value={replyDraft}
                      onChange={(e) => setReplyDraft(e.target.value)}
                      placeholder="Write a reply..."
                      className="h-7 flex-1 rounded-md border border-border bg-background px-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                      autoFocus
                    />
                    <Button
                      type="submit"
                      size="sm"
                      disabled={!replyDraft.trim() || createComment.isPending}
                      className="h-7 px-2"
                    >
                      <Send className="h-3 w-3" />
                    </Button>
                  </form>
                )}
              </div>
            );
          })
        )}

        {/* Collapsible Measurements section (Session 3 B6) */}
        <div className="rounded-md border border-border bg-background/40">
          <button
            type="button"
            onClick={() => setMeasurementsOpen((prev) => !prev)}
            className="flex w-full items-center justify-between px-2.5 py-2 text-xs font-medium text-foreground hover:bg-accent/50 transition-colors cursor-pointer"
          >
            <span className="flex items-center gap-1.5">
              {measurementsOpen ? (
                <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
              ) : (
                <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
              )}
              <Ruler className="h-3.5 w-3.5 text-amber-400" />
              Measurements
            </span>
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {persistedMeasurements?.length ?? 0}
            </span>
          </button>

          {measurementsOpen && (
            <div className="border-t border-border p-2">
              <MeasurementsPanel
                fileId={fileId}
                versionId={versionId}
                shareToken={shareToken}
                compact
              />
            </div>
          )}
        </div>
      </div>

      {/* Bottom new comment composer */}
      {!shareToken && user && (
        <form
          onSubmit={handlePostComment}
          className="shrink-0 space-y-2 border-t border-border bg-card p-3"
        >
          {selectedAnnotationId && (
            <div className="flex items-center justify-between rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] text-sky-300">
              <span className="flex items-center gap-1 font-medium">
                <MapPin className="h-3 w-3" />
                Commenting on annotation #{selectedPinNumber ?? '?'}
              </span>
              <button
                type="button"
                onClick={() => selectAnnotation(null)}
                className="rounded p-0.5 hover:bg-primary/20 cursor-pointer"
                aria-label="Detach annotation from composer"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          )}

          <textarea
            rows={2}
            value={composerBody}
            onChange={(e) => setComposerBody(e.target.value)}
            placeholder="Write a review comment (use @email to mention)..."
            maxLength={5000}
            className="w-full resize-none rounded-md border border-border bg-background p-2 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          />

          <div className="flex items-center justify-between">
            <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
              {composerBody.length}/5000
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={!composerBody.trim() || createComment.isPending}
              className="h-7 px-3 text-xs"
            >
              <Send className="h-3 w-3" />
              Post
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
