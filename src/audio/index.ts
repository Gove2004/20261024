/**
 * 音频门面。
 *
 * 对外只暴露一个单例 + 一个每帧调用，装配层不需要知道合成细节。
 * 单例在模块加载时就存在，但**不会**创建 AudioContext —— 那必须发生在用户手势里。
 *
 * BGM 的分幕（平和 / 紧张 / 高潮）默认由 `updateAudio` 每帧按 `game.elapsed`
 * 自动推进；单位时间轴以外的节奏（比如按波次切）可以调下面的 `setMusicIntensity`。
 */

import { RUN } from '../content/config';
import type { Game } from '../gameplay/game';
import { AudioEngine } from './engine';

export { AudioEngine };
export type { AudioEngine as AudioEngineType };
export { MAX_VOICES } from './synth';

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

/** 起播 BGM（`audio.unlock()` 已经自动调过一次，重开局时可显式再来一次）。 */
export function startMusic(): void {
  audio.startMusic();
}

/** 强制分幕：0 平和 / 1 紧张 / 2 高潮；-1 交回按 elapsed 自动分幕。 */
export function setMusicIntensity(level: number): void {
  audio.setMusicIntensity(level);
}

/** 结算淡出（秒）。 */
export function fadeOutMusic(seconds: number): void {
  audio.fadeOutMusic(seconds);
}
