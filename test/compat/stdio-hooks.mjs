/**
 * Run the stdio fixture as TypeScript on Node 20 and Node 22.
 *
 * Node 22 can strip types with a flag. Node 20 cannot, and passing that flag
 * makes the child exit before it speaks MCP. This hook rewrites the source's
 * `.js` specifiers to sibling `.ts` files and erases types with the TypeScript
 * compiler the repo already depends on.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { transpileModule, ModuleKind, ScriptTarget } from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  const isRelativeJs =
    (specifier.startsWith('./') || specifier.startsWith('../')) && specifier.endsWith('.js');
  if (isRelativeJs) {
    try {
      return await nextResolve(`${specifier.slice(0, -3)}.ts`, context);
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code !== 'ERR_MODULE_NOT_FOUND') throw error;
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.ts')) return nextLoad(url, context);
  const source = readFileSync(fileURLToPath(url), 'utf8');
  const output = transpileModule(source, {
    fileName: url,
    compilerOptions: {
      module: ModuleKind.ESNext,
      target: ScriptTarget.ES2022,
      verbatimModuleSyntax: true,
    },
  });
  return { format: 'module', source: output.outputText, shortCircuit: true };
}
