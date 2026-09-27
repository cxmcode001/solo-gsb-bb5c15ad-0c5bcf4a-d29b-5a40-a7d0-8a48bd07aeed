import type {
  Analysis,
  Issue,
  IssueException,
  IssueType,
} from '../../shared/model';
import { locateSentence } from './analyzer';
import { uid } from './uid';

/** 例外处置的实时状态：已接受（身份在且来源句一致）/ 待复核（来源句变化）/ 已消失（问题不在实时结果中） */
export type IssueExceptionStatus = 'accepted' | 'review' | 'gone';

/** 例外处置只适用于断链与自引用（歧义走确认、循环走结构修订） */
export const EXCEPTION_TYPES: ReadonlySet<IssueType> = new Set(['broken', 'self']);

/** 来源句跳转定位（节点 + 句区间，可能附带引用 key） */
export interface ExceptionJump {
  nodeId: string;
  start: number;
  end: number;
  refKey?: string;
}

/** 处置记录与实时分析合并后的面板条目（状态实时重算，不入库） */
export interface IssueExceptionEntry {
  exception: IssueException;
  /** 实时重算状态 */
  status: IssueExceptionStatus;
  /** 身份对应的实时问题（gone 时为 null） */
  issue: Issue | null;
  /** 当前来源句原文（gone 时为重定位到的现存句子，无法定位时为 null） */
  currentSentence: string | null;
  /** 跳转定位（源节点已删除且无法重定位时为 null） */
  jump: ExceptionJump | null;
}

export interface IssueExceptionView {
  entries: IssueExceptionEntry[];
  /** 按身份索引，便于问题行展示处置状态 */
  byIdentity: Map<string, IssueExceptionEntry>;
  counts: {
    /** 实时中断链 / 自引用问题尚未处置的数量 */
    pending: number;
    accepted: number;
    review: number;
    gone: number;
    /** 全部处置记录数 */
    total: number;
  };
}

/** 取出问题当前来源句原文（与处置时保存的句子做严格比较） */
export function issueSentenceText(analysis: Analysis, issue: Issue): string {
  const node = analysis.nodes[issue.sourceNodeId];
  if (!node) return '';
  return node.text.slice(issue.sentenceStart, issue.sentenceEnd).trim();
}

/** 创建例外处置记录：绑定稳定问题身份并固化处置时的来源句原文 */
export function createIssueException(
  issue: Issue,
  analysis: Analysis,
  reason: string,
  now = Date.now(),
): IssueException {
  return {
    id: uid('exc'),
    identity: issue.identity,
    type: issue.type,
    sourceNodeId: issue.sourceNodeId,
    reason: reason.trim(),
    sentence: issueSentenceText(analysis, issue),
    acceptedAt: now,
  };
}

/**
 * 重新确认待复核（或已接受）处置：以实时问题刷新来源句证据与时间戳，理由沿用原记录。
 * 调用方须先确认实时分析中仍存在同一身份的问题。
 */
export function reconfirmIssueException(
  exception: IssueException,
  issue: Issue,
  analysis: Analysis,
  now = Date.now(),
): IssueException {
  return {
    ...exception,
    // 身份对应的实时问题可能因结构变化换了源节点 / 类型，按实时结果一并刷新
    type: issue.type,
    sourceNodeId: issue.sourceNodeId,
    sentence: issueSentenceText(analysis, issue),
    acceptedAt: now,
  };
}

/**
 * 校验并规整外部数据中的例外处置记录（旧数据 / 导入文件缺少 issueExceptions 时返回空列表）。
 * 同一身份出现多条（手工编辑 JSON）时保留处置时间最新者。
 */
export function sanitizeIssueExceptions(value: unknown): IssueException[] {
  if (!Array.isArray(value)) return [];
  const byIdentity = new Map<string, IssueException>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Partial<IssueException>;
    if (typeof e.identity !== 'string' || !e.identity) continue;
    if (e.type !== 'broken' && e.type !== 'self') continue;
    if (typeof e.sourceNodeId !== 'string' || !e.sourceNodeId) continue;
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    if (!reason) continue;
    const sentence = typeof e.sentence === 'string' ? e.sentence.trim() : '';
    if (!sentence) continue;
    const acceptedAt =
      typeof e.acceptedAt === 'number' && Number.isFinite(e.acceptedAt) ? e.acceptedAt : 0;
    const rec: IssueException = {
      id: typeof e.id === 'string' && e.id ? e.id : uid('exc'),
      identity: e.identity,
      type: e.type,
      sourceNodeId: e.sourceNodeId,
      reason,
      sentence,
      acceptedAt,
    };
    const prev = byIdentity.get(rec.identity);
    if (!prev || rec.acceptedAt >= prev.acceptedAt) byIdentity.set(rec.identity, rec);
  }
  return [...byIdentity.values()].sort((a, b) => a.acceptedAt - b.acceptedAt);
}

