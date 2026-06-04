// debug-snapshot-download.ts — browser-only glue for triggering a file download
// of the debug snapshot payload produced by src/platform/debug-snapshot.ts.
//
// Deliberately the ONLY place we touch DOM APIs (Blob / URL.createObjectURL /
// <a>.click) for this feature. The pure payload builder is kept separate so
// headless tests can cover snapshot semantics without jsdom.

import type { DebugSnapshot } from '../platform/debug-snapshot.js';
import { defaultDebugSnapshotFilename } from '../platform/debug-snapshot.js';

/**
 * Trigger a browser download of the given DebugSnapshot as JSON.
 *
 * Safe to call from a keyboard-handler callback. Uses a single-shot Object URL
 * that is revoked immediately after the click dispatch — long-running games
 * that export many snapshots won't leak URL handles.
 *
 * @param snap      Payload from buildDebugSnapshot.
 * @param filename  Optional override; defaults to defaultDebugSnapshotFilename.
 */
export function downloadDebugSnapshot(snap: DebugSnapshot, filename?: string): void {
  const json = JSON.stringify(snap);
  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename ?? defaultDebugSnapshotFilename(snap);
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}
