/** Props accepted by the browser functions in OPS_OBSERVABILITY_SCRIPT_TRACE_CONTENT. */
export type TraceContentEntryKind = 'user_input' | 'model_input' | 'model_output' | 'tool_input' | 'tool_output';

export interface TraceContentSource {
  spanName?: string;
  spanRef?: string;
  traceRef?: string;
  sessionRef?: string;
  runRef?: string;
  turnRef?: string;
}

export interface TraceContentRenderOptions {
  /** Preview affects display only; copy always receives the complete returned DTO text. */
  previewCharacters?: number;
  formatJson?: boolean;
  maxJsonDepth?: number;
  maxFormattedCharacters?: number;
  initialOpen?: boolean;
  conversationOpen?: boolean;
  toolOpen?: boolean;
  showSource?: boolean;
  showSequence?: boolean;
  copyText?: (originalText: string) => void | Promise<void>;
  entryKey?: string;
  sequence?: number;
  roleLabel?: string;
  title?: string;
  loading?: boolean;
  error?: string;
}

export interface TraceContentEntryProps {
  entry: { kind: TraceContentEntryKind; text: string };
  content?: { redacted?: boolean; truncated?: boolean };
  source?: TraceContentSource | string;
  /** Unique rendered-instance key. Use separate namespaces in summary and span detail. */
  entryKey: string;
  sequence?: number;
  options?: TraceContentRenderOptions;
}

export const TRACE_CONTENT_RENDER_DEFAULTS = {
  previewCharacters: 1200,
  formatJson: true,
  maxJsonDepth: 24,
  maxFormattedCharacters: 24576,
  conversationOpen: true,
  toolOpen: false,
  showSource: false,
  showSequence: true,
} as const;
