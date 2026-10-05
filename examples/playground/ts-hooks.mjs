/**
 * Resolve relative `.js` imports to sibling `.ts` files when they exist.
 *
 * The SDK source imports with `.js` specifiers (the published layout). Node's
 * type stripper does not rewrite those, so `pnpm playground:*` registers this
 * hook and then runs the playground as TypeScript directly.
 */

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
