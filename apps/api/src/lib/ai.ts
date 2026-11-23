import { GoogleGenAI, Type, type Content, type Schema } from '@google/genai';
import type { z } from 'zod';
import type { AiChatHistoryMessage } from '@cadline/shared';

export const AI_MODELS = {
  flash: process.env.GEMINI_MODEL_FLASH?.trim() || 'gemini-4-hydrogen',
  flashLite: process.env.GEMINI_MODEL_LITE?.trim() || 'gemini-3.1-flash-lite',
  pro: process.env.GEMINI_MODEL_PRO?.trim() || 'gemini-4-neon',
} as const;

export type AiModelName = string;

export class AiNotConfiguredError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'AI_NOT_CONFIGURED';

  constructor(
    message = 'AI Design Assistant is not configured on this server. Set GEMINI_API_KEY in the server environment to enable AI features.'
  ) {
    super(message);
    this.name = 'AiNotConfiguredError';
  }
}

export class AiBadResponseError extends Error {
  public readonly statusCode = 502;
  public readonly code = 'AI_BAD_RESPONSE';

  constructor(
    message = 'AI provider returned a response that failed schema validation.'
  ) {
    super(message);
    this.name = 'AiBadResponseError';
  }
}

let cachedClient: GoogleGenAI | null = null;
let cachedApiKey = '';

function readApiKey(): string {
  return (process.env.GEMINI_API_KEY ?? '').trim();
}

export function isAiConfigured(): boolean {
  return readApiKey().length > 0;
}

function getClient(): GoogleGenAI {
  const apiKey = readApiKey();
  if (!apiKey) {
    throw new AiNotConfiguredError();
  }
  if (!cachedClient || cachedApiKey !== apiKey) {
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
    cachedApiKey = apiKey;
  }
  return cachedClient;
}

function logTokenUsage(
  operation: string,
  model: string,
  usage:
    | {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
        totalTokenCount?: number;
      }
    | undefined
): void {
  if (!usage) return;
  console.info(
    `[ai] op=${operation} model=${model} promptTokens=${usage.promptTokenCount ?? 0} outputTokens=${usage.candidatesTokenCount ?? 0} totalTokens=${usage.totalTokenCount ?? 0}`
  );
}

function extractJsonText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('```')) {
    return trimmed
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
  }
  return trimmed;
}

function isModelTierUnavailableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    (msg.includes('RESOURCE_EXHAUSTED') && msg.includes('limit: 0')) ||
    msg.includes('NOT_FOUND')
  );
}

function isTransientOverloadError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes('UNAVAILABLE') || msg.includes('"code":503') || msg.includes('503');
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateWithResilience(
  client: GoogleGenAI,
  requestedModel: string,
  operation: string,
  params: {
    contents: string | Content[];
    config: {
      systemInstruction?: string;
      responseMimeType?: string;
      responseSchema?: Schema;
      temperature?: number;
    };
  }
) {
  const candidates: string[] = [requestedModel];
  if (!candidates.includes(AI_MODELS.flash)) candidates.push(AI_MODELS.flash);
  if (!candidates.includes(AI_MODELS.flashLite)) candidates.push(AI_MODELS.flashLite);

  let lastErr: unknown;
  for (let i = 0; i < candidates.length; i += 1) {
    const model = candidates[i];
    for (let retry = 0; retry < 2; retry += 1) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        logTokenUsage(operation, model, response.usageMetadata);
        return response;
      } catch (err) {
        lastErr = err;
        if (isModelTierUnavailableError(err)) {
          console.warn(
            `[ai] op=${operation} model=${model} unavailable on current key tier; trying next fallback`
          );
          break;
        }
        if (isTransientOverloadError(err)) {
          if (retry === 0) {
            await delay(600);
            continue;
          }
          console.warn(
            `[ai] op=${operation} model=${model} experiencing high demand; trying next fallback`
          );
          break;
        }
        throw err;
      }
    }
  }

  throw lastErr;
}

export interface GenerateTextOptions {
  systemInstruction?: string;
  model?: AiModelName;
  history?: AiChatHistoryMessage[];
}

