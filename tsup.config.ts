import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node18",
  platform: "node",
  clean: true,
  // Splitting lets the dynamically-imported ink dashboard become its own chunk
  // so ink/react load ONLY on the interactive path (never on --quick/CI).
  splitting: true,
  // Heavy/optional UI + binary deps are lazy-loaded at runtime, so keep them
  // external — they must resolve from node_modules, not be bundled in.
  external: ["cloudflared", "ink", "react", "react/jsx-runtime"],
  banner: {
    js: "#!/usr/bin/env node",
  },
});
