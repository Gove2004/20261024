import { Assets, Texture } from 'pixi.js';

/**
 * 贴图清单。id 与 `public/art/<id>.png` 一一对应，由 `tools/media/plans/monsters.json` 生成。
 *
 * 这里写死清单而不是用 `import.meta.glob` 扫目录：Vite 的 glob 结果在构建期确定，
 * 但缺图时必须能优雅回退到程序化造型（冒烟测试跑的可能是没有贴图的干净仓库），
 * 写死 + try/catch 最直白。
 */
export const ART_IDS = [
  'slime',
  'ghost',
  'skeleton',
  'spider',
  'bat',
  'assassin',
  'boom',
  'frost',
  'shaman',
  'gargoyle',
  'lich',
  'general',
  'guoba',
  'guoba-rage',
  'throne',
] as const;

export type ArtId = (typeof ART_IDS)[number];

export type ArtMap = ReadonlyMap<string, Texture>;

/**
 * 加载所有贴图。**任何一张失败都不影响游戏**：
 * 缺图就走 `drawMonster` 的程序化造型，这是刻意的降级路径而不是兜底借口。
 */
export async function loadArt(): Promise<ArtMap> {
  const base = import.meta.env.BASE_URL ?? '/';
  const map = new Map<string, Texture>();

  await Promise.all(
    ART_IDS.map(async (id) => {
      try {
        const texture = await Assets.load<Texture>(`${base}art/${id}.png`);
        map.set(id, texture);
      } catch {
        // 没贴图就用占位造型，不打断启动
      }
    }),
  );

  return map;
}

/** 贴图齐全时的自检信息，供调试面板与冒烟测试使用。 */
export function missingArt(map: ArtMap): string[] {
  return ART_IDS.filter((id) => !map.has(id));
}
