// Fixed verification scope; do not auto-load an unrelated root Vite/Vitest configuration.
export default { test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'] } };
