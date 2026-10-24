/**
 * 音频门面。
 *
 * 对外只暴露一个单例 + 一个每帧调用，装配层不需要知道合成细节。
 * 单例在模块加载时就存在，但**不会**创建 AudioContext —— 那必须发生在用户手势里。
 */

import { RUN } from '../content/config';
import type { Game } from '../gameplay/game';
import { AudioEngine } from './engine';

export { AudioEngine };
export type { AudioEngine as AudioEngineType };

/** 全局单例。 */
export const audio = new AudioEngine();

/**
 * 每帧喂一次局面。
 *
 * 紧迫感只在**最后 60 秒**才爬升：全程线性会让"最后 10 秒"失去重量，
 * 而倒计时判负是这个游戏唯一的失败压力来源。
 */
export function updateAudio(game: Game): void {
  audio.update(game);
  const remaining = RUN.duration - game.elapsed;
  audio.setUrgency(remaining >= RUN.warnAt ? 0 : 1 - remaining / RUN.warnAt);
}
