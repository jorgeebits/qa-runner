// Live questions: a Test Agent that needs a value the brief does not give asks the human through
// the viewer (or the orchestrator's terminal) and waits for the answer. An answer can be saved as
// a memory, so the next run in the same situation does not have to ask.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { addMemory } from './memory.mjs';
import { loadRun, readJson, safeJoin, tcDir, writeJson } from './lib.mjs';

const questionsFile = (runId, tcId) => join(tcDir(runId, tcId), 'questions.json');
// Sensitive answers never reach questions.json; the waiting agent reads this file once and
// deletes it. The server refuses to serve dot-folders.
const secretFile = (runId, tcId, qid) => safeJoin(tcDir(runId, tcId), '.answers', qid);

export const readQuestions = (runId, tcId) => readJson(questionsFile(runId, tcId), []);

export function askQuestion(runId, tcId, { field, context, screenshot }) {
  if (!existsSync(tcDir(runId, tcId))) throw new Error(`unknown test case ${tcId} in run ${runId}`);
  if (!String(field || '').trim()) throw new Error('a question needs --field');
  const questions = readQuestions(runId, tcId);
  const question = {
    id: `q${questions.length + 1}`,
    field: String(field).trim().slice(0, 200),
    context: context ? String(context).slice(0, 1000) : null,
    screenshot: screenshot || null,
    askedAt: new Date().toISOString(),
  };
  writeJson(questionsFile(runId, tcId), [...questions, question]);
  writeJson(join(tcDir(runId, tcId), 'progress.json'), {
    state: 'running',
    note: `Waiting for input: ${question.field}`,
    at: question.askedAt,
  });
  return question;
}

export function answerQuestion(runId, tcId, qid, { answer, sensitive = false, remember = null, by = 'human' }) {
  const questions = readQuestions(runId, tcId);
  const question = questions.find((q) => q.id === qid);
  if (!question) throw new Error(`unknown question ${qid}`);
  if (question.answeredAt) throw new Error(`${qid} is already answered`);
  const value = String(answer ?? '').trim();
  if (!value) throw new Error('the answer is empty');
  if (sensitive && remember) throw new Error('sensitive answers cannot be remembered; use an env secretRef instead');

  let memory = null;
  if (remember) {
    const tc = loadRun(runId).testCases.find((t) => t.id === tcId);
    // The context explains why the agent got stuck in that run; it is noise for a later run, so
    // only the field becomes the memory, and only a short field is precise enough as a trigger.
    memory = addMemory(
      {
        kind: 'data',
        text: question.field,
        value,
        triggers: question.field.length <= 60 ? [question.field] : [],
        scope: tc?.variants && Object.keys(tc.variants).length ? { variants: tc.variants } : undefined,
        source: { run: runId, tc: tcId, question: qid, confirmedBy: by },
      },
      remember,
    );
  }
  if (sensitive) {
    mkdirSync(join(tcDir(runId, tcId), '.answers'), { recursive: true });
    writeFileSync(secretFile(runId, tcId, qid), value);
  }
  Object.assign(question, {
    answer: sensitive ? '***' : value,
    sensitive: Boolean(sensitive),
    answeredAt: new Date().toISOString(),
    answeredBy: by,
    memoryId: memory?.id || null,
  });
  writeJson(questionsFile(runId, tcId), questions);
  return question;
}

export async function waitForAnswer(runId, tcId, qid, timeoutSeconds) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const question = readQuestions(runId, tcId).find((q) => q.id === qid);
    if (question?.answeredAt) {
      if (!question.sensitive) return question.answer;
      const file = secretFile(runId, tcId, qid);
      if (existsSync(file)) {
        const value = readFileSync(file, 'utf8');
        rmSync(file);
        return value;
      }
      return null;
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return undefined;
}

export function openQuestions(runId) {
  return loadRun(runId).testCases.flatMap((tc) =>
    readQuestions(runId, tc.id)
      .filter((q) => !q.answeredAt)
      .map((q) => ({ tcId: tc.id, ...q })),
  );
}
