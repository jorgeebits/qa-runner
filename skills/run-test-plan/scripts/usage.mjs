// What a run cost. Test Agents run as Claude Code subagents whose transcripts carry exact
// per-message usage (model, input, cache writes, cache reads, output), so the orchestrator
// records each group right after it finishes: the harness may clear a transcript later. When the
// transcript is gone, the completion notice's token count is recorded instead and priced by
// calibration against groups that have both numbers, flagged as estimated. The viewer's
// chat turns report their own dollar cost, which is added as is.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { costOf, priceFor, promptTokens } from './pricing.mjs';
import { listRuns, readJson, runDir, writeJson } from './lib.mjs';

const usageFile = (runId) => join(runDir(runId), 'usage.json');
const emptyTokens = () => ({ input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 });

// MCP tools from different servers (playwright, the qa-browser pool) do the same job, so the
// profile groups them by the tool's own name.
const toolName = (name) => String(name || 'unknown').replace(/^mcp__.+?__/, '');

const resultSize = (content) => {
  if (typeof content === 'string') return { chars: content.length, images: 0 };
  let chars = 0;
  let images = 0;
  for (const part of Array.isArray(content) ? content : [])
    if (part?.type === 'image') images += 1;
    else chars += typeof part?.text === 'string' ? part.text.length : JSON.stringify(part ?? '').length;
  return { chars, images };
};

// Streaming writes several usage snapshots per message; the last one for an id is final.
// Besides tokens, the transcript shows where they went: every turn re-reads the whole context, so
// the profile records how big the context starts and grows, and which tool results filled it.
export function parseTranscript(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  const finalUsage = new Map();
  const toolOf = new Map();
  const tools = {};
  let imageReads = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const message = event.message;
    for (const part of Array.isArray(message?.content) ? message.content : []) {
      if (part.type === 'tool_use') {
        const name = toolName(part.name);
        toolOf.set(part.id, name);
        (tools[name] ||= { calls: 0, resultChars: 0, images: 0 }).calls += 1;
        if (name === 'Read' && /\.(png|jpe?g|gif|webp)$/i.test(part.input?.file_path || '')) imageReads += 1;
      } else if (part.type === 'tool_result') {
        const tool = (tools[toolOf.get(part.tool_use_id) || 'unknown'] ||= { calls: 0, resultChars: 0, images: 0 });
        const size = resultSize(part.content);
        tool.resultChars += size.chars;
        tool.images += size.images;
      }
    }
    if (event.type !== 'assistant' || !message?.usage || !message.id) continue;
    finalUsage.set(message.id, { model: message.model, usage: message.usage });
  }
  const contexts = [...finalUsage.values()].map(({ usage }) => promptTokens(usage));
  const profile = {
    turns: finalUsage.size,
    firstContext: contexts[0] ?? null,
    peakContext: contexts.length ? Math.max(...contexts) : null,
    snapshots: tools.browser_snapshot?.calls || 0,
    imageReads,
    tools,
  };
  const byModel = {};
  for (const { model, usage } of finalUsage.values()) {
    const all = (byModel[model] ||= emptyTokens());
    const above = priceFor(model)?.long?.above;
    const tokens = above && promptTokens(usage) > above ? (all.long ||= emptyTokens()) : all;
    const write1h = usage.cache_creation?.ephemeral_1h_input_tokens || 0;
    tokens.input += usage.input_tokens || 0;
    tokens.cacheWrite1h += write1h;
    tokens.cacheWrite5m += (usage.cache_creation_input_tokens || 0) - write1h;
    tokens.cacheRead += usage.cache_read_input_tokens || 0;
    tokens.output += usage.output_tokens || 0;
  }
  return { messages: finalUsage.size, byModel, profile };
}

const totalTokens = (t) =>
  t.input + t.cacheWrite5m + t.cacheWrite1h + t.cacheRead + t.output + (t.long ? totalTokens(t.long) : 0);

// A completion notice's token count is not a billing quantity (it is far smaller than the sum of
// per-turn cache reads in the transcript), so it cannot be priced directly. Groups recorded from a
// transcript also store the notice's count; their exact cost divided by it calibrates estimates for
// groups whose transcript was lost. Without a calibration point the cost stays unknown, not guessed.
function calibratedRate(model) {
  let reported = 0;
  let cost = 0;
  for (const { id: runId } of listRuns())
    for (const entry of readJson(usageFile(runId), []))
      if (!entry.estimated && entry.model === model && entry.reportedTokens && entry.costUsd) {
        reported += entry.reportedTokens;
        cost += entry.costUsd;
      }
  return reported ? cost / reported : null;
}

