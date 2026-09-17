import { randomUUID } from 'node:crypto';

import { AbstractApiClient } from '@deepseek-ai/dsh-host-apiproxy/client';
import type { SessionEvent } from '@deepseek-ai/dsh-session';

import {
  STUDIO_DSH_PROMPT_CARRIER_HEADER,
  STUDIO_DSH_PROMPT_CARRIER_HEADER_VALUE,
  STUDIO_PROMPT_COMMAND_VERSION,
  type StudioPromptCommand,
} from '../../shared/studio-prompt-command.js';

const OFFICIAL_DSH_ORIGIN = 'http://dsh.internal';
const STUDIO_DSH_ROUTE_PREFIX = '/api/agent/runtime/dsh';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const HISTORY_POLL_INTERVAL_MS = 250;
const MAX_HISTORY_EVENTS = 2_000;

type FetchLike = typeof globalThis.fetch;

export interface SyntheticDshProbeInput {
  baseUrl: string;
  ssoSessionId: string;
  /** 每次拨测新建会话时用的前缀（与 sessionId 二选一）。 */
  sessionIdPrefix?: string;
  /**
   * 显式指定会话 id（稳定会话）。
   *
   * 线上需要它：官方 `session.create` 会幂等复用同一个 binding，而官方 rpc-map 没有
   * delete——逐轮新建会话会把 canary 账号的 active DSH binding 顶到上限。所以拨测改为
   * **复用同一个稳定会话**，这要求客户端允许调用方直接给定 sessionId。
   */
  sessionId?: string;
  message: string;
  expectedTool: string | null;
  expectedAssistantMarker?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export interface SyntheticDshProbeOutcome {
  sessionId: string;
  canonicalRunId: string;
  elapsedMs: number;
  assistantText: string;
  toolStarted: boolean;
  toolSucceeded: boolean;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function officialTransportPath(input: URL): string {
  if (input.origin !== OFFICIAL_DSH_ORIGIN || !input.pathname.startsWith('/api/')) {
    throw new Error(`synthetic probe refused unexpected DSH target ${input.href}`);
  }
  const method = input.pathname.slice('/api/'.length);
  if (!method || method.includes('/') || method === '.' || method === '..') {
    throw new Error(`synthetic probe refused invalid DSH target ${input.pathname}`);
  }
  return `${STUDIO_DSH_ROUTE_PREFIX}/${method}${input.search}`;
}

async function boundedResponse(response: Response): Promise<Response> {
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
    await response.body?.cancel('synthetic DSH response exceeded bound').catch(() => undefined);
    throw new Error('synthetic DSH response exceeded 2MB');
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw new Error('synthetic DSH response exceeded 2MB');
  }
  return new Response(bytes, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

class SyntheticStudioDshClient extends AbstractApiClient {
  #command: StudioPromptCommand | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly ssoSessionId: string,
    timeoutMs: number,
    private readonly fetchImpl: FetchLike,
  ) {
    super(timeoutMs);
  }

  armPrompt(command: StudioPromptCommand): void {
    if (this.#command) throw new Error('synthetic DSH prompt command is already armed');
    this.#command = command;
  }

  protected async doFetch(input: URL, init?: RequestInit): Promise<Response> {
    const pathname = officialTransportPath(input);
    const headers = new Headers(init?.headers);
    headers.set('x-rdk-sso-session', this.ssoSessionId);
    headers.set('x-rdk-locale', 'zh-CN');
    headers.set('user-agent', 'rdstudio-synthetic-probe/2');
    let body = init?.body;
    if (input.pathname === '/api/session.prompt') {
      const command = this.#command;
      this.#command = undefined;
      if (!command)
        throw new Error('synthetic official session.prompt is missing Studio admission');
      if (typeof body !== 'string')
        throw new Error('synthetic official session.prompt body is not JSON');
      const dsh = record(JSON.parse(body));
      const payload = record(dsh?.payload);
      const content = Array.isArray(payload?.content) ? payload.content : [];
      const message = content
        .map((part) => record(part)?.text)
        .filter((part): part is string => typeof part === 'string')
        .join('');
      if (
        dsh?.method !== 'session.prompt' ||
        payload?.sessionId !== command.externalSessionId ||
        message !== command.message
      ) {
        throw new Error('synthetic official prompt and Studio admission identity diverged');
      }
      headers.set(STUDIO_DSH_PROMPT_CARRIER_HEADER, STUDIO_DSH_PROMPT_CARRIER_HEADER_VALUE);
      body = JSON.stringify({ dsh, studio: command });
    }
    const response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
      ...init,
      headers,
      redirect: 'error',
      ...(body === undefined ? {} : { body }),
    });
    return boundedResponse(response);
  }
}

function receiptValue<T>(
  receipt: Readonly<{
    result:
      | Readonly<{ ok: true; value: T }>
      | Readonly<{ ok: false; error: Readonly<{ code: string; message: string }> }>;
  }>,
  operation: string,
): T {
  if (receipt.result.ok) return receipt.result.value;
  throw new Error(
    `${operation} failed: ${receipt.result.error.code}: ${receipt.result.error.message}`,
  );
}

function eventData(event: SessionEvent): Record<string, unknown> {
  return record(event.data) ?? {};
}

function canonicalRunTurn(
  events: readonly SessionEvent[],
  canonicalRunId: string,
): number | undefined {
  let currentTurn: number | undefined;
  let matchedTurn: number | undefined;
  for (const event of events) {
    const data = eventData(event);
    if (event.type === 'turn/start' && Number.isInteger(data.turn)) {
      currentTurn = Number(data.turn);
    }
    if (event.type !== 'user/message') continue;
    const source = record(data.source);
    if (source?.kind !== 'user' || source.canonicalRunId !== canonicalRunId) continue;
    if (currentTurn === undefined) throw new Error('canonical DSH user message has no native turn');
    if (matchedTurn !== undefined && matchedTurn !== currentTurn) {
      throw new Error('canonical DSH run appeared in multiple native turns');
    }
    matchedTurn = currentTurn;
  }
  return matchedTurn;
}

function eventsForRun(
  events: readonly SessionEvent[],
  canonicalRunId: string,
): readonly SessionEvent[] {
  const turn = canonicalRunTurn(events, canonicalRunId);
  if (turn === undefined) return [];
  return events.filter((event) => {
    const data = eventData(event);
    if (data.turn === turn) return true;
    if (event.type !== 'user/message') return false;
    const source = record(data.source);
    return source?.kind === 'user' && source.canonicalRunId === canonicalRunId;
  });
}

function terminalKind(events: readonly SessionEvent[]): string | undefined {
  for (const event of events) {
    if (event.type !== 'turn/end') continue;
    const reason = record(eventData(event).reason);
    if (typeof reason?.kind === 'string') return reason.kind;
  }
  return undefined;
}

function assistantText(events: readonly SessionEvent[]): string {
  return events
    .filter((event) => event.type === 'assistant/message')
    .flatMap((event) => {
      const message = record(eventData(event).message);
      return Array.isArray(message?.content) ? message.content : [];
    })
    .map((part) => record(part))
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => String(part?.text ?? ''))
    .join('');
}

