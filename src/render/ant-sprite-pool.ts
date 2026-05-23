// ant-sprite-pool.ts — Phaser-backed AntSpriteLayer.
//
// Maintains a retained pool of Phaser.GameObjects.Image. Each frame, GameScene
// calls beginFrame(); the draw-* modules call drawAnt(...) / drawStatic(...)
// once per visible entity; GameScene calls endFrame() to hide unused sprites.
// Sprites live at depth 50 so they render above the gfx Graphics layer.
//
// Pool entries are *kind-agnostic* — any slot can be reused for any texture.
// The bookkeeping below always resets texture + tint + rotation + depth on
// every draw so a slot recycled from a queen to an egg doesn't inherit stale
// rotation or colony tint.
//
// Only GameScene imports this file. draw-surface.ts / draw-underground.ts see
// only the AntSpriteLayer interface — keeps them Phaser-free.

import * as Phaser from 'phaser';
import {
  ANT_TEXTURE_QUEEN,
  ANT_TEXTURE_WORKER,
  EGG_TEXTURE,
  FOOD_CACHE_TEXTURE,
  LARVA_TEXTURE,
  SPIDER_SPRITE_DEPTH,
  SPIDER_TEXTURE,
  type AntSpriteDrawOptions,
  type AntSpriteLayer,
  type SpiderSpriteDrawOptions,
  type StaticSpriteDrawOptions,
  type StaticSpriteKind,
} from './ant-sprite-layer.js';

const ANT_SPRITE_DEPTH    = 50;
// Static entities sit just below ants so a queen standing in the Nursery
// still reads on top of its own eggs. Keeps Z order predictable.
const STATIC_SPRITE_DEPTH = 48;

const STATIC_TEXTURES: Record<StaticSpriteKind, string> = {
  egg:          EGG_TEXTURE,
  larva:        LARVA_TEXTURE,
  'food-cache': FOOD_CACHE_TEXTURE,
};

export class AntSpritePool implements AntSpriteLayer {
  private readonly pool: Phaser.GameObjects.Image[] = [];
  private nextIdx = 0;

  constructor(private readonly scene: Phaser.Scene) {}

  beginFrame(): void {
    this.nextIdx = 0;
  }

  private acquire(): Phaser.GameObjects.Image {
    let sprite = this.pool[this.nextIdx];
    if (sprite === undefined) {
      sprite = this.scene.add.image(0, 0, ANT_TEXTURE_WORKER);
      this.pool.push(sprite);
    }
    this.nextIdx++;
    return sprite;
  }

  drawAnt(opts: AntSpriteDrawOptions): void {
    const sprite = this.acquire();
    sprite.setTexture(opts.kind === 'queen' ? ANT_TEXTURE_QUEEN : ANT_TEXTURE_WORKER);
    sprite.setPosition(opts.x, opts.y);
    sprite.setTint(opts.tint);
    sprite.setRotation(opts.rotation ?? 0);
    sprite.setScale(opts.scale ?? 1);
    sprite.setDepth(ANT_SPRITE_DEPTH);
    sprite.setVisible(true);
  }

  drawStatic(opts: StaticSpriteDrawOptions): void {
    const sprite = this.acquire();
    sprite.setTexture(STATIC_TEXTURES[opts.kind]);
    sprite.setPosition(opts.x, opts.y);
    // Clear any tint / rotation / scale inherited from a recycled ant slot (e.g. a
    // fighter at 1.25× reused as an egg/food-cache would remain oversized).
    sprite.setTint(opts.tint ?? 0xffffff);
    sprite.setRotation(0);
    sprite.setScale(1);
    sprite.setDepth(STATIC_SPRITE_DEPTH);
    sprite.setVisible(true);
  }

  endFrame(): void {
    for (let i = this.nextIdx; i < this.pool.length; i++) {
      this.pool[i]!.setVisible(false);
    }
  }

  drawSpider(opts: SpiderSpriteDrawOptions): void {
    const sprite = this.acquire();
    sprite.setTexture(SPIDER_TEXTURE);
    sprite.setPosition(opts.x, opts.y);
    sprite.setTint(opts.tint);
    sprite.setRotation(0);
    sprite.setScale(1);
    sprite.setDepth(SPIDER_SPRITE_DEPTH);
    sprite.setVisible(true);
  }

  /** Test hook: current pool size (live + hidden). */
  get size(): number { return this.pool.length; }
}
