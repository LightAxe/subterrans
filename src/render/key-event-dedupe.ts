// code/src/render/key-event-dedupe.ts
// #306 / #311 — identity dedupe for DOM keyboard events.
//
// Phaser 3.90's KeyboardPlugin.update re-walks the WHOLE per-frame key-event
// queue on every DOM key event (KeyboardManager only clears the queue at
// POST_STEP) and skips an event only when it matches the immediately preceding
// one it processed (same keyCode + timeStamp + type). So once a key's keyup and
// a further keydown land in the same frame — a fast double-tap, or one tap
// across a frame hitch — the walk that follows re-emits an EARLIER keydown as a
// fresh `keydown-<KEY>` / Key 'down' event: the SAME event object, with
// `repeat: false`. A registered Key object cannot help there (its keyup already
// reset `isDown`, so the re-walked keydown is not stamped as a repeat), which is
// why every edge-triggered handler must be idempotent per DOM event object.
// `claim` makes that a one-liner; one instance per scene.

export class KeyEventDedupe {
  /** Weak so handled events are collected with the frame that produced them. */
  private readonly handled = new WeakSet<KeyboardEvent>();

  /** True the first time `event` is seen, false on every re-walk of it. */
  claim(event: KeyboardEvent): boolean {
    if (this.handled.has(event)) return false;
    this.handled.add(event);
    return true;
  }
}
