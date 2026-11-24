import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, ExternalLink, FileUp, Upload, XCircle } from 'lucide-react';
import {
  fileExtension,
  isSolidWorksNativeFile,
  SOLIDWORKS_EXPORT_HELP_URL,
  SOLIDWORKS_NATIVE_UNSUPPORTED_MESSAGE,
  SUPPORTED_2D_EXTENSIONS,
  SUPPORTED_3D_EXTENSIONS,
  type DesignFile,
  type UploadInitResponse,
} from '@cadline/shared';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { apiFetch } from '@/lib/api';
import { cn, formatBytes } from '@/lib/utils';
import { toast } from '@/components/ui/toast';

const CHUNK_SIZE = 5 * 1024 * 1024; // 5 MiB S3/MinIO multipart minimum
const MAX_SIZE_BYTES = 500 * 1024 * 1024; // 500 MiB
// DWG is passed through: the server answers with its ODA File Converter guidance.
const UPLOADABLE_EXTENSIONS = new Set<string>([...SUPPORTED_3D_EXTENSIONS, ...SUPPORTED_2D_EXTENSIONS, 'dwg']);
const ACCEPT_ATTRIBUTE = [...UPLOADABLE_EXTENSIONS].map((ext) => `.${ext}`).join(',');

interface UploadDropzoneProps {
  projectId: string;
  folderId?: string | null;
  onUploaded?: (file: DesignFile) => void;
  onUploadComplete?: (file: DesignFile) => void;
}

interface UploadItemProgress {
  id: string;
  name: string;
  sizeBytes: number;
  uploadedChunks: number;
  totalChunks: number;
  percent: number;
  status: 'uploading' | 'completing' | 'done' | 'error';
  error?: string;
}

