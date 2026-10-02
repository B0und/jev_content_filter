import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { experimental_evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';

export async function runJevComparison({
  apiKey,
  corpusPath = new URL('./text-cases.json', import.meta.url),
  outputPath = new URL('./text-jev-results.json', import.meta.url),
}) {
  if (!apiKey) throw new Error('Set AI_GATEWAY_API_KEY for the authenticated Jev benchmark.');
  const corpus = JSON.parse(await readFile(corpusPath, 'utf8'));
  const model = createGateway({ apiKey }).evaluationModel('typesafe-ai/jev');
  const predictions = [];
  const evaluate = async (item) => {
    const started = performance.now();
    try {
      const result = await experimental_evaluate({
        model,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15000),
        state: { tweet_text: item.text },
        questions: {
          sexual: {
            type: 'boolean',
            instructions:
              'Does this tweet contain explicit sexual content, lewd innuendo, heavily implied sexual content, or engagement bait designed to arouse?',
            criteria: {
              true: 'Lewd imagery descriptions, sexual innuendo, thirst traps, or gooner-bait phrasing',
              false:
                'Ordinary non-sexual content, even if it discusses news, health, or relationships factually',
            },
          },
          ai: {
            type: 'boolean',
            instructions:
              'Was this tweet most likely written by an AI or LLM, e.g. generic AI phrasing, engagement-farming templates, or machine-generated summaries?',
            criteria: {
              true: 'Tell-tale LLM phrasing, over-structured lists, hollow engagement bait, synthetic voice',
              false: 'Natural human writing, including slang, typos, or short fragments',
            },
          },
        },
      });
      const score = result.answers?.ai?.probability ?? result.answers?.ai?.noul;
      if (typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 1)
        throw new Error('Jev returned an invalid AI probability.');
      return { id: item.id, score, latencyMs: performance.now() - started };
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).replaceAll(
        apiKey,
        '[redacted]',
      );
      return { id: item.id, error: message, latencyMs: performance.now() - started };
    }
  };
  const first = await evaluate(corpus.cases[0]);
  if (first.error) throw new Error(first.error);
  predictions.push(first);
  let next = 1;
  await Promise.all(
    Array.from({ length: 3 }, async () => {
      while (next < corpus.cases.length) {
        const item = corpus.cases[next++];
        predictions.push(await evaluate(item));
      }
    }),
  );
  const order = new Map(corpus.cases.map((item, index) => [item.id, index]));
  predictions.sort((a, b) => order.get(a.id) - order.get(b.id));
  const output = {
    schemaVersion: 1,
    model: 'typesafe-ai/jev',
    provider: 'Vercel AI Gateway',
    evaluatedAt: new Date().toISOString(),
    revision: 'Provider-managed model version; gateway does not expose a pinned weight revision.',
    corpus: 'text-cases.json',
    predictions,
  };
  await writeFile(outputPath, JSON.stringify(output, null, 2) + '\n');
  return {
    scored: predictions.filter((row) => row.score !== undefined).length,
    errors: predictions.filter((row) => row.error).length,
    outputPath: String(outputPath),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(await runJevComparison({ apiKey: process.env.AI_GATEWAY_API_KEY })));
}
