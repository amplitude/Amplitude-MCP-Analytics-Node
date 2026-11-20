/**
 * Fails the build when a published declaration imports an MCP SDK package.
 * The public types are structural on purpose: a server that installed only
 * one of the two packages must still typecheck.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const PACKAGE = /@modelcontextprotocol\/(?:sdk|server)/;

function declarations(dir, found) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    console.error(`check-dts-imports: no declarations at ${dir}. Run the build first.`);
    process.exit(1);
  }
  for (const name of entries) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      declarations(path, found);
      continue;
    }
    if (name.endsWith('.d.ts')) found.push(path);
  }
  return found;
}

/** Code of each line, with line comments and block comments removed. */
function codeLines(text) {
  const lines = [];
  let inBlock = false;
  for (const line of text.split('\n')) {
    let code = '';
    let i = 0;
    while (i < line.length) {
      if (inBlock) {
        const end = line.indexOf('*/', i);
        if (end === -1) {
          i = line.length;
          break;
        }
        inBlock = false;
        i = end + 2;
        continue;
      }
      if (line.startsWith('/*', i)) {
        inBlock = true;
        i += 2;
        continue;
      }
      if (line.startsWith('//', i)) break;
      code += line[i];
      i += 1;
    }
    lines.push(code);
  }
  return lines;
}

const failures = [];
for (const file of declarations(DIST, [])) {
  const lines = codeLines(readFileSync(file, 'utf8'));
  lines.forEach((code, index) => {
    if (PACKAGE.test(code)) {
      failures.push(`${file}:${index + 1}: ${code.trim()}`);
    }
  });
}

if (failures.length > 0) {
  console.error('Published declarations import an MCP SDK package:');
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
