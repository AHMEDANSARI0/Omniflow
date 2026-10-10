// §264: restored - the eslint 9 flat config was dropped from the repo by a
// bulk commit, which broke `npm run lint`. Keep this file tracked.
import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Local-only folders that must never be linted:
    "venv/**",
    "_archive/**",
    "whatsapp_session/**",
    "connector-bridge/**",
    "OmniFlow-Control-Plane/**",
    "PATCHERS_TO_RUN/**",
    "tools/patchers/**",
  ]),
]);

export default eslintConfig;
