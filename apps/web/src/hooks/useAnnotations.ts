import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  normalizeAnnotation,
  type Annotation,
  type Comment,
  type CommentsListResponse,
  type CommentWithReplies,
  type CreateAnnotationRequest,
  type CreateCommentRequest,
  type CreateMeasurementRequest,
  type Measurement,
  type UpdateAnnotationRequest,
  type UpdateCommentRequest,
  type UpdateMeasurementRequest,
} from '@cadline/shared';
import { apiFetch } from '@/lib/api';
import { useAuthStore } from '@/lib/auth';
import { toast } from '@/components/ui/toast';

export interface CommentQueryFilters {
  versionId?: string;
  annotationId?: string;
  resolved?: boolean;
}

export function annotationsQueryKey(fileId: string, versionId?: string) {
  return ['annotations', fileId, versionId ?? 'all'] as const;
}

export function commentsQueryKey(fileId: string, filters?: CommentQueryFilters) {
  return [
    'comments',
    fileId,
    filters?.versionId ?? 'all',
    filters?.annotationId ?? 'all',
    filters?.resolved === undefined ? 'all' : String(filters.resolved),
  ] as const;
}

export function measurementsQueryKey(fileId: string, versionId?: string) {
  return ['measurements', fileId, versionId ?? 'all'] as const;
}

export function useAnnotations(
  fileId: string | undefined,
  versionId?: string,
  shareToken?: string
) {
  return useQuery({
    queryKey: annotationsQueryKey(fileId ?? '', versionId),
    enabled: Boolean(fileId),
    queryFn: async () => {
      const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
      const raw = await apiFetch<Annotation[]>(`/files/${fileId}/annotations${qs}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      });
      // Backward-compatibility normalizer (C3): upgrades legacy 3D anchors missing `kind`
      return raw.map(normalizeAnnotation);
    },
  });
}

interface OptimisticAnnotationContext {
  previousEntries: Array<[readonly unknown[], Annotation[] | undefined]>;
}

export function useCreateAnnotation(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    Annotation,
    Error,
    CreateAnnotationRequest,
    OptimisticAnnotationContext
  >({
    mutationFn: async (body: CreateAnnotationRequest) => {
      const created = await apiFetch<Annotation>(`/files/${fileId}/annotations`, {
        method: 'POST',
        body: JSON.stringify(body),
      });
      return normalizeAnnotation(created);
    },
    onMutate: async (newAnn) => {
      await queryClient.cancelQueries({ queryKey: ['annotations', fileId] });
      const previousEntries = queryClient.getQueriesData<Annotation[]>({
        queryKey: ['annotations', fileId],
      });

      const currentUser = useAuthStore.getState().user;
      const nowIso = new Date().toISOString();
      const optimistic = normalizeAnnotation({
        id: `optimistic_ann_${Date.now()}`,
        fileId,
        versionId: newAnn.versionId,
        userId: currentUser?.id ?? 'me',
        type: newAnn.type,
        label: newAnn.label ?? null,
        payload: newAnn.payload,
        commentCount: 0,
        resolvedCommentCount: 0,
        author: currentUser
          ? {
              id: currentUser.id,
              name: currentUser.name,
              email: currentUser.email,
              avatarUrl: currentUser.avatarUrl,
            }
          : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      });

      for (const [key, snapshot] of previousEntries) {
        if (!snapshot) continue;
        queryClient.setQueryData<Annotation[]>(key, [...snapshot, optimistic]);
      }

      return { previousEntries };
    },
    onError: (err, _variables, context) => {
      if (context?.previousEntries) {
        for (const [key, snapshot] of context.previousEntries) {
          queryClient.setQueryData(key, snapshot);
        }
      }
      toast.error(
        'Could not save — try again',
        err instanceof Error ? err.message : undefined
      );
    },
    onSuccess: () => {
      toast.success('Annotation saved');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['annotations', fileId] });
    },
  });
}

export function useUpdateAnnotation(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (input: { id: string; body: UpdateAnnotationRequest }) => {
      const updated = await apiFetch<Annotation>(`/annotations/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify(input.body),
      });
      return normalizeAnnotation(updated);
    },
    onSuccess: async () => {
      toast.success('Annotation updated');
      await queryClient.invalidateQueries({ queryKey: ['annotations', fileId] });
    },
    onError: (err) => {
      toast.error(
        'Could not save — try again',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}

export function useDeleteAnnotation(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; deleted: boolean }>(`/annotations/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('Annotation deleted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['annotations', fileId] }),
        queryClient.invalidateQueries({ queryKey: ['comments', fileId] }),
      ]);
    },
    onError: (err) => {
      toast.error(
        'Could not delete — try again',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}

export function useComments(
  fileId: string | undefined,
  filters: CommentQueryFilters = {},
  shareToken?: string
) {
  return useQuery({
    queryKey: commentsQueryKey(fileId ?? '', filters),
    enabled: Boolean(fileId),
    queryFn: () => {
      const params = new URLSearchParams();
      if (filters.versionId) params.set('versionId', filters.versionId);
      if (filters.annotationId) params.set('annotationId', filters.annotationId);
      if (filters.resolved !== undefined) {
        params.set('resolved', String(filters.resolved));
      }
      const qs = params.toString() ? `?${params.toString()}` : '';
      return apiFetch<CommentsListResponse>(`/files/${fileId}/comments${qs}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      });
    },
  });
}

