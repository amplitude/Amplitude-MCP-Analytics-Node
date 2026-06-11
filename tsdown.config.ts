import { defineConfig } from 'tsdown';

export default defineConfig((opts) => {
  const isWatch = Boolean(opts?.watch);
  const isCI = Boolean(process.env.CI);
  return {
    // Curated public entry points only. 
    // Internal modules are deliberately NOT listed here so they do not become package subpath exports.
    // Every entry below is part of the supported, semver-governed public API.
    // Please add a file here only when you intend to support importing it.
    entry: [
      'src/context/',
      'src/index.ts',
      'src/client.ts',
      'src/config.ts',
      'src/exceptions.ts',
      'src/testing.ts',
      'src/types.ts',
    ],
    exports: true,
    clean: !isWatch && !isCI,
    dts: !isWatch ? { sourcemap: true } : false,
    unbundle: true,
    format: ['esm'],
    target: 'esnext',
    tsconfig: 'tsconfig.build.json',
    sourcemap: true,
    logLevel: 'error',
    outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  };
});
