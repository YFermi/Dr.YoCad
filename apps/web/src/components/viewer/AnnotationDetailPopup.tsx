import * as React from 'react';
import { Check, Pencil, Send, Sparkles, Trash2, X } from 'lucide-react';
import {
  isAnnotationAnchor2D,
  isAnnotationAnchor3D,
  normalizeAnnotationAnchor,
  UserRole,
  type CreateCommentRequest,
  type UpdateAnnotationRequest,
} from '@cadline/shared';
import { useAuthStore } from '@/lib/auth';
import { useViewerStore } from '@/stores/viewerStore';
import { useAiStore } from '@/stores/aiStore';
import {
  useComments,
  useCreateComment,
  useDeleteAnnotation,
  useUpdateAnnotation,
} from '@/hooks/useAnnotations';
import { cn, formatRelativeTime, getInitials } from '@/lib/utils';
import { isAnnotationResolved } from '@/components/viewer/AnnotationsLayer';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface AnnotationDetailPopupProps {
  fileId: string;
  versionId?: string;
  shareToken?: string;
}

export function AnnotationDetailPopup({
  fileId,
  versionId,
  shareToken,
}: AnnotationDetailPopupProps) {
  const user = useAuthStore((s) => s.user);
  const annotations = useViewerStore((s) => s.annotations);
  const selectedAnnotationId = useViewerStore((s) => s.selectedAnnotationId);
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const updateAnnotationLocal = useViewerStore((s) => s.updateAnnotationLocal);
  const removeAnnotationLocal = useViewerStore((s) => s.removeAnnotationLocal);
  const askAboutAnnotation = useAiStore((s) => s.askAboutAnnotation);

  const [editingLabel, setEditingLabel] = React.useState(false);
  const [labelDraft, setLabelDraft] = React.useState('');
  const [replyBody, setReplyBody] = React.useState('');

  const visibleAnnotations = React.useMemo(() => {
    const list = annotations ?? [];
    if (!versionId) return list;
    return list.filter((a) => a.versionId === versionId);
  }, [annotations, versionId]);

  const pinIndex = visibleAnnotations.findIndex((a) => a.id === selectedAnnotationId);
  const annotation = pinIndex >= 0 ? visibleAnnotations[pinIndex] : null;

  const commentsQuery = useComments(
    fileId,
    annotation ? { annotationId: annotation.id } : {},
    shareToken
  );
  const createComment = useCreateComment(fileId);
  const updateAnnotation = useUpdateAnnotation(fileId);
  const deleteAnnotation = useDeleteAnnotation(fileId);

  React.useEffect(() => {
    setEditingLabel(false);
    setLabelDraft(annotation?.label ?? '');
    setReplyBody('');
  }, [annotation?.id, annotation?.label]);

  if (!annotation) return null;

  const canModify =
    Boolean(user) &&
    !shareToken &&
    (user?.id === annotation.userId ||
      user?.role === UserRole.ADMIN ||
      user?.role === UserRole.OWNER);

  const resolved = isAnnotationResolved(annotation);
  const threads = commentsQuery.data?.items ?? [];

  const handleSaveLabel = async () => {
    const body: UpdateAnnotationRequest = {
      label: labelDraft.trim() || 'Untitled annotation',
    };
    try {
      const updated = await updateAnnotation.mutateAsync({ id: annotation.id, body });
      updateAnnotationLocal(annotation.id, updated);
      setEditingLabel(false);
    } catch {
      // Handled by hook toast
    }
  };

  const handleDelete = async () => {
    try {
      await deleteAnnotation.mutateAsync(annotation.id);
      removeAnnotationLocal(annotation.id);
    } catch {
      // Handled by hook toast
    }
  };

  const handleReplySubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    const trimmed = replyBody.trim();
    if (!trimmed) return;

    const latestTop = threads[threads.length - 1];
    const body: CreateCommentRequest = {
      body: trimmed,
      annotationId: annotation.id,
      ...(latestTop ? { parentId: latestTop.id } : {}),
    };

    setReplyBody('');
    try {
      await createComment.mutateAsync(body);
    } catch {
      setReplyBody(trimmed);
    }
  };

  return (
    <div className="pointer-events-auto absolute bottom-20 left-4 z-20 flex w-80 max-w-[calc(100%-2rem)] flex-col overflow-hidden rounded-lg border border-border bg-[#121721] text-xs shadow-2xl">
      {/* Header */}
      <div className="flex items-start justify-between gap-2 border-b border-border px-3 py-2.5">
        <div className="flex min-w-0 flex-1 items-start gap-2">
          <span
            className={cn(
              'mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full font-mono text-[10px] font-bold text-white',
              resolved ? 'bg-emerald-600' : 'bg-[#0b5fff]'
            )}
          >
            {pinIndex + 1}
          </span>
          <div className="min-w-0 flex-1">
            {editingLabel ? (
              <div className="flex items-center gap-1">
                <Input
                  value={labelDraft}
                  onChange={(e) => setLabelDraft(e.target.value)}
                  className="h-7 bg-background text-xs"
                  maxLength={240}
                  autoFocus
                />
                <button
                  type="button"
                  onClick={handleSaveLabel}
                  disabled={updateAnnotation.isPending}
                  className="rounded p-1 text-emerald-400 hover:bg-emerald-500/10 cursor-pointer"
                  title="Save label"
                >
                  <Check className="h-3.5 w-3.5" />
                </button>
              </div>
            ) : (
              <p className="truncate font-semibold text-foreground">
                {annotation.label || `Annotation #${pinIndex + 1}`}
              </p>
            )}
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {annotation.author?.name ?? 'Reviewer'} · {formatRelativeTime(annotation.createdAt)}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          {canModify && !editingLabel && (
            <>
              <button
                type="button"
                onClick={() => setEditingLabel(true)}
                className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                title="Edit label"
                aria-label="Edit label"
              >
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button
                type="button"
                onClick={handleDelete}
                disabled={deleteAnnotation.isPending}
                className="rounded p-1 text-muted-foreground hover:bg-red-500/10 hover:text-red-400 cursor-pointer"
                title="Delete annotation"
                aria-label="Delete annotation"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </>
          )}
          <button
            type="button"
            onClick={() => selectAnnotation(null)}
            className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
            title="Close popup"
            aria-label="Close popup"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Ask AI inline affordance */}
      {!shareToken && user && (
        <div className="border-b border-border/60 bg-background/30 px-3 py-1.5">
          <button
            type="button"
            onClick={() => {
              const anchor = normalizeAnnotationAnchor(annotation.payload?.anchor);
              const labelText = annotation.label || `Annotation #${pinIndex + 1}`;
              let posText = '0, 0, 0';
              if (isAnnotationAnchor3D(anchor)) {
                posText = anchor.position.map((n) => n.toFixed(2)).join(', ');
              } else if (isAnnotationAnchor2D(anchor)) {
                posText = `${anchor.x.toFixed(2)}, ${anchor.y.toFixed(2)}`;
              }
              askAboutAnnotation(
                fileId,
                `Explain this annotation (#${pinIndex + 1}): ${labelText} — position ${posText}`
              );
            }}
            className="inline-flex items-center gap-1.5 rounded border border-primary/35 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20 transition-colors cursor-pointer"
          >
            <Sparkles className="h-3 w-3" />
            Ask AI about this
          </button>
        </div>
      )}

      {/* Linked thread */}
      <div className="max-h-48 space-y-2.5 overflow-y-auto px-3 py-2.5">
        {threads.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            No comments on this pin yet. Start the discussion below.
          </p>
        ) : (
          threads.map((thread) => (
            <div key={thread.id} className="space-y-1.5">
              <div className="flex items-start gap-2">
                <div className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-primary/20 font-mono text-[9px] font-semibold text-primary">
                  {getInitials(thread.author?.name, thread.author?.email)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate font-medium text-foreground">
                      {thread.author?.name ?? 'User'}
                    </span>
                    <span className="text-[10px] text-muted-foreground">
                      {formatRelativeTime(thread.createdAt)}
                    </span>
                    {thread.resolved && (
                      <span className="rounded bg-emerald-500/15 px-1 py-0.5 font-mono text-[9px] text-emerald-300">
                        Resolved
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-[11px] leading-relaxed text-foreground/90">
                    {thread.body}
                  </p>
                </div>
              </div>

              {thread.replies.length > 0 && (
                <div className="ml-5 space-y-1.5 border-l border-border pl-2.5">
                  {thread.replies.map((reply) => (
                    <div key={reply.id} className="space-y-0.5">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium text-foreground">
                          {reply.author?.name ?? 'User'}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          {formatRelativeTime(reply.createdAt)}
                        </span>
                      </div>
                      <p className="whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
                        {reply.body}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      {/* Mini composer */}
      {!shareToken && user && (
        <form
          onSubmit={handleReplySubmit}
          className="flex items-center gap-1.5 border-t border-border bg-background/50 p-2"
        >
          <Input
            value={replyBody}
            onChange={(e) => setReplyBody(e.target.value)}
            placeholder={
              threads.length > 0 ? 'Reply to this thread...' : 'Add comment on pin...'
            }
            className="h-7 bg-background text-xs"
          />
          <Button
            type="submit"
            size="sm"
            disabled={!replyBody.trim() || createComment.isPending}
            className="h-7 px-2"
            aria-label="Send reply"
          >
            <Send className="h-3 w-3" />
          </Button>
        </form>
      )}
    </div>
  );
}
