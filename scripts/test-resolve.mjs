// Lets `node --test` load lib/ the way Next's bundler does: "@/x" from the repo root, and imports
// without an extension as their .ts or .tsx file. Used by `npm run test:lib`.
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);

registerHooks({
  resolve(specifier, context, next) {
    let spec = specifier.startsWith("@/") ? new URL(specifier.slice(2), root).href : specifier;
    if ((spec.startsWith(".") || spec.startsWith("file:")) && !/\.[cm]?[jt]sx?$|\.json$/.test(spec)) {
      const base = new URL(spec, context.parentURL);
      for (const ext of [".ts", ".tsx", "/index.ts"]) {
        const file = fileURLToPath(base) + ext;
        if (existsSync(file)) {
          spec = pathToFileURL(file).href;
          break;
        }
      }
    }
    return next(spec, context);
  },
});
