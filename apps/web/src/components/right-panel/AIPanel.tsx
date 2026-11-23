import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  ClipboardCopy,
  Download,
  FileSpreadsheet,
  FileText,
  Info,
  MessageSquare,
  RefreshCw,
  Send,
  Settings,
  ShieldAlert,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import {
  AIInsightType,
  aiBomResultSchema,
  aiDfmResultSchema,
  aiSummaryResultSchema,
  type AiBomResponse,
  type AiBomResult,
  type AiChatHistoryMessage,
  type AiChatResponse,
  type AiDfmFinding,
  type AiDfmResponse,
  type AiDfmResult,
  type AIInsight,
  type AiSummaryResponse,
  type AiSummaryResult,
  type Annotation,
} from '@cadline/shared';
import { ApiClientError, apiFetch } from '@/lib/api';
import { cn, formatRelativeTime } from '@/lib/utils';
import { useComments, useMeasurements } from '@/hooks/useAnnotations';
import { useViewerStore } from '@/stores/viewerStore';
import { useViewer2DStore } from '@/stores/viewer2dStore';
import {
  AI_CHAT_STORAGE_PREFIX,
  AI_PRIVACY_TOAST_KEY,
  useAiStore,
} from '@/stores/aiStore';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { toast } from '@/components/ui/toast';

type AiSubTab = 'chat' | 'summary' | 'bom' | 'dfm';

interface ChatMessageItem {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  referencedAnnotationIds?: string[];
  createdAt: string;
}

interface AIPanelProps {
  fileId: string;
  versionId?: string;
  is2D?: boolean;
  shareToken?: string;
}