// ---------- 实时重算 ----------

/**
 * 按身份在实时分析中找回对应的引用出现（同节点、同原文、同文序次）。
 * 身份格式：type::nodeId::raw::occurrenceIndex（原文理论上可含 “::”，取首尾之外的中间段拼回）。
 */
function findOccurrence(analysis: Analysis, exception: IssueException) {
  const parts = exception.identity.split('::');
  if (parts.length < 4 || parts[0] !== exception.type) return undefined;
  const occurrenceIndex = Number(parts[parts.length - 1]);
  if (!Number.isInteger(occurrenceIndex)) return undefined;
  const raw = parts.slice(2, -1).join('::');
  return analysis.occurrences.find(
    (o) =>
      o.nodeId === exception.sourceNodeId &&
      o.span.raw === raw &&
      o.occurrenceIndex === occurrenceIndex,
  );
}

/**
 * 问题已消失时在当前文档中重建源句定位：
 * 非循环问题按源节点 ID + 引用原文 + 同文序次重新扫描该节点（偏移可能已变化）；
 * 源节点已删除、或引用原文已无法找回时返回 null。
 */
export function relocateExceptionJump(
  exception: IssueException,
  analysis: Analysis,
): ExceptionJump | null {
  const node = analysis.nodes[exception.sourceNodeId];
  if (!node) return null;
  const occ = findOccurrence(analysis, exception);
  if (!occ) return null;
  const sentence = locateSentence(node.text, occ.span.start, occ.span.end);
  return { nodeId: node.id, start: sentence.start, end: sentence.end, refKey: occ.key };
}

/**
 * 把处置记录与实时分析合并，逐条重算状态：
 * - 身份仍在实时问题中、且当前来源句与处置时严格一致 → 已接受；
 * - 身份仍在但来源句变化（引用前文字被改写等）→ 待复核，须重新确认刷新来源句证据；
 * - 身份已不在实时结果中（问题被修复、源节点删除、类型变化）→ 已消失。
 */
export function buildIssueExceptionView(
  exceptions: IssueException[],
  analysis: Analysis,
): IssueExceptionView {
  const liveByIdentity = new Map<Issue['identity'], Issue>();
  for (const issue of analysis.issues) liveByIdentity.set(issue.identity, issue);

  const entries: IssueExceptionEntry[] = [];
  const counts = { pending: 0, accepted: 0, review: 0, gone: 0, total: exceptions.length };
  for (const exception of exceptions) {
    const issue = liveByIdentity.get(exception.identity) ?? null;
    let status: IssueExceptionStatus;
    let currentSentence: string | null = null;
    let jump: ExceptionJump | null = null;
    if (issue) {
      currentSentence = issueSentenceText(analysis, issue);
      jump = {
        nodeId: issue.sourceNodeId,
        start: issue.sentenceStart,
        end: issue.sentenceEnd,
        refKey: issue.refKey,
      };
      // 来源句严格一致才保持「已接受」；任何文字变化都转「待复核」
      status = currentSentence === exception.sentence ? 'accepted' : 'review';
    } else {
      status = 'gone';
      const relocated = relocateExceptionJump(exception, analysis);
      if (relocated) {
        jump = relocated;
        const node = analysis.nodes[relocated.nodeId];
        currentSentence = node.text.slice(relocated.start, relocated.end).trim();
      }
    }
    counts[status] += 1;
    entries.push({ exception, status, issue, currentSentence, jump });
  }

  // 实时中断链 / 自引用问题尚未处置的数量
  const handled = new Set(exceptions.map((e) => e.identity));
  for (const issue of analysis.issues) {
    if (EXCEPTION_TYPES.has(issue.type) && !handled.has(issue.identity)) counts.pending += 1;
  }

  // 按处置时间倒序展示（最近处置在前）
  entries.sort((a, b) => b.exception.acceptedAt - a.exception.acceptedAt);
  const byIdentity = new Map(entries.map((e) => [e.exception.identity, e]));
  return { entries, byIdentity, counts };
}