export function UploadDropzone({
  projectId,
  folderId = null,
  onUploaded,
  onUploadComplete,
}: UploadDropzoneProps) {
  const queryClient = useQueryClient();
  const inputRef = React.useRef<HTMLInputElement>(null);
  const [isDragging, setIsDragging] = React.useState(false);
  const [uploads, setUploads] = React.useState<UploadItemProgress[]>([]);
  const [rejectedSolidWorks, setRejectedSolidWorks] = React.useState<string[]>([]);

  const updateUpload = (
    id: string,
    patch: Partial<UploadItemProgress>
  ): void => {
    setUploads((prev) =>
      prev.map((item) => (item.id === id ? { ...item, ...patch } : item))
    );
  };

  const uploadSingleFile = async (file: File): Promise<void> => {
    const localId = `${file.name}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

    if (file.size === 0) {
      toast.error('Empty file skipped', `${file.name} has 0 bytes.`);
      return;
    }

    if (file.size > MAX_SIZE_BYTES) {
      toast.error(
        'File exceeds 500 MB limit',
        `${file.name} is ${formatBytes(file.size)}.`
      );
      return;
    }

    const expectedChunks = Math.max(1, Math.ceil(file.size / CHUNK_SIZE));
    setUploads((prev) => [
      {
        id: localId,
        name: file.name,
        sizeBytes: file.size,
        uploadedChunks: 0,
        totalChunks: expectedChunks,
        percent: 0,
        status: 'uploading',
      },
      ...prev.slice(0, 4),
    ]);

    try {
      // 1. Initialize multipart upload
      const init = await apiFetch<UploadInitResponse>('/files/init', {
        method: 'POST',
        body: JSON.stringify({
          projectId,
          folderId: folderId ?? null,
          fileName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size,
          chunkSize: CHUNK_SIZE,
        }),
      });

      const totalChunks = init.presignedUrls.length;
      const parts: Array<{ partNumber: number; etag: string }> = [];

      // 2. PUT each chunk directly to presignedUrls[i].url with NO Content-Type header
      for (let i = 0; i < totalChunks; i++) {
        const { partNumber, url } = init.presignedUrls[i];
        const start = i * init.chunkSize;
        const end = Math.min(file.size, start + init.chunkSize);
        const chunkBlob = file.slice(start, end);

        const putResponse = await fetch(url, {
          method: 'PUT',
          body: chunkBlob,
        });

        if (!putResponse.ok) {
          throw new Error(
            `Chunk ${partNumber}/${totalChunks} upload failed (${putResponse.status})`
          );
        }

        const rawEtag = putResponse.headers.get('ETag') ?? putResponse.headers.get('etag');
        const etag = rawEtag ? rawEtag.replace(/^"|"$/g, '') : `part-${partNumber}`;

        parts.push({ partNumber, etag });

        const uploadedChunks = i + 1;
        const percent = Math.min(95, Math.round((uploadedChunks / totalChunks) * 95));
        updateUpload(localId, { uploadedChunks, totalChunks, percent });
      }

      // 3. Finalize multipart upload and enqueue conversion job
      updateUpload(localId, { status: 'completing', percent: 98 });
      const completed = await apiFetch<DesignFile>(
        `/files/${init.file.id}/complete`,
        {
          method: 'POST',
          body: JSON.stringify({
            uploadId: init.uploadId,
            parts,
          }),
        }
      );

      updateUpload(localId, { status: 'done', percent: 100 });
      await queryClient.invalidateQueries({ queryKey: ['project-files', projectId] });
      toast.success('Upload complete', `${file.name} queued for conversion.`);
      onUploaded?.(completed);
      onUploadComplete?.(completed);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Upload failed';
      updateUpload(localId, { status: 'error', error: message });
      toast.error(`Failed to upload ${file.name}`, message);
    }
  };

  const handleFiles = (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const solidWorks: string[] = [];
    for (const file of Array.from(fileList)) {
      // Rejected before upload: never sent to the server.
      if (isSolidWorksNativeFile(file.name)) {
        solidWorks.push(file.name);
        continue;
      }
      const ext = fileExtension(file.name);
      if (!UPLOADABLE_EXTENSIONS.has(ext)) {
        toast.error(
          `Unsupported file type${ext ? ` .${ext}` : ''}`,
          `${file.name} was not uploaded. Supported: STEP, IGES, BREP, STL, OBJ, GLB/GLTF, DXF, PDF. Export to STEP from your CAD tool.`
        );
        continue;
      }
      void uploadSingleFile(file);
    }
    if (solidWorks.length > 0) setRejectedSolidWorks(solidWorks);
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            inputRef.current?.click();
          }
        }}
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragging(false);
          handleFiles(e.dataTransfer.files);
        }}
        className={cn(
          'flex flex-col items-center justify-center rounded-lg border border-dashed px-6 py-8 text-center transition-colors cursor-pointer',
          isDragging
            ? 'border-primary bg-primary/10'
            : 'border-border bg-[#0d121b] hover:border-primary/60 hover:bg-[#111827]'
        )}
      >
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={ACCEPT_ATTRIBUTE}
          className="hidden"
          onChange={(e) => {
            handleFiles(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-md bg-primary/15 text-primary">
          <Upload className="h-5 w-5" />
        </div>
        <p className="text-sm font-medium text-foreground">
          Drop CAD models or 2D drawings here or click to browse
        </p>
        <p className="mt-1 font-mono text-xs text-muted-foreground">
          STEP, IGES, BREP, STL, OBJ, GLB, DXF, PDF · 5 MB chunks · up to 500 MB
        </p>
      </div>

      {uploads.length > 0 && (
        <div className="space-y-2">
          {uploads.map((item) => (
            <div
              key={item.id}
              className="rounded-md border border-border bg-card p-3 space-y-2"
            >
              <div className="flex items-center justify-between gap-2 text-xs">
                <div className="flex items-center gap-2 min-w-0">
                  {item.status === 'done' && (
                    <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                  )}
                  {item.status === 'error' && (
                    <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                  )}
                  {(item.status === 'uploading' || item.status === 'completing') && (
                    <FileUp className="h-4 w-4 shrink-0 text-primary" />
                  )}
                  <span className="truncate font-medium text-foreground">
                    {item.name}
                  </span>
                </div>
                <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                  {item.status === 'done'
                    ? 'Queued'
                    : item.status === 'error'
                      ? 'Failed'
                      : `${item.uploadedChunks}/${item.totalChunks} · ${item.percent}%`}
                </span>
              </div>

              <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div
                  className={cn(
                    'h-full transition-all duration-200',
                    item.status === 'error'
                      ? 'bg-red-500'
                      : item.status === 'done'
                        ? 'bg-emerald-500'
                        : 'bg-primary'
                  )}
                  style={{ width: `${item.percent}%` }}
                />
              </div>

              {item.error && (
                <p className="text-xs text-red-400">{item.error}</p>
              )}
            </div>
          ))}
        </div>
      )}

      <Dialog
        open={rejectedSolidWorks.length > 0}
        onOpenChange={(open) => {
          if (!open) setRejectedSolidWorks([]);
        }}
      >
        <DialogContent className="max-w-md">
          <div data-testid="solidworks-rejection" className="space-y-3">
          <DialogHeader>
            <DialogTitle>SolidWorks file not uploaded</DialogTitle>
            <DialogDescription>{SOLIDWORKS_NATIVE_UNSUPPORTED_MESSAGE}</DialogDescription>
          </DialogHeader>
          <ul className="space-y-1 px-1 font-mono text-xs text-muted-foreground">
            {rejectedSolidWorks.map((name) => (
              <li key={name} className="truncate">
                {name}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <a
              href={SOLIDWORKS_EXPORT_HELP_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
            >
              How to export from SolidWorks
              <ExternalLink className="h-3 w-3" />
            </a>
            <Button size="sm" onClick={() => setRejectedSolidWorks([])}>
              OK
            </Button>
          </DialogFooter>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
