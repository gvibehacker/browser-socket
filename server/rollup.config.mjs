import typescript from "@rollup/plugin-typescript";
import esbuild from "rollup-plugin-esbuild";

export default [
  // ESM build - full
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.esm.js",
      format: "esm",
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: true,
        declarationDir: "dist",
      }),
    ],
  },
  // ESM build - minified
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.esm.min.js",
      format: "esm",
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
      }),
      esbuild({ minify: true }),
    ],
  },
  // CommonJS build - full
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.cjs.js",
      format: "cjs",
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
      }),
    ],
  },
  // CommonJS build - minified
  {
    input: "src/index.ts",
    output: {
      file: "dist/index.cjs.min.js",
      format: "cjs",
    },
    plugins: [
      typescript({
        tsconfig: "./tsconfig.json",
        declaration: false,
      }),
      esbuild({ minify: true }),
    ],
  },
];