function toolResultCallId(event: SessionEvent): string {
  const data = eventData(event);
  const message = record(data.message);
  const source = record(message?.source);
  const content = Array.isArray(message?.content) ? message.content : [];
  const block = record(content[0]);
  const sourceCallId = typeof source?.callId === 'string' ? source.callId.trim() : '';
  const blockCallId = typeof block?.toolCallId === 'string' ? block.toolCallId.trim() : '';
  if (sourceCallId && blockCallId && sourceCallId !== blockCallId) {
    throw new Error('native DSH tool result contains mismatched call identities');
  }
  return sourceCallId || blockCallId;
}

function validateExpectedTool(
  events: readonly SessionEvent[],
  expectedTool: string,
): Readonly<{ started: boolean; succeeded: boolean }> {
  const calls = events
    .filter((event) => event.type === 'tool/call')
    .map((event) => {
      const data = eventData(event);
      return {
        callId: typeof data.callId === 'string' ? data.callId.trim() : '',
        name: typeof data.name === 'string' ? data.name.trim() : '',
      };
    })
    .filter((call) => call.callId && call.name === expectedTool);
  const results = events
    .filter((event) => event.type === 'tool/result')
    .map((event) => {
      const data = eventData(event);
      const message = record(data.message);
      const content = Array.isArray(message?.content) ? message.content : [];
      const block = record(content[0]);
      return {
        callId: toolResultCallId(event),
        failed: data.error !== undefined || block?.isError === true,
      };
    });
  return {
    started: calls.length > 0,
    succeeded: calls.some((call) =>
      results.some((result) => result.callId === call.callId && !result.failed),
    ),
  };
}

