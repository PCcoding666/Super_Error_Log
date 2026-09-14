import fs from 'node:fs';
import path from 'node:path';
import { loadEvaluationResults, previewEvaluation, runEvaluation } from '../evaluation/runner.js';
import { scoreEvaluation, validateScoreCards } from '../evaluation/scoring.js';

function usage(): never {
  throw new Error('Usage: node --import tsx src/cli/evaluate.ts <manifest.json> <output-dir> [--live|--report]');
}

async function main(): Promise<void> {
  const argumentsWithoutNode = process.argv.slice(2);
  const flags = argumentsWithoutNode.filter(argument => argument.startsWith('--'));
  const positional = argumentsWithoutNode.filter(argument => !argument.startsWith('--'));
  if (positional.length !== 2 || flags.some(flag => !['--live', '--report'].includes(flag)) || flags.length > 1) usage();
  const [manifestName, outputName] = positional as [string, string];
  const manifest = JSON.parse(fs.readFileSync(path.resolve(manifestName), 'utf8')) as unknown;

  if (flags[0] === '--live') {
    const summary = await runEvaluation(manifest, path.resolve(outputName), {
      apiKey: process.env.SEL_AI_API_KEY ?? process.env.DASHSCOPE_API_KEY ?? '',
      baseUrl: process.env.SEL_AI_BASE_URL ?? '',
    });
    process.stdout.write(`${JSON.stringify({ mode: 'REAL_MODEL_EVALUATION', ...summary }, null, 2)}\n`);
    return;
  }

  if (flags[0] === '--report') {
    const preview = previewEvaluation(manifest);
    const outputDirectory = path.resolve(outputName);
    const experimentPath = path.join(outputDirectory, 'experiment.json');
    if (!fs.existsSync(experimentPath)) throw new Error('Evaluation experiment metadata is missing');
    const experiment = JSON.parse(fs.readFileSync(experimentPath, 'utf8')) as { experimentIdentity?: string; manifest?: unknown };
    if (JSON.stringify(experiment.manifest) !== JSON.stringify(preview.manifest)) throw new Error('Report manifest does not match the saved experiment manifest');
    const results = loadEvaluationResults(outputDirectory);
    if (typeof experiment.experimentIdentity !== 'string'
      || results.some(result => result.experimentIdentity !== experiment.experimentIdentity)) {
      throw new Error('Result identity does not match the saved experiment identity');
    }
    const scoreCardsPath = path.join(outputDirectory, 'scorecards.json');
    const cards = fs.existsSync(scoreCardsPath)
      ? validateScoreCards(JSON.parse(fs.readFileSync(scoreCardsPath, 'utf8')))
      : [];
    const report = scoreEvaluation(results, cards);
    fs.mkdirSync(outputDirectory, { recursive: true });
    fs.writeFileSync(path.join(outputDirectory, 'report.json'), `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }

  const preview = previewEvaluation(manifest);
  process.stdout.write(`${JSON.stringify({ mode: 'DRY_RUN', ...preview }, null, 2)}\n`);
}

main().catch(error => {
  const message = error instanceof Error ? error.message : 'Evaluation command failed';
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