interface OptimisticCommentContext {
  previousEntries: Array<[readonly unknown[], CommentsListResponse | undefined]>;
}

export function useCreateComment(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation<CommentWithReplies, Error, CreateCommentRequest, OptimisticCommentContext>({
    mutationFn: (body: CreateCommentRequest) =>
      apiFetch<CommentWithReplies>(`/files/${fileId}/comments`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onMutate: async (newComment) => {
      await queryClient.cancelQueries({ queryKey: ['comments', fileId] });

      const previousEntries = queryClient.getQueriesData<CommentsListResponse>({
        queryKey: ['comments', fileId],
      });

      const currentUser = useAuthStore.getState().user;
      const nowIso = new Date().toISOString();
      const optimisticId = `optimistic_${Date.now()}`;

      const optimisticBase: Comment = {
        id: optimisticId,
        fileId,
        annotationId: newComment.annotationId ?? null,
        userId: currentUser?.id ?? 'me',
        parentId: newComment.parentId ?? null,
        body: newComment.body,
        resolved: false,
        author: currentUser
          ? {
              id: currentUser.id,
              name: currentUser.name,
              email: currentUser.email,
              avatarUrl: currentUser.avatarUrl,
            }
          : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      for (const [key, snapshot] of previousEntries) {
        if (!snapshot) continue;

        if (newComment.parentId) {
          const nextItems = snapshot.items.map((item) =>
            item.id === newComment.parentId
              ? { ...item, replies: [...item.replies, optimisticBase] }
              : item
          );
          queryClient.setQueryData<CommentsListResponse>(key, {
            ...snapshot,
            items: nextItems,
          });
        } else {
          const optimisticTop: CommentWithReplies = {
            ...optimisticBase,
            replies: [],
          };
          queryClient.setQueryData<CommentsListResponse>(key, {
            items: [...snapshot.items, optimisticTop],
            summary: {
              ...snapshot.summary,
              totalTopLevel: snapshot.summary.totalTopLevel + 1,
              unresolvedTopLevel: snapshot.summary.unresolvedTopLevel + 1,
            },
          });
        }
      }

      return { previousEntries };
    },
    onError: (err, _variables, context) => {
      if (context?.previousEntries) {
        for (const [key, snapshot] of context.previousEntries) {
          queryClient.setQueryData(key, snapshot);
        }
      }
      toast.error(
        'Could not save — try again',
        err instanceof Error ? err.message : undefined
      );
    },
    onSuccess: () => {
      toast.success('Comment posted');
    },
    onSettled: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['comments', fileId] }),
        queryClient.invalidateQueries({ queryKey: ['annotations', fileId] }),
      ]);
    },
  });
}

