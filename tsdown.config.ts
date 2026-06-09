import { defineConfig } from 'tsdown';

export default defineConfig((opts) => {
  const isWatch = Boolean(opts?.watch);
  const isCI = Boolean(process.env.CI);
  return {
    entry: ['src/**/*.ts', '!src/**/*.test.ts'],
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
