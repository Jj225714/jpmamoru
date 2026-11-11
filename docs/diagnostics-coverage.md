# Diagnostics coverage

Instrumented service operations use fixed names and the shared `diagnose` wrapper. Coverage includes image, video, audio and text-adjacent generation APIs; product prompt/recognition; media and image storage upload, resolve, save and cleanup; WebDAV transfer and app sync.

The wrappers preserve parameters, return values, cancellation behavior and thrown errors. They record lifecycle timing and safe error categories only. Canvas edits performed entirely inside React/Zustand state and browser download handoffs are not separately observable; an export operation is considered complete when its service returns, not when the browser finishes writing a file. Unrelated third-party services and code outside `web/src/services` remain outside this inventory.