export function useUpdateComment(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; body: UpdateCommentRequest }) =>
      apiFetch<Comment>(`/comments/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify(input.body),
      }),
    onSuccess: async (_data, variables) => {
      if (variables.body.resolved !== undefined) {
        toast.success(
          variables.body.resolved ? 'Thread marked resolved' : 'Thread reopened'
        );
      } else {
        toast.success('Comment updated');
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['comments', fileId] }),
        queryClient.invalidateQueries({ queryKey: ['annotations', fileId] }),
      ]);
    },
    onError: (err) => {
      toast.error(
        'Could not save — try again',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}

export function useDeleteComment(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; deleted: boolean }>(`/comments/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('Comment deleted');
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['comments', fileId] }),
        queryClient.invalidateQueries({ queryKey: ['annotations', fileId] }),
      ]);
    },
    onError: (err) => {
      toast.error(
        'Could not delete — try again',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}

export function useMeasurements(
  fileId: string | undefined,
  versionId?: string,
  shareToken?: string
) {
  return useQuery({
    queryKey: measurementsQueryKey(fileId ?? '', versionId),
    enabled: Boolean(fileId),
    queryFn: () => {
      const qs = versionId ? `?versionId=${encodeURIComponent(versionId)}` : '';
      return apiFetch<Measurement[]>(`/files/${fileId}/measurements${qs}`, {
        shareToken,
        skipAuth: Boolean(shareToken),
      });
    },
  });
}

interface OptimisticMeasurementContext {
  previousEntries: Array<[readonly unknown[], Measurement[] | undefined]>;
}

export function useCreateMeasurement(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation<
    Measurement,
    Error,
    CreateMeasurementRequest,
    OptimisticMeasurementContext
  >({
    mutationFn: (body: CreateMeasurementRequest) =>
      apiFetch<Measurement>(`/files/${fileId}/measurements`, {
        method: 'POST',
        body: JSON.stringify(body),
      }),
    onMutate: async (newMeas) => {
      await queryClient.cancelQueries({ queryKey: ['measurements', fileId] });
      const previousEntries = queryClient.getQueriesData<Measurement[]>({
        queryKey: ['measurements', fileId],
      });

      const currentUser = useAuthStore.getState().user;
      const nowIso = new Date().toISOString();
      const optimistic: Measurement = {
        id: `optimistic_msr_${Date.now()}`,
        fileId,
        versionId: newMeas.versionId,
        userId: currentUser?.id ?? 'me',
        type: newMeas.type,
        value: newMeas.value,
        unit: newMeas.unit,
        points: newMeas.points,
        author: currentUser
          ? {
              id: currentUser.id,
              name: currentUser.name,
              email: currentUser.email,
              avatarUrl: currentUser.avatarUrl,
            }
          : undefined,
        createdAt: nowIso,
        updatedAt: nowIso,
      };

      for (const [key, snapshot] of previousEntries) {
        if (!snapshot) continue;
        queryClient.setQueryData<Measurement[]>(key, [...snapshot, optimistic]);
      }

      return { previousEntries };
    },
    onError: (err, _variables, context) => {
      if (context?.previousEntries) {
        for (const [key, snapshot] of context.previousEntries) {
          queryClient.setQueryData(key, snapshot);
        }
      }
      toast.error(
        'Could not save — try again',
        err instanceof Error ? err.message : undefined
      );
    },
    onSuccess: () => {
      toast.success('Measurement saved');
    },
    onSettled: async () => {
      await queryClient.invalidateQueries({ queryKey: ['measurements', fileId] });
    },
  });
}

export function useDeleteMeasurement(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ id: string; deleted: boolean }>(`/measurements/${id}`, {
        method: 'DELETE',
      }),
    onSuccess: async () => {
      toast.success('Measurement deleted');
      await queryClient.invalidateQueries({ queryKey: ['measurements', fileId] });
    },
    onError: (err) => {
      toast.error(
        'Could not delete — try again',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}

export function useUpdateMeasurement(fileId: string) {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: { id: string; body: UpdateMeasurementRequest }) =>
      apiFetch<Measurement>(`/measurements/${input.id}`, {
        method: 'PATCH',
        body: JSON.stringify(input.body),
      }),
    onSuccess: async () => {
      toast.success('Measurement updated');
      await queryClient.invalidateQueries({ queryKey: ['measurements', fileId] });
    },
    onError: (err) => {
      toast.error(
        'Could not update measurement',
        err instanceof Error ? err.message : undefined
      );
    },
  });
}