export function recordUsage(runId, { group, cases, transcript, tokens, model, effort, tier, toolUses, durationMs }) {
  if (!existsSync(join(runDir(runId), 'plan.json'))) throw new Error(`unknown run ${runId}`);
  const entries = readJson(usageFile(runId), []);
  const base = {
    group: group || null,
    cases: cases || [],
    toolUses: toolUses ?? null,
    durationMs: durationMs ?? null,
    effort: effort || null,
    tier: tier || null,
    at: new Date().toISOString(),
  };
  const added = [];
  const parsed = transcript && existsSync(transcript) ? parseTranscript(transcript) : null;
  if (parsed?.messages) {
    for (const [i, [modelId, t]] of Object.entries(parsed.byModel).entries()) {
      const cost = costOf(modelId, t);
      added.push({
        ...(i === 0 && { profile: parsed.profile }),
        ...base,
        source: 'transcript',
        model: priceFor(modelId)?.id || modelId,
        tokens: t,
        totalTokens: totalTokens(t),
        reportedTokens: tokens ? Number(tokens) : null,
        costUsd: cost,
        estimated: cost === null,
      });
    }
  } else if (tokens) {
    const id = priceFor(model || 'sonnet')?.id || model;
    const rate = calibratedRate(id);
    added.push({
      ...base,
      source: transcript ? 'reported (transcript was empty)' : 'reported',
      model: id,
      tokens: null,
      totalTokens: null,
      reportedTokens: Number(tokens),
      costUsd: rate ? Number(tokens) * rate : null,
      estimated: true,
      rateSource: rate ? 'calibrated from exact runs' : 'no calibration yet: record one group from its transcript',
    });
  } else throw new Error('give --transcript <file> or --tokens <n>');
  writeJson(usageFile(runId), [...entries.filter((e) => !(group && e.group === group && e.cases?.join() === (cases || []).join())), ...added]);
  return added;
}

export function chatCost(runId, testCases) {
  let cost = 0;
  let turns = 0;
  for (const tc of testCases)
    for (const message of readJson(join(runDir(runId), 'tc', tc.id, 'chat', 'messages.json'), []))
      if (message.role === 'assistant' && typeof message.cost === 'number') {
        cost += message.cost;
        turns += 1;
      }
  return { cost, turns };
}

export function runCost(runId, testCases) {
  const entries = readJson(usageFile(runId), []);
  const chat = chatCost(runId, testCases);
  const agents = entries.reduce((sum, e) => sum + (e.costUsd || 0), 0);
  // Entries are per batch (a group or a chunk of one), so coverage is checked case by case.
  const covered = new Set(entries.flatMap((e) => e.cases || []));
  const recordedGroups = new Set(entries.map((e) => e.group).filter(Boolean));
  const groups = new Set(testCases.map((tc) => tc.group || tc.id));
  const recorded = new Set(
    [...groups].filter(
      (g) => recordedGroups.has(g) || testCases.filter((tc) => (tc.group || tc.id) === g).every((tc) => covered.has(tc.id)),
    ),
  );
  return {
    profile: mergeProfiles(entries.map((e) => e.profile).filter(Boolean)),
    models: [...new Set(entries.map((e) => e.model))],
    totalUsd: entries.length || chat.turns ? agents + chat.cost : null,
    agentsUsd: entries.length ? agents : null,
    chatUsd: chat.turns ? chat.cost : null,
    chatTurns: chat.turns,
    tokens: entries.reduce((sum, e) => sum + (e.totalTokens || 0), 0),
    unpriced: entries.some((e) => e.costUsd === null),
    estimated: entries.some((e) => e.estimated),
    missingGroups: [...groups].filter((g) => !recorded.has(g)),
    entries,
  };
}

// One profile for a whole run (or many runs, in the dashboard): sums for counts, max for the peak
// context, and the mean first-turn context, which is the fixed cost every agent starts with.
export function mergeProfiles(profiles) {
  if (!profiles.length) return null;
  const merged = { agents: 0, turns: 0, firstContextSum: 0, peakContext: 0, snapshots: 0, imageReads: 0, tools: {} };
  for (const p of profiles) {
    const agents = p.agents || 1;
    merged.agents += agents;
    merged.turns += p.turns || 0;
    merged.firstContextSum += p.firstContextSum ?? (p.firstContext || 0) * agents;
    merged.peakContext = Math.max(merged.peakContext, p.peakContext || 0);
    merged.snapshots += p.snapshots || 0;
    merged.imageReads += p.imageReads || 0;
    for (const [name, t] of Object.entries(p.tools || {})) {
      const into = (merged.tools[name] ||= { calls: 0, resultChars: 0, images: 0 });
      into.calls += t.calls || 0;
      into.resultChars += t.resultChars || 0;
      into.images += t.images || 0;
    }
  }
  merged.firstContext = Math.round(merged.firstContextSum / merged.agents);
  return merged;
}
