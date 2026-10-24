# 音频：100% 程序合成（零音频文件）

> 结论先写：整个游戏**没有一个音频文件**。BGM、音效、打击感全部由 WebAudio
> 在运行时用振荡器 + 噪声 + 滤波器合成。仓库里 `public/` 下没有任何 `.mp3/.ogg/.wav`。

## 为什么这样做

| 方案 | 问题 |
| --- | --- |
| 下载免费的 BGM/SFX 素材 | 授权要写清楚、体积大（一首 1MB 起）、风格还得和可爱 Q 版贴图对得上 |
| 用音频生成 API | 实测音频端点不可用（Suno 403 / TTS 429），而且不稳定 |
| **WebAudio 程序合成** | **0 字节资源、0 授权风险、改一个参数就换风格；代价是要自己写乐理** |

对一个 5 分钟的单局游戏来说，BGM 是"循环垫底 + 随紧张度变化"，音效是"短促反馈"，
两者都适合合成：变化少、需要精确控制、必须和玩法状态同步。

## 结构

```
src/audio/
  engine.ts   # AudioEngine：总线、合成原语、BGM 调度、所有 SFX
  index.ts    # 门面：单例 + 每帧 update(game)，装配层不碰合成细节
```

### 总线

```
music ─┐
       ├─▶ filter(LP) ─▶ compressor ─▶ master ─▶ destination
sfx  ──┘
```

- `master` 静音走 `setMuted`，`music` 在暂停时压到 0.1（不是静音：暂停要"听着还在"）。
- 所有音都过一个低通 + 压缩器：几十个音同时响时不会糊成一团白噪音。

### BGM

- **120 BPM，D 弗里几亚（D Phrygian）**，16 分音符一格，4 小节一循环。
- 三个声部：低音（方波 + 长包络）、和声垫（三角波，慢起）、打击（噪声 + 短包络）。
- `setUrgency(0..1)` 按剩余时间/血量推：越靠后，越密、越亮，告诉玩家"要决战了"。
- 通过 `AudioContext.currentTime` 提前调度（lookahead），不靠 `setInterval` 卡点。

### SFX 一览

| 事件 | 声音设计 |
| --- | --- |
| `onSpawn(star)` | 召唤：下坠的低频 + 噪声扫频；星级越高越低越响 |
| `onDeath()` | 短促破裂（噪声 + 高通），不抢戏 |
| `onHeroHurt()` | 闷响 + 轻微失真，提示"我打到了" |
| `onHeroLevel()` | 上行三音（D-F-A），这是玩家最需要听见的"他变强了" |
| `onSwing()` | 快速空气声（弹弓释放复用） |
| `onQi()` | 剑气：带通噪声 + 快速下扫 |
| `onDetonate()` | 爆米花弹/范围爆炸：低频冲击 + 噪声尾 |
| `onPowerupOpen/Close` | 权能面板开合：纸片感的短促音 |
| `onFinish(won)` | 胜利上行 / 失败下行 |

## 浏览器策略（重要）

- **不创建 AudioContext 直到用户手势**（点「开始讨伐」）。否则 Chrome 会把它挂成
  `suspended`，之后所有调度都静默失败。
- 移动端 iOS 需要在手势回调里 `resume()`；`engine.ts` 在首次 `start` 时做这件事。
- 静音状态存在 `setMuted`，暂停时 BGM 压低而不是停掉（回来时不用重启）。

## 怎么验证（不要靠耳朵猜）

```powershell
node tools/audio-probe.mjs
```

它做三件事：

1. 在页面脚本运行前劫持 `AudioContext`，统计 `createOscillator/createGain` 的调用次数。
2. **安静窗口**（场上没有魔物）3 秒内必须有振荡器被调度 —— 这一段只可能是 BGM，
   用它证明"BGM 真的在跑"，而不是被战斗音效凑数。
3. 再放 6 只怪，统计战斗音效的调度增量。

输出形如：

```
  ok   安静时 BGM 在调度 — 安静 3 秒 +13 oscillators
  ok   战斗音效被调度 — +20 oscillators
AUDIO PASS
```

> 无头浏览器里 `AudioContext.state` 可能不是 `running`，所以断言只看**调度次数**，
> 不看状态 —— 状态在真机上由用户手势决定，headless 里不可控。

## 移动端

- 手感相关：`src/style-mobile.css` 只压尺寸、不加结构，见 `node tools/mobile-probe.mjs`。
- 音频相关：iOS Safari 首次播放必须在 `pointerdown` 里；游戏是"点开始按钮"进局，天然满足。
- 音量：手机外放小，`master` 默认 0.85，`music` 0.42，`sfx` 0.9（实测外放能听清 BGM 和打击）。

## 已知取舍

- 没有 3D 空间音：俯视 2D 里左右声道定位的收益不如"每个事件一个明确的音色"。
- 没有动态混音（ducking）：权能面板打开时世界减速，BGM 已经足够安静，再压反而突兀。
