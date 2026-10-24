/** 与渲染无关的数学小工具。全部是纯函数，热路径里也不分配。 */

export const TAU = Math.PI * 2;

export function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * 指数逼近：与帧率无关的平滑插值。
 * `rate` 越大越快，`dt` 变化时结果仍一致 —— 比 `lerp(a,b,0.1)` 稳定得多。
 */
export function damp(current: number, target: number, rate: number, dt: number): number {
  return target + (current - target) * Math.exp(-rate * dt);
}

export function length(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function distance(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return Math.sqrt(dx * dx + dy * dy);
}

export function distanceSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  return dx * dx + dy * dy;
}

/** 把两个分量归一化；长度为 0 时返回 (0,0)。 */
export function normalize(x: number, y: number): { x: number; y: number } {
  const len = Math.sqrt(x * x + y * y);
  if (len < 1e-6) return { x: 0, y: 0 };
  return { x: x / len, y: y / len };
}

/** 两角之间的最短夹角，范围 [-PI, PI]。 */
export function angleDelta(a: number, b: number): number {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

/** 点是否落在扇形内（角度用弧度，`halfArc` 是半张角）。 */
export function inCone(
  originX: number,
  originY: number,
  dirX: number,
  dirY: number,
  halfArc: number,
  px: number,
  py: number,
  radius: number,
): boolean {
  const dx = px - originX;
  const dy = py - originY;
  const d = Math.sqrt(dx * dx + dy * dy);
  if (d > radius || d < 1e-6) return d <= radius;
  const dot = (dx * dirX + dy * dirY) / d;
  return dot >= Math.cos(halfArc);
}

/** 点到线段的最短距离（用于剑气判定）。 */
export function distanceToSegment(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const lenSq = abx * abx + aby * aby;
  if (lenSq < 1e-6) return distance(px, py, ax, ay);
  let t = ((px - ax) * abx + (py - ay) * aby) / lenSq;
  t = clamp(t, 0, 1);
  return distance(px, py, ax + abx * t, ay + aby * t);
}
