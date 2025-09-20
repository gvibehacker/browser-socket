# Repository Guidelines

## Project Structure & Module Organization
browser-socket ships three publishable packages. `server/src` contains the Node.js WebSocket transport that bridges browsers to native TCP sockets. `client/src` exposes the browser-facing TCP façade and re-exports public APIs through `src/index.ts`. `cf-worker/src` adapts the same protocol to Cloudflare’s `connect()` API. Builds emit into each package’s `dist/`, and generated API docs populate sibling `docs/` folders.

## Build, Test, and Development Commands
- `cd server && npm install && npm run build` – compile the Node transport with Rollup and TypeScript.
- `cd client && npm install && npm run build` – produce browser-ready ESM, CJS, and UMD bundles.
- `cd cf-worker && npm install && npm run build` – bundle the worker bridge for edge deployment.
- `npm run dev` inside any package watches sources, rebuilding on change for rapid iteration.

## Coding Style & Naming Conventions
TypeScript is authored in `strict` mode targeting ES2015. Use two-space indentation, `camelCase` for variables/functions, `PascalCase` for classes, and lowercase hyphenated filenames (`transport.ts`). Prefer async/await over nested callbacks, co-locate protocol constants with their handlers, and surface package entry points via `src/index.ts` to preserve tree-shaking. Avoid new runtime dependencies unless they support a core networking capability.

## Testing Guidelines
Automated tests are not yet wired into the packages themselves; changes should include targeted unit or integration tests alongside the module they touch when feasible. Until richer coverage lands, validate behavior by rebuilding the affected package, exercising both connect and listen flows with temporary harnesses, and capturing console or server logs that demonstrate the fix. Document any manual verification steps in your pull request so reviewers can reproduce them quickly.

## Commit & Pull Request Guidelines
Recent commits use concise, imperative subjects such as `refine bridge example` or `fix README links`; follow that tone and keep each commit scoped to a single concern. Pull requests should explain protocol impact, outline verification steps, and link related issues. Update README, API docs, or public types when user-facing behavior changes, and call out any deployment considerations (e.g., Cloudflare bindings) in the PR description.
