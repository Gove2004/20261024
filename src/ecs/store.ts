import type { CardDef } from '../content/cards';

/**
 * 魔物存储：结构体数组（SoA）+ 复用槽位。
 *
 * 为什么不用普通对象数组：同屏最多 200 个实体、每帧要遍历两三遍，
 * 对象 + GC 会在移动端直接掉帧。SoA 让热路径里**零分配**，
 * 也方便以后整块塞进 `Float32Array` 交给 WASM 或 worker。
 */
export const MAX_MONSTERS = 256;

export class MonsterStore {
  public readonly x = new Float32Array(MAX_MONSTERS);
  public readonly y = new Float32Array(MAX_MONSTERS);
  public readonly vx = new Float32Array(MAX_MONSTERS);
  public readonly vy = new Float32Array(MAX_MONSTERS);
  public readonly hp = new Float32Array(MAX_MONSTERS);
  public readonly maxHp = new Float32Array(MAX_MONSTERS);
  public readonly atk = new Float32Array(MAX_MONSTERS);
  public readonly armor = new Float32Array(MAX_MONSTERS);
  public readonly atkInterval = new Float32Array(MAX_MONSTERS);
  public readonly atkTimer = new Float32Array(MAX_MONSTERS);
  public readonly speed = new Float32Array(MAX_MONSTERS);
  public readonly range = new Float32Array(MAX_MONSTERS);
  public readonly radius = new Float32Array(MAX_MONSTERS);
  public readonly star = new Float32Array(MAX_MONSTERS);
  public readonly flash = new Float32Array(MAX_MONSTERS);
  public readonly slowT = new Float32Array(MAX_MONSTERS);
  public readonly slowFactor = new Float32Array(MAX_MONSTERS);
  /** 摇摆相位：让同一批怪不同步，否则会像一群机器人 */
  public readonly phase = new Float32Array(MAX_MONSTERS);
  public readonly defIdx = new Int16Array(MAX_MONSTERS);
  public readonly alive = new Uint8Array(MAX_MONSTERS);
  /** 是否穿行（无视同伴碰撞） */
  public readonly ghostly = new Uint8Array(MAX_MONSTERS);

  /** 活着的槽位下标（每帧重建，复用同一个数组避免分配）。 */
  public readonly active = new Int32Array(MAX_MONSTERS);
  public activeCount = 0;

  /** 已经被击杀但还没被渲染层回收的槽位：用于播放死亡动画。 */
  public readonly dead = new Uint8Array(MAX_MONSTERS);

  private cursor = 0;

  public reset(): void {
    this.alive.fill(0);
    this.dead.fill(0);
    this.activeCount = 0;
    this.cursor = 0;
  }

  public spawn(
    def: CardDef,
    defIndex: number,
    star: number,
    x: number,
    y: number,
    phase: number,
  ): number {
    let slot = -1;
    for (let i = 0; i < MAX_MONSTERS; i += 1) {
      const idx = (this.cursor + i) % MAX_MONSTERS;
      if (this.alive[idx] === 0) {
        slot = idx;
        this.cursor = (idx + 1) % MAX_MONSTERS;
        break;
      }
    }
    if (slot < 0) return -1;

    const scale = star;
    // 生命走 star^1.3，攻击走线性：
    // 攻击线性保证"每星战力相同"，生命更陡让大怪真的是一堵墙，
    // 否则升星只换来更长的 CD，玩家不会愿意养怪。
    const hpScale = Math.pow(star, 1.3);
    this.x[slot] = x;
    this.y[slot] = y;
    this.vx[slot] = 0;
    this.vy[slot] = 0;
    this.maxHp[slot] = def.hp * hpScale;
    this.hp[slot] = def.hp * hpScale;
    this.atk[slot] = def.atk * scale;
    this.armor[slot] = def.armor * Math.min(scale, 3);
    this.atkInterval[slot] = def.atkInterval;
    this.atkTimer[slot] = def.atkInterval * 0.5;
    this.speed[slot] = def.speed;
    this.range[slot] = def.range;
    this.radius[slot] = def.radius * (1 + 0.055 * (star - 1));
    this.star[slot] = star;
    this.flash[slot] = 0;
    this.slowT[slot] = 0;
    this.slowFactor[slot] = 1;
    this.phase[slot] = phase;
    this.defIdx[slot] = defIndex;
    this.ghostly[slot] = def.ghostly === true ? 1 : 0;
    this.alive[slot] = 1;
    this.dead[slot] = 0;
    return slot;
  }

  /** 标记死亡（数据保留到渲染层播完动画）。 */
  public kill(slot: number): void {
    if (this.alive[slot] === 0) return;
    this.alive[slot] = 0;
    this.dead[slot] = 1;
    this.hp[slot] = 0;
  }

  /** 重建活体索引表。 */
  public refreshActive(): void {
    let n = 0;
    for (let i = 0; i < MAX_MONSTERS; i += 1) {
      if (this.alive[i] === 1) {
        this.active[n] = i;
        n += 1;
      }
    }
    this.activeCount = n;
  }

  public occupiedStars(): number {
    let sum = 0;
    for (let i = 0; i < this.activeCount; i += 1) {
      const slot = this.active[i];
      if (slot !== undefined) sum += this.star[slot] ?? 0;
    }
    return sum;
  }

  /** 找到活的魔物中最接近某点的槽位；找不到返回 -1。 */
  public pickAt(px: number, py: number, tolerance: number): number {
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < this.activeCount; i += 1) {
      const slot = this.active[i];
      if (slot === undefined) continue;
      const dx = (this.x[slot] ?? 0) - px;
      const dy = (this.y[slot] ?? 0) - py;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < bestDist && d <= tolerance + (this.radius[slot] ?? 0)) {
        best = slot;
        bestDist = d;
      }
    }
    return best;
  }
}
