# Repository Guidelines

## Project Structure & Module Organization

This repository contains several Node.js packages. The main application lives in `web/`, a Vite, React, and TypeScript frontend. Place route-level screens in `web/src/pages/`, reusable UI in `web/src/components/`, shared state in `web/src/stores/`, API integrations in `web/src/services/`, utilities in `web/src/lib/`, and shared types in `web/src/types/`. Tests are colocated with source files as `*.test.ts`.

Supporting packages include `canvas-agent/` for the local canvas agent, `canvas-proxy/` for the API forwarding proxy, `plugins/` for canvas plugins and SDK code, `docs/` for the Next.js documentation site, and `assets/` for repository-level media.

## Build, Test, and Development Commands

Run commands from the package being changed. For the frontend:

```bash
cd web
npm install
npm run dev          # Start Vite on port 3000
npm test             # Run Vitest once
npm run typecheck    # Check TypeScript without emitting files
npm run format:check # Verify Prettier formatting
npm run build        # Create a production build
```

Use `npm run dev`, `npm test`, and `npm run build` from `canvas-agent/`. Start the proxy with `npm start` in `canvas-proxy/`. Run the documentation site with `npm run dev` from `docs/`.

## Coding Style & Naming Conventions

Follow `.editorconfig` and Prettier settings in `web/`; frontend source uses four-space indentation. Prefer TypeScript and React function components. Name components and exported types in `PascalCase`, functions and variables in `camelCase`, and hooks or Zustand modules with descriptive `use-*.ts` names. Keep page-specific helpers near their page and avoid unrelated refactors.

## Testing Guidelines

The frontend uses Vitest; the agent package uses Node tests through `tsx`. Name tests `*.test.ts` and colocate them with the behavior under test. Add focused regression tests for state migrations, image generation rules, and canvas operations. No fixed coverage threshold is configured, but changed logic should be exercised before submission.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects, optionally scoped, such as `feat(canvas): add white-background mode` or `fix(commerce): preserve watermark settings`. Keep commits focused. Pull requests should explain the user-visible outcome, identify affected packages, list verification commands, link related issues, and include screenshots or recordings for UI changes. Never commit API keys, generated archives, or local environment files.