export async function generateText(
  prompt: string,
  options: GenerateTextOptions = {}
): Promise<string> {
  const client = getClient();
  const model = options.model ?? AI_MODELS.flash;

  const contents: Content[] = [];
  if (options.history && options.history.length > 0) {
    for (const msg of options.history) {
      contents.push({
        role: msg.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: msg.content }],
      });
    }
  }
  contents.push({
    role: 'user',
    parts: [{ text: prompt }],
  });

  const response = await generateWithResilience(client, model, 'generateText', {
    contents,
    config: {
      ...(options.systemInstruction
        ? { systemInstruction: options.systemInstruction }
        : {}),
      temperature: 0.2,
    },
  });

  const text = (response.text ?? '').trim();
  if (!text) {
    throw new AiBadResponseError('AI model returned an empty reply.');
  }
  return text;
}

export interface GenerateJsonOptions {
  systemInstruction?: string;
  model?: AiModelName;
  operation?: string;
}

/**
 * Generates structured JSON via Gemini `responseSchema`, validates with Zod,
 * retries once with a stricter JSON instruction on parse/schema failure,
 * and throws AiBadResponseError (502) if still invalid.
 */
export async function generateJson<T>(
  responseSchema: Schema,
  zodSchema: z.ZodType<T>,
  prompt: string,
  options: GenerateJsonOptions = {}
): Promise<T> {
  const client = getClient();
  const model = options.model ?? AI_MODELS.flash;
  const op = options.operation ?? 'generateJson';

  let lastReason = 'Unknown schema mismatch';

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const strictAddendum =
      attempt === 2
        ? '\n\nCRITICAL RETRY INSTRUCTION: Your previous response failed strict JSON validation. Return ONLY a single valid JSON object matching the exact schema with correct field types and required keys. Do not include markdown fences or commentary.'
        : '';

    const systemInstruction = `${options.systemInstruction ?? 'You are a precise CAD design review assistant.'}${strictAddendum}`;

    const response = await generateWithResilience(
      client,
      model,
      `${op}:attempt${attempt}`,
      {
        contents: prompt,
        config: {
          systemInstruction,
          responseMimeType: 'application/json',
          responseSchema,
          temperature: attempt === 1 ? 0.15 : 0.0,
        },
      }
    );

    const rawText = extractJsonText(response.text ?? '');
    if (!rawText) {
      lastReason = 'Empty JSON response';
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText);
    } catch (err) {
      lastReason =
        err instanceof Error ? `Invalid JSON: ${err.message}` : 'Invalid JSON syntax';
      continue;
    }

    const validated = zodSchema.safeParse(parsed);
    if (validated.success) {
      return validated.data;
    }

    lastReason = validated.error.issues
      .map((issue) => `${issue.path.join('.') || 'root'}: ${issue.message}`)
      .join('; ');
  }

  throw new AiBadResponseError(
    `AI response failed schema validation after retry (${lastReason}).`
  );
}

// ============================================================================
// Gemini OpenAPI-style Response Schemas (using @google/genai Type enum)
// ============================================================================

export const AI_SUMMARY_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    summary: { type: Type.STRING },
    openIssues: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          annotationId: { type: Type.STRING },
          title: { type: Type.STRING },
          severity: { type: Type.STRING, enum: ['low', 'medium', 'high'] },
        },
        required: ['annotationId', 'title', 'severity'],
      },
    },
    resolvedCount: { type: Type.INTEGER },
    openCount: { type: Type.INTEGER },
    recommendedNextSteps: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: [
    'summary',
    'openIssues',
    'resolvedCount',
    'openCount',
    'recommendedNextSteps',
  ],
};

export const AI_BOM_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    items: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          partNumber: { type: Type.STRING },
          description: { type: Type.STRING },
          quantity: { type: Type.INTEGER },
          material: { type: Type.STRING },
          finish: { type: Type.STRING },
          notes: { type: Type.STRING },
        },
        required: ['partNumber', 'description', 'quantity'],
      },
    },
    sourceConfidence: { type: Type.STRING, enum: ['high', 'medium', 'low'] },
    warnings: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
    },
  },
  required: ['items', 'sourceConfidence', 'warnings'],
};

export const AI_DFM_RESPONSE_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    findings: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          severity: { type: Type.STRING, enum: ['info', 'warning', 'error'] },
          category: { type: Type.STRING },
          message: { type: Type.STRING },
          partId: { type: Type.STRING },
          annotationRefs: {
            type: Type.ARRAY,
            items: { type: Type.STRING },
          },
        },
        required: ['severity', 'category', 'message'],
      },
    },
  },
  required: ['findings'],
};