async function pollCompletedHistory(
  client: SyntheticStudioDshClient,
  sessionId: string,
  canonicalRunId: string,
  timeoutMs: number,
  signal: AbortSignal,
): Promise<readonly SessionEvent[]> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const history = receiptValue(
      await client.sessions.history(
        {
          sessionId: sessionId as never,
          maxMessages: 200,
        },
        signal,
      ),
      'session.history',
    );
    const events = history.events.map((entry) => entry.event);
    const runEvents = eventsForRun(events, canonicalRunId);
    // 超限判断只看**本次 run** 的事件，不能看整个会话的历史。
    //
    // 真机教训（2026-09-17）：主站为避免 canary 账号的 active DSH binding 累积
    // （官方 rpc-map 没有 delete，逐轮新建会话会把 binding 顶到上限），把拨测改成
    // **复用同一个稳定 session id**——这是对的。但这里原来拿整个会话的历史事件数去比
    // MAX_HISTORY_EVENTS，于是稳定会话用久了必然超限：synthetic-ai-chat /
    // synthetic-tool-call 从 08-05 起每分钟都报「history exceeded the event bound」，
    // 而手动跑一次（新会话）却立刻通过。「事件爆炸」是本次 run 失控的信号，
    // 只应该按本次 run 的事件数判断。
    if (runEvents.length > MAX_HISTORY_EVENTS) {
      throw new Error(
        `synthetic DSH run exceeded the event bound（本次 run ${runEvents.length} 条 > 上限 ${MAX_HISTORY_EVENTS}；会话累计 ${history.events.length} 条）`,
      );
    }
    const terminal = terminalKind(runEvents);
    if (terminal === 'completed') return runEvents;
    if (terminal) throw new Error(`native DSH run ended with ${terminal}`);
    await new Promise((resolve) => setTimeout(resolve, HISTORY_POLL_INTERVAL_MS));
  }
  throw new Error(`native DSH history did not complete within ${timeoutMs}ms`);
}

export async function runSyntheticDshProbe(
  input: SyntheticDshProbeInput,
): Promise<SyntheticDshProbeOutcome> {
  const startedAt = Date.now();
  const sessionId =
    String(input.sessionId ?? '').trim() ||
    `${input.sessionIdPrefix ?? 'ops-probe'}-${Date.now()}-${randomUUID().slice(0, 8)}`;
  const client = new SyntheticStudioDshClient(
    input.baseUrl.replace(/\/+$/, ''),
    input.ssoSessionId,
    Math.min(input.timeoutMs, 60_000),
    input.fetchImpl ?? globalThis.fetch.bind(globalThis),
  );
  const signal = AbortSignal.timeout(input.timeoutMs);
  const created = receiptValue(
    await client.sessions.create({ sessionId: sessionId as never }, signal),
    'session.create',
  );
  if (created.sessionId !== sessionId) throw new Error('session.create changed the requested id');

  client.armPrompt({
    version: STUDIO_PROMPT_COMMAND_VERSION,
    externalSessionId: sessionId,
    message: input.message,
    admission: {
      sessionId,
      message: input.message,
      uiLocale: 'zh-CN',
      executionMode: 'plan',
      workflowMode: 'plan',
      chatScope: 'general',
    },
  });
  const promptReceipt = await client.sessions.prompt(
    {
      sessionId: sessionId as never,
      mode: 'queue',
      content: [{ type: 'text', text: input.message }],
    },
    signal,
  );
  receiptValue(promptReceipt, 'session.prompt');
  const canonicalRunId = String(promptReceipt.rpcId);
  const events = await pollCompletedHistory(
    client,
    sessionId,
    canonicalRunId,
    input.timeoutMs,
    signal,
  );
  const text = assistantText(events);
  if (input.expectedAssistantMarker && !text.includes(input.expectedAssistantMarker)) {
    throw new Error(`assistant output omitted ${JSON.stringify(input.expectedAssistantMarker)}`);
  }
  const tool = input.expectedTool
    ? validateExpectedTool(events, input.expectedTool)
    : { started: false, succeeded: false };
  if (input.expectedTool && (!tool.started || !tool.succeeded)) {
    throw new Error(`native DSH history did not contain a successful ${input.expectedTool} result`);
  }
  return {
    sessionId,
    canonicalRunId,
    elapsedMs: Date.now() - startedAt,
    assistantText: text,
    toolStarted: tool.started,
    toolSucceeded: tool.succeeded,
  };
}