function readStoredChat(fileId: string): ChatMessageItem[] {
  try {
    const raw = localStorage.getItem(`${AI_CHAT_STORAGE_PREFIX}${fileId}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ChatMessageItem =>
        Boolean(item) &&
        typeof item === 'object' &&
        typeof (item as ChatMessageItem).id === 'string' &&
        ((item as ChatMessageItem).role === 'user' ||
          (item as ChatMessageItem).role === 'assistant') &&
        typeof (item as ChatMessageItem).content === 'string'
    );
  } catch {
    return [];
  }
}

function writeStoredChat(fileId: string, messages: ChatMessageItem[]): void {
  try {
    localStorage.setItem(
      `${AI_CHAT_STORAGE_PREFIX}${fileId}`,
      JSON.stringify(messages.slice(-40))
    );
  } catch {
    // Ignore storage quota errors
  }
}

function maybeShowFirstAiPrivacyToast(): void {
  try {
    if (localStorage.getItem(AI_PRIVACY_TOAST_KEY) === '1') return;
    localStorage.setItem(AI_PRIVACY_TOAST_KEY, '1');
  } catch {
    // Proceed with toast
  }
  toast.info(
    'AI Design Assistant Privacy',
    'AI can see your annotations, comments, and measurements — but never the raw model files.'
  );
}

function escapeCsvCell(value: string | number | undefined): string {
  const s = value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function buildBomTsv(bom: AiBomResult): string {
  const header = ['Part #', 'Description', 'Qty', 'Material', 'Finish', 'Notes'].join('\t');
  const rows = bom.items.map((item) =>
    [
      item.partNumber,
      item.description,
      String(item.quantity),
      item.material ?? '',
      item.finish ?? '',
      item.notes ?? '',
    ]
      .map((cell) => cell.replace(/\t|\r?\n/g, ' '))
      .join('\t')
  );
  return [header, ...rows].join('\n');
}

function buildBomCsv(bom: AiBomResult): string {
  const header = ['Part #', 'Description', 'Qty', 'Material', 'Finish', 'Notes'].join(',');
  const rows = bom.items.map((item) =>
    [
      escapeCsvCell(item.partNumber),
      escapeCsvCell(item.description),
      escapeCsvCell(item.quantity),
      escapeCsvCell(item.material),
      escapeCsvCell(item.finish),
      escapeCsvCell(item.notes),
    ].join(',')
  );
  return [header, ...rows].join('\n');
}

function severityPillClass(severity: 'low' | 'medium' | 'high' | 'info' | 'warning' | 'error'): string {
  switch (severity) {
    case 'high':
    case 'error':
      return 'border-red-500/40 bg-red-500/15 text-red-300';
    case 'medium':
    case 'warning':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
    default:
      return 'border-sky-500/40 bg-sky-500/15 text-sky-300';
  }
}

function confidencePillClass(confidence: 'high' | 'medium' | 'low'): string {
  switch (confidence) {
    case 'high':
      return 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300';
    case 'medium':
      return 'border-amber-500/40 bg-amber-500/15 text-amber-300';
    default:
      return 'border-red-500/40 bg-red-500/15 text-red-300';
  }
}

export function AIPanel({ fileId, versionId, is2D = false, shareToken }: AIPanelProps) {
  const queryClient = useQueryClient();
  const [subTab, setSubTab] = React.useState<AiSubTab>('chat');
  const [settingsOpen, setSettingsOpen] = React.useState(false);

  // Chat state (persisted in localStorage per fileId)
  const [messages, setMessages] = React.useState<ChatMessageItem[]>(() =>
    readStoredChat(fileId)
  );
  const [chatInput, setChatInput] = React.useState('');
  const chatScrollRef = React.useRef<HTMLDivElement | null>(null);

  // Structured tab results
  const [summaryData, setSummaryData] = React.useState<
    (AiSummaryResult & { cached?: boolean; createdAt?: string }) | null
  >(null);
  const [bomData, setBomData] = React.useState<
    (AiBomResult & { createdAt?: string }) | null
  >(null);
  const [dfmData, setDfmData] = React.useState<
    (AiDfmResult & { createdAt?: string }) | null
  >(null);
  const [copiedTsv, setCopiedTsv] = React.useState(false);

  // Request lifecycle / errors / cancellation / rate-limit countdown
  const [loadingOp, setLoadingOp] = React.useState<AiSubTab | null>(null);
  const [notConfigured, setNotConfigured] = React.useState(false);
  const [errorMessage, setErrorMessage] = React.useState<string | null>(null);
  const [rateLimitSeconds, setRateLimitSeconds] = React.useState<number>(0);
  const abortControllerRef = React.useRef<AbortController | null>(null);

  // Live context counts from viewer stores & queries
  const annotations = useViewerStore((s) => s.annotations) ?? [];
  const selectAnnotation = useViewerStore((s) => s.selectAnnotation);
  const selectPart = useViewerStore((s) => s.selectPart);
  const focusAnnotation2D = useViewer2DStore((s) => s.focusAnnotation);

  const commentsQuery = useComments(fileId, {}, shareToken);
  const measurementsQuery = useMeasurements(fileId, versionId, shareToken);

  const orderedAnnotations = React.useMemo(() => {
    const filtered = versionId
      ? annotations.filter((a) => a.versionId === versionId)
      : annotations;
    return [...filtered].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }, [annotations, versionId]);

  const annotationIndexMap = React.useMemo(() => {
    const map = new Map<string, { num: number; annotation: Annotation }>();
    orderedAnnotations.forEach((ann, idx) => {
      map.set(ann.id, { num: idx + 1, annotation: ann });
    });
    return map;
  }, [orderedAnnotations]);

  const totalCommentsCount = React.useMemo(() => {
    const items = commentsQuery.data?.items ?? [];
    return items.reduce((acc, thread) => acc + 1 + thread.replies.length, 0);
  }, [commentsQuery.data]);

  const totalMeasurementsCount = measurementsQuery.data?.length ?? 0;

  // Hydrate previously persisted AIInsight rows for this file
  const insightsQuery = useQuery({
    queryKey: ['ai-insights', fileId],
    queryFn: () =>
      apiFetch<AIInsight[]>(`/ai/insights?fileId=${encodeURIComponent(fileId)}`),
    enabled: Boolean(fileId) && !shareToken,
    retry: false,
  });

  React.useEffect(() => {
    const rows = insightsQuery.data;
    if (!rows || rows.length === 0) return;

    const latestSummary = rows.find((r) => r.type === AIInsightType.SUMMARY);
    if (latestSummary && !summaryData) {
      const parsed = aiSummaryResultSchema.safeParse(latestSummary.payload);
      if (parsed.success) {
        setSummaryData({
          ...parsed.data,
          cached: true,
          createdAt: latestSummary.createdAt,
        });
      }
    }

    const latestBom = rows.find((r) => r.type === AIInsightType.BOM_EXTRACTION);
    if (latestBom && !bomData) {
      const parsed = aiBomResultSchema.safeParse(latestBom.payload);
      if (parsed.success) {
        setBomData({ ...parsed.data, createdAt: latestBom.createdAt });
      }
    }

    const latestDfm = rows.find((r) => r.type === AIInsightType.DFM_CHECK);
    if (latestDfm && !dfmData) {
      const parsed = aiDfmResultSchema.safeParse(latestDfm.payload);
      if (parsed.success) {
        setDfmData({ ...parsed.data, createdAt: latestDfm.createdAt });
      }
    }
  }, [insightsQuery.data, summaryData, bomData, dfmData]);

  // Reload persisted chat when fileId changes
  React.useEffect(() => {
    setMessages(readStoredChat(fileId));
    setSummaryData(null);
    setBomData(null);
    setDfmData(null);
    setErrorMessage(null);
  }, [fileId]);

  // Consume "Ask AI about this" prompt queued from AnnotationDetailPopup
  const pendingPrompt = useAiStore((s) => s.pendingPrompt);
  const consumePendingPrompt = useAiStore((s) => s.consumePendingPrompt);
  React.useEffect(() => {
    if (pendingPrompt && pendingPrompt.fileId === fileId) {
      setSubTab('chat');
      setChatInput(pendingPrompt.text);
      consumePendingPrompt();
    }
  }, [pendingPrompt, fileId, consumePendingPrompt]);

  // Auto-scroll chat on new messages
  React.useEffect(() => {
    if (subTab === 'chat' && chatScrollRef.current) {
      chatScrollRef.current.scrollTop = chatScrollRef.current.scrollHeight;
    }
  }, [messages, loadingOp, subTab]);

  // Countdown timer for 429 rate limit
  React.useEffect(() => {
    if (rateLimitSeconds <= 0) return;
    const timer = window.setInterval(() => {
      setRateLimitSeconds((prev) => (prev <= 1 ? 0 : prev - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [rateLimitSeconds]);

  // Cancel any in-flight AI call on unmount or sub-tab switch
  const cancelInFlight = React.useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
    }
    setLoadingOp(null);
  }, []);

  React.useEffect(() => {
    return () => {
      if (abortControllerRef.current) {
        abortControllerRef.current.abort();
      }
    };
  }, []);

  const handleSwitchSubTab = (next: AiSubTab) => {
    if (next !== subTab) {
      cancelInFlight();
      setErrorMessage(null);
      setSubTab(next);
    }
  };

  const handleJumpToAnnotation = React.useCallback(
    (annotationId: string) => {
      if (is2D) {
        focusAnnotation2D(annotationId);
      } else {
        selectAnnotation(annotationId);
      }
    },
    [is2D, focusAnnotation2D, selectAnnotation]
  );

  const handleAiError = React.useCallback((err: unknown) => {
    if (err instanceof DOMException && err.name === 'AbortError') {
      return;
    }
    if (err instanceof Error && err.name === 'AbortError') {
      return;
    }
    if (err instanceof ApiClientError) {
      if (err.code === 'AI_NOT_CONFIGURED' || err.status === 503) {
        setNotConfigured(true);
        setErrorMessage(null);
        return;
      }
      if (err.code === 'AI_RATE_LIMIT' || err.status === 429) {
        const secs = err.retryAfterSeconds ?? 60;
        setRateLimitSeconds(secs);
        setErrorMessage(`Rate limit reached. You can retry in ${secs}s.`);
        return;
      }
      setErrorMessage(err.message);
      return;
    }
    setErrorMessage(err instanceof Error ? err.message : 'AI request failed.');
  }, []);

  const startAbortableCall = (op: AiSubTab): AbortSignal => {
    cancelInFlight();
    const controller = new AbortController();
    abortControllerRef.current = controller;
    setLoadingOp(op);
    setErrorMessage(null);
    setNotConfigured(false);
    return controller.signal;
  };

  const handleSendChat = async () => {
    const trimmed = chatInput.trim();
    if (!trimmed || loadingOp !== null || rateLimitSeconds > 0) return;

    const userMsg: ChatMessageItem = {
      id: `u_${Date.now()}`,
      role: 'user',
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    const historyPayload: AiChatHistoryMessage[] = messages.slice(-14).map((m) => ({
      role: m.role,
      content: m.content,
    }));

    const nextMessages = [...messages, userMsg];
    setMessages(nextMessages);
    writeStoredChat(fileId, nextMessages);
    setChatInput('');

    const signal = startAbortableCall('chat');
    try {
      const res = await apiFetch<AiChatResponse>('/ai/chat', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          fileId,
          ...(versionId ? { versionId } : {}),
          message: trimmed,
          conversationHistory: historyPayload,
        }),
      });
      maybeShowFirstAiPrivacyToast();
      const assistantMsg: ChatMessageItem = {
        id: `a_${Date.now()}`,
        role: 'assistant',
        content: res.reply,
        referencedAnnotationIds: res.referencedAnnotationIds,
        createdAt: new Date().toISOString(),
      };
      const updated = [...nextMessages, assistantMsg];
      setMessages(updated);
      writeStoredChat(fileId, updated);
    } catch (err) {
      handleAiError(err);
    } finally {
      abortControllerRef.current = null;
      setLoadingOp(null);
    }
  };

  const handleRunSummary = async (force = false) => {
    if (loadingOp !== null || rateLimitSeconds > 0) return;
    const signal = startAbortableCall('summary');
    try {
      const path = force ? '/ai/summary?force=true' : '/ai/summary';
      const res = await apiFetch<AiSummaryResponse>(path, {
        method: 'POST',
        signal,
        body: JSON.stringify({
          fileId,
          ...(versionId ? { versionId } : {}),
        }),
      });
      maybeShowFirstAiPrivacyToast();
      setSummaryData(res);
      void queryClient.invalidateQueries({ queryKey: ['ai-insights', fileId] });
    } catch (err) {
      handleAiError(err);
    } finally {
      abortControllerRef.current = null;
      setLoadingOp(null);
    }
  };

  const handleRunBom = async () => {
    if (loadingOp !== null || rateLimitSeconds > 0) return;
    const signal = startAbortableCall('bom');
    try {
      const res = await apiFetch<AiBomResponse>('/ai/bom', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          fileId,
          ...(versionId ? { versionId } : {}),
        }),
      });
      maybeShowFirstAiPrivacyToast();
      setBomData(res);
      void queryClient.invalidateQueries({ queryKey: ['ai-insights', fileId] });
    } catch (err) {
      handleAiError(err);
    } finally {
      abortControllerRef.current = null;
      setLoadingOp(null);
    }
  };

  const handleRunDfm = async () => {
    if (loadingOp !== null || rateLimitSeconds > 0) return;
    const signal = startAbortableCall('dfm');
    try {
      const res = await apiFetch<AiDfmResponse>('/ai/dfm', {
        method: 'POST',
        signal,
        body: JSON.stringify({
          fileId,
          ...(versionId ? { versionId } : {}),
        }),
      });
      maybeShowFirstAiPrivacyToast();
      setDfmData(res);
      void queryClient.invalidateQueries({ queryKey: ['ai-insights', fileId] });
    } catch (err) {
      handleAiError(err);
    } finally {
      abortControllerRef.current = null;
      setLoadingOp(null);
    }
  };

  const handleCopyBomTsv = async () => {
    if (!bomData) return;
    try {
      await navigator.clipboard.writeText(buildBomTsv(bomData));
      setCopiedTsv(true);
      toast.success('BOM copied as TSV to clipboard');
      window.setTimeout(() => setCopiedTsv(false), 1800);
    } catch {
      toast.error('Clipboard permission unavailable in this browser');
    }
  };

  const handleDownloadBomCsv = () => {
    if (!bomData) return;
    const csv = buildBomCsv(bomData);
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `cadline-bom-${fileId}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const renderMessageContentWithRefs = (content: string) => {
    const parts = content.split(/(#\d+\b)/g);
    return parts.map((segment, idx) => {
      const match = /^#(\d+)$/.exec(segment);
      if (match) {
        const pinIdx = Number(match[1]) - 1;
        const target = orderedAnnotations[pinIdx];
        if (target) {
          return (
            <button
              key={`${segment}-${idx}`}
              type="button"
              onClick={() => handleJumpToAnnotation(target.id)}
              className="mx-0.5 inline-flex items-center rounded border border-primary/40 bg-primary/15 px-1 py-0 font-mono text-[10px] font-semibold text-primary hover:bg-primary/25 cursor-pointer"
              title={`Focus ${target.label || `Annotation ${segment}`}`}
            >
              {segment}
            </button>
          );
        }
      }
      return <React.Fragment key={idx}>{segment}</React.Fragment>;
    });
  };

  const groupedDfm = React.useMemo(() => {
    if (!dfmData) return new Map<string, AiDfmFinding[]>();
    const map = new Map<string, AiDfmFinding[]>();
    for (const f of dfmData.findings) {
      const key = f.category || 'General';
      const list = map.get(key) ?? [];
      list.push(f);
      map.set(key, list);
    }
    return map;
  }, [dfmData]);

  if (shareToken) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-center">
        <Sparkles className="mb-2 h-5 w-5 text-muted-foreground" />
        <p className="text-xs font-medium text-foreground">Sign in to use Design Assistant</p>
        <p className="mt-1 text-[11px] text-muted-foreground">
          AI summaries, BOM extraction, and DFM checks require an authenticated workspace account.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden text-xs">
      {/* Header */}
      <div className="flex shrink-0 items-center justify-between border-b border-border px-3 py-2">
        <div className="flex items-center gap-2">
          <Sparkles className="h-3.5 w-3.5 text-primary" />
          <span className="font-semibold text-foreground">Design Assistant</span>
          <span className="rounded border border-primary/30 bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-primary">
            Beta
          </span>
        </div>
        <button
          type="button"
          onClick={() => setSettingsOpen(true)}
          className="flex h-6 w-6 items-center justify-center rounded border border-transparent text-muted-foreground hover:border-border hover:bg-background hover:text-foreground cursor-pointer"
          title="AI data handling & privacy"
          aria-label="AI data handling settings"
        >
          <Settings className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Sub-tabs */}
      <div className="grid shrink-0 grid-cols-4 border-b border-border bg-background/40 p-1 gap-1">
        {(
          [
            { id: 'chat', label: 'Chat', icon: MessageSquare },
            { id: 'summary', label: 'Summary', icon: FileText },
            { id: 'bom', label: 'BOM', icon: FileSpreadsheet },
            { id: 'dfm', label: 'DFM', icon: ShieldAlert },
          ] as const
        ).map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => handleSwitchSubTab(id)}
            className={cn(
              'flex items-center justify-center gap-1 rounded px-1.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer',
              subTab === id
                ? 'bg-primary text-primary-foreground shadow-xs'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Icon className="h-3 w-3 shrink-0" />
            <span>{label}</span>
          </button>
        ))}
      </div>

      {/* Global status notices (AI_NOT_CONFIGURED / 429 countdown / errors) */}
      {notConfigured && (
        <div className="mx-3 mt-2.5 shrink-0 rounded-md border border-amber-500/35 bg-amber-500/10 p-2.5 text-[11px]">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-400" />
            <div className="space-y-1">
              <p className="font-semibold text-amber-200">AI is not configured</p>
              <p className="text-amber-200/80 leading-relaxed">
                Set <code className="font-mono text-amber-100">GEMINI_API_KEY</code> on the server to enable the Design Assistant.
              </p>
              <a
                href="https://github.com/google-gemini/cookbook"
                onClick={(e) => {
                  e.preventDefault();
                  setSettingsOpen(true);
                }}
                className="inline-block font-medium text-amber-300 underline underline-offset-2 hover:text-amber-100"
              >
                View README setup & data handling details →
              </a>
            </div>
          </div>
        </div>
      )}

      {rateLimitSeconds > 0 && (
        <div className="mx-3 mt-2.5 shrink-0 rounded-md border border-amber-500/35 bg-amber-500/10 px-2.5 py-2 text-[11px] text-amber-200 flex items-center justify-between">
          <span>Rate limit active</span>
          <span className="font-mono tabular-nums font-semibold">
            Retry in {rateLimitSeconds}s
          </span>
        </div>
      )}

      {errorMessage && rateLimitSeconds === 0 && !notConfigured && (
        <div className="mx-3 mt-2.5 shrink-0 rounded-md border border-red-500/35 bg-red-500/10 px-2.5 py-2 text-[11px] text-red-200 flex items-start justify-between gap-2">
          <span className="leading-relaxed">{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-red-300 hover:text-red-100 cursor-pointer"
            aria-label="Dismiss error"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Sub-tab bodies */}
      {subTab === 'chat' && (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Context stats bar */}
          <div className="flex shrink-0 items-center justify-between border-b border-border/60 bg-background/30 px-3 py-1.5 text-[10px] text-muted-foreground">
            <span className="truncate font-mono tabular-nums">
              Context includes: {orderedAnnotations.length} annotations,{' '}
              {totalCommentsCount} comments, {totalMeasurementsCount} measurements
            </span>
            {messages.length > 0 && (
              <button
                type="button"
                onClick={() => {
                  setMessages([]);
                  writeStoredChat(fileId, []);
                }}
                className="ml-1 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground cursor-pointer"
                title="Clear chat history"
                aria-label="Clear chat history"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            )}
          </div>

          {/* Messages */}
          <div
            ref={chatScrollRef}
            className="min-h-0 flex-1 space-y-2.5 overflow-y-auto p-3"
          >
            {messages.length === 0 ? (
              <div className="rounded-md border border-dashed border-border bg-background/40 p-3 space-y-2">
                <p className="text-[11px] font-medium text-foreground">
                  Ask about this design review
                </p>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Ask questions about open annotations, measurements, part hierarchy, or drawing layers.
                </p>
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {[
                    'How many annotations are open?',
                    'Summarize recorded measurements',
                    'List the assembly parts',
                  ].map((suggestion) => (
                    <button
                      key={suggestion}
                      type="button"
                      onClick={() => setChatInput(suggestion)}
                      className="rounded border border-border bg-card px-2 py-1 text-[10px] text-muted-foreground hover:border-primary/40 hover:text-foreground cursor-pointer"
                    >
                      {suggestion}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              messages.map((msg) => (
                <div
                  key={msg.id}
                  className={cn(
                    'rounded-md border p-2.5',
                    msg.role === 'user'
                      ? 'ml-4 border-primary/30 bg-primary/10 text-foreground'
                      : 'mr-2 border-border bg-background/70 text-foreground'
                  )}
                >
                  <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
                    <span className="font-medium">
                      {msg.role === 'user' ? 'You' : 'Design Assistant'}
                    </span>
                    <span>{formatRelativeTime(msg.createdAt)}</span>
                  </div>
                  <p className="whitespace-pre-wrap break-words text-[11px] leading-relaxed">
                    {msg.role === 'assistant'
                      ? renderMessageContentWithRefs(msg.content)
                      : msg.content}
                  </p>
                  {msg.referencedAnnotationIds && msg.referencedAnnotationIds.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
                      {msg.referencedAnnotationIds.map((annId) => {
                        const meta = annotationIndexMap.get(annId);
                        return (
                          <button
                            key={annId}
                            type="button"
                            onClick={() => handleJumpToAnnotation(annId)}
                            className="inline-flex items-center gap-1 rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] text-primary hover:bg-primary/25 cursor-pointer"
                          >
                            #{meta?.num ?? '?'} {meta?.annotation.label ? `· ${meta.annotation.label.slice(0, 22)}` : ''}
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))
            )}

            {loadingOp === 'chat' && (
              <div className="mr-2 space-y-2 rounded-md border border-border bg-background/70 p-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] text-muted-foreground">Thinking…</span>
                  <button
                    type="button"
                    onClick={cancelInFlight}
                    className="text-[10px] text-muted-foreground hover:text-foreground cursor-pointer"
                  >
                    Cancel
                  </button>
                </div>
                <div className="h-2.5 w-3/4 animate-pulse rounded bg-muted" />
                <div className="h-2.5 w-1/2 animate-pulse rounded bg-muted" />
              </div>
            )}
          </div>

          {/* Chat composer */}
          <div className="shrink-0 border-t border-border bg-background/50 p-2.5">
            <div className="flex items-end gap-1.5">
              <textarea
                value={chatInput}
                onChange={(e) => setChatInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void handleSendChat();
                  }
                }}
                placeholder="Ask about annotations, parts, or measurements… (Enter to send)"
                rows={2}
                disabled={loadingOp !== null || rateLimitSeconds > 0}
                className="min-h-[54px] max-h-28 flex-1 resize-none rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void handleSendChat()}
                disabled={!chatInput.trim() || loadingOp !== null || rateLimitSeconds > 0}
                className="h-9 px-2.5 shrink-0"
                aria-label="Send message"
              >
                <Send className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </div>
      )}

      {subTab === 'summary' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="font-medium text-foreground">Review Summary</p>
              {summaryData?.createdAt && (
                <p className="text-[10px] text-muted-foreground">
                  {summaryData.cached ? 'Cached · ' : 'Generated · '}
                  {formatRelativeTime(summaryData.createdAt)}
                </p>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant={summaryData ? 'outline' : 'default'}
              disabled={loadingOp !== null || rateLimitSeconds > 0}
              onClick={() => void handleRunSummary(Boolean(summaryData))}
            >
              <RefreshCw
                className={cn('h-3 w-3', loadingOp === 'summary' && 'animate-spin')}
              />
              {summaryData ? 'Regenerate' : 'Generate'}
            </Button>
          </div>

          {loadingOp === 'summary' ? (
            <div className="space-y-2.5 rounded-md border border-border bg-background/60 p-3">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Summarizing design review…</span>
                <button
                  type="button"
                  onClick={cancelInFlight}
                  className="hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <div className="h-3 w-full animate-pulse rounded bg-muted" />
              <div className="h-3 w-5/6 animate-pulse rounded bg-muted" />
              <div className="grid grid-cols-2 gap-2 pt-1">
                <div className="h-12 animate-pulse rounded bg-muted" />
                <div className="h-12 animate-pulse rounded bg-muted" />
              </div>
            </div>
          ) : summaryData ? (
            <div className="space-y-3">
              <div className="rounded-md border border-border bg-background/60 p-2.5 leading-relaxed text-[11px] text-foreground">
                {summaryData.summary}
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-md border border-border bg-background/50 p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Open
                  </p>
                  <p className="mt-0.5 font-mono text-base font-bold tabular-nums text-amber-300">
                    {summaryData.openCount}
                  </p>
                </div>
                <div className="rounded-md border border-border bg-background/50 p-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Resolved
                  </p>
                  <p className="mt-0.5 font-mono text-base font-bold tabular-nums text-emerald-300">
                    {summaryData.resolvedCount}
                  </p>
                </div>
              </div>

              <div className="space-y-1.5">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Open Issues ({summaryData.openIssues.length})
                </p>
                {summaryData.openIssues.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    No open issues flagged.
                  </p>
                ) : (
                  summaryData.openIssues.map((issue, idx) => {
                    const meta = annotationIndexMap.get(issue.annotationId);
                    return (
                      <button
                        key={`${issue.annotationId}-${idx}`}
                        type="button"
                        onClick={() => {
                          if (meta) handleJumpToAnnotation(issue.annotationId);
                        }}
                        className="flex w-full items-start justify-between gap-2 rounded-md border border-border bg-background/50 p-2 text-left hover:border-primary/40 transition-colors cursor-pointer"
                      >
                        <div className="min-w-0">
                          <p className="truncate text-[11px] font-medium text-foreground">
                            {meta ? `#${meta.num} ` : ''}
                            {issue.title}
                          </p>
                        </div>
                        <span
                          className={cn(
                            'shrink-0 rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase',
                            severityPillClass(issue.severity)
                          )}
                        >
                          {issue.severity}
                        </span>
                      </button>
                    );
                  })
                )}
              </div>

              {summaryData.recommendedNextSteps.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    Recommended Next Steps
                  </p>
                  <ul className="space-y-1">
                    {summaryData.recommendedNextSteps.map((step, idx) => (
                      <li
                        key={idx}
                        className="flex items-start gap-1.5 text-[11px] leading-relaxed text-foreground/90"
                      >
                        <CheckCircle2 className="mt-0.5 h-3 w-3 shrink-0 text-primary" />
                        <span>{step}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-center space-y-2">
              <p className="text-[11px] font-medium text-foreground">
                No summary generated yet
              </p>
              <p className="text-[11px] text-muted-foreground">
                Synthesize all annotations, discussion threads, and resolution counts into a brief.
              </p>
            </div>
          )}
        </div>
      )}

      {subTab === 'bom' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              <p className="font-medium text-foreground">Bill of Materials</p>
              {bomData && (
                <span
                  className={cn(
                    'rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase',
                    confidencePillClass(bomData.sourceConfidence)
                  )}
                >
                  {bomData.sourceConfidence}
                </span>
              )}
            </div>
            <Button
              type="button"
              size="sm"
              variant={bomData ? 'outline' : 'default'}
              disabled={loadingOp !== null || rateLimitSeconds > 0}
              onClick={() => void handleRunBom()}
            >
              <FileSpreadsheet className="h-3 w-3" />
              {bomData ? 'Refresh' : 'Extract BOM'}
            </Button>
          </div>

          {loadingOp === 'bom' ? (
            <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Extracting BOM from metadata…</span>
                <button
                  type="button"
                  onClick={cancelInFlight}
                  className="hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <div className="h-6 w-full animate-pulse rounded bg-muted" />
              <div className="h-6 w-full animate-pulse rounded bg-muted" />
              <div className="h-6 w-4/5 animate-pulse rounded bg-muted" />
            </div>
          ) : bomData ? (
            <div className="space-y-2.5">
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void handleCopyBomTsv()}
                  className="h-7 text-[11px]"
                >
                  {copiedTsv ? (
                    <Check className="h-3 w-3 text-emerald-400" />
                  ) : (
                    <ClipboardCopy className="h-3 w-3" />
                  )}
                  Copy TSV
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={handleDownloadBomCsv}
                  className="h-7 text-[11px]"
                >
                  <Download className="h-3 w-3" />
                  CSV
                </Button>
              </div>

              {bomData.warnings.length > 0 && (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 space-y-1 text-[10px] text-amber-200">
                  {bomData.warnings.map((w, idx) => (
                    <p key={idx} className="leading-relaxed">
                      • {w}
                    </p>
                  ))}
                </div>
              )}

              <div className="overflow-x-auto rounded-md border border-border">
                <table className="w-full border-collapse text-left text-[10px]">
                  <thead>
                    <tr className="border-b border-border bg-background/80 text-muted-foreground">
                      <th className="px-2 py-1.5 font-mono font-medium">Part #</th>
                      <th className="px-2 py-1.5 font-medium">Description</th>
                      <th className="px-2 py-1.5 font-mono font-medium text-right">Qty</th>
                      <th className="px-2 py-1.5 font-medium">Material</th>
                      <th className="px-2 py-1.5 font-medium">Finish</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bomData.items.map((item, idx) => (
                      <tr
                        key={`${item.partNumber}-${idx}`}
                        className="border-b border-border/50 last:border-0 hover:bg-background/40"
                      >
                        <td className="px-2 py-1.5 font-mono text-foreground whitespace-nowrap">
                          {item.partNumber}
                        </td>
                        <td className="px-2 py-1.5 text-foreground/90">
                          {item.description}
                        </td>
                        <td className="px-2 py-1.5 font-mono tabular-nums text-right text-foreground">
                          {item.quantity}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {item.material ?? '—'}
                        </td>
                        <td className="px-2 py-1.5 text-muted-foreground">
                          {item.finish ?? '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-center space-y-2">
              <p className="text-[11px] font-medium text-foreground">
                Extract structured BOM
              </p>
              <p className="text-[11px] text-muted-foreground">
                Uses the 3D assembly part tree or 2D DXF title-block text & layers to generate an exportable BOM.
              </p>
            </div>
          )}
        </div>
      )}

      {subTab === 'dfm' && (
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-3 space-y-3">
          <div className="flex items-center justify-between gap-2">
            <p className="font-medium text-foreground">DFM Pre-Check</p>
            <Button
              type="button"
              size="sm"
              variant={dfmData ? 'outline' : 'default'}
              disabled={loadingOp !== null || rateLimitSeconds > 0}
              onClick={() => void handleRunDfm()}
            >
              <ShieldAlert className="h-3 w-3" />
              {dfmData ? 'Re-run' : 'Run Check'}
            </Button>
          </div>

          <div className="flex items-start gap-1.5 rounded border border-border/70 bg-background/40 p-2 text-[10px] text-muted-foreground">
            <Info className="mt-0.5 h-3 w-3 shrink-0 text-sky-400" />
            <span>
              Analyzes part tree, recorded measurements, and review annotations only — no raw geometry inspection.
            </span>
          </div>

          {loadingOp === 'dfm' ? (
            <div className="space-y-2 rounded-md border border-border bg-background/60 p-3">
              <div className="flex items-center justify-between text-[10px] text-muted-foreground">
                <span>Running metadata DFM review…</span>
                <button
                  type="button"
                  onClick={cancelInFlight}
                  className="hover:text-foreground cursor-pointer"
                >
                  Cancel
                </button>
              </div>
              <div className="h-14 w-full animate-pulse rounded bg-muted" />
              <div className="h-14 w-full animate-pulse rounded bg-muted" />
            </div>
          ) : dfmData ? (
            dfmData.findings.length === 0 ? (
              <div className="rounded-md border border-emerald-500/30 bg-emerald-500/10 p-3 text-center text-[11px] text-emerald-200">
                No manufacturability concerns detected from available metadata.
              </div>
            ) : (
              <div className="space-y-3">
                {Array.from(groupedDfm.entries()).map(([category, items]) => (
                  <div key={category} className="space-y-1.5">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      {category} ({items.length})
                    </p>
                    {items.map((finding, idx) => (
                      <div
                        key={`${category}-${idx}`}
                        className="rounded-md border border-border bg-background/50 p-2.5 space-y-1.5"
                      >
                        <div className="flex items-center justify-between gap-2">
                          <span
                            className={cn(
                              'rounded border px-1.5 py-0.5 font-mono text-[9px] uppercase',
                              severityPillClass(finding.severity)
                            )}
                          >
                            {finding.severity}
                          </span>
                          {finding.partId && !is2D && (
                            <button
                              type="button"
                              onClick={() => selectPart(finding.partId ?? null)}
                              className="rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[9px] text-muted-foreground hover:text-foreground cursor-pointer"
                            >
                              {finding.partId}
                            </button>
                          )}
                        </div>
                        <p className="text-[11px] leading-relaxed text-foreground/90">
                          {finding.message}
                        </p>
                        {finding.annotationRefs && finding.annotationRefs.length > 0 && (
                          <div className="flex flex-wrap gap-1 pt-0.5">
                            {finding.annotationRefs.map((refId) => {
                              const meta = annotationIndexMap.get(refId);
                              return (
                                <button
                                  key={refId}
                                  type="button"
                                  onClick={() => handleJumpToAnnotation(refId)}
                                  className="rounded border border-primary/40 bg-primary/15 px-1.5 py-0.5 font-mono text-[9px] text-primary hover:bg-primary/25 cursor-pointer"
                                >
                                  #{meta?.num ?? refId.slice(0, 6)}
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="rounded-md border border-dashed border-border bg-background/40 p-4 text-center space-y-2">
              <p className="text-[11px] font-medium text-foreground">
                Ready for DFM pre-check
              </p>
              <p className="text-[11px] text-muted-foreground">
                Flag tolerance conflicts, missing specs, and unresolved review risks from available metadata.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Data Handling & Configuration Settings Modal */}
      <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Design Assistant — Data Handling & Setup</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 text-xs leading-relaxed text-muted-foreground">
            <div className="rounded-md border border-border bg-background/60 p-3 space-y-1.5">
              <p className="font-semibold text-foreground">What leaves the server</p>
              <p>
                Only structured text context capped at <strong className="text-foreground">50 KB</strong> is sent to Gemini when you click an AI action:
                file metadata, assembly part names (max depth 3), 2D DXF layer names & title-block text, annotations, truncated comments, and measurements.
              </p>
            </div>
            <div className="rounded-md border border-border bg-background/60 p-3 space-y-1.5">
              <p className="font-semibold text-foreground">What never leaves the server</p>
              <p>
                Raw STEP/STL/OBJ/GLB binary geometry, full DXF vector coordinates, and PDF page images are <strong className="text-foreground">never</strong> transmitted to the AI provider.
              </p>
            </div>
            <div className="rounded-md border border-border bg-background/60 p-3 space-y-1.5">
              <p className="font-semibold text-foreground">Server configuration (README)</p>
              <p>
                AI is completely optional. Administrators enable it by setting{' '}
                <code className="font-mono text-foreground">GEMINI_API_KEY</code> in the server environment (see{' '}
                <code className="font-mono text-foreground">README.md#session-6--ai-design-assistant-optional</code>).
                Rate limits apply per user (30 chat / 5 min; 5 analysis / 10 min).
              </p>
            </div>
            <div className="flex justify-end pt-1">
              <Button size="sm" onClick={() => setSettingsOpen(false)}>
                Close
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
