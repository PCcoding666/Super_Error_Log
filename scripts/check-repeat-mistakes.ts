import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkRepeatMistakes, listMediaFiles, listNullableTextPrimaryKeys, listSsrRoutes, listWebViewFiles } from './repeatMistakes.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

if (process.argv.includes('--write-baseline')) {
  const baselines = {
    webViewFiles: listWebViewFiles(root),
    ssrRoutes: listSsrRoutes(root),
    nullableTextPrimaryKeys: listNullableTextPrimaryKeys(root),
  };
  writeFileSync(path.join(root, 'scripts/lint/baselines.json'), `${JSON.stringify(baselines, null, 2)}\n`);
  const lines = ['# sha256  path', '# Current help and quality images. A new or changed image fails until this list is updated.', '# Update it only for a synthetic image with no student handwriting.', ...listMediaFiles(root).map(file => `${file.hash}  ${file.rel}`)];
  writeFileSync(path.join(root, 'scripts/lint/media-allowlist.txt'), `${lines.join('\n')}\n`);
  console.log(`Wrote baselines for ${baselines.webViewFiles.length} views, ${baselines.ssrRoutes.length} routes, ${baselines.nullableTextPrimaryKeys.length} nullable primary keys, ${lines.length - 3} images.`);
} else {
  const problems = checkRepeatMistakes(root);
  if (problems.length > 0) {
    console.error(problems.join('\n'));
    process.exit(1);
  }
  console.log('repeat-mistake checks passed');
}
