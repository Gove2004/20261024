import { CARDS, cardCdSeconds } from '../content/cards';
import { RUN, VIEW, xpNeed } from '../content/config';
import type { Game, PowerupOption } from '../gameplay/game';

export interface HudHandlers {
  onStart(): void;
  onRestart(): void;
  onCard(index: number): void;
  onPowerup(id: string): void;
  onPause(): void;
  onToggleMute(): void;
}

interface CardNode {
  root: HTMLButtonElement;
  art: HTMLImageElement;
  cd: HTMLDivElement;
  star: HTMLSpanElement;
  name: HTMLSpanElement;
  stack: HTMLSpanElement;
  /** 上一次写入的值（只在这些值变化时才碰 DOM） */
  lastPct: string;
  lastCdText: string;
  lastReady: boolean;
  lastSelected: boolean;
  lastStack: string;
  lastName: string;
  lastStar: string;
  lastDisp: boolean;
}

/**
 * HUD 走 DOM 而不是 Pixi：文字排版、字体回退、无障碍都免费拿到，
 * 而且不会跟着相机缩放。原则是「0.5 秒内答得出三个问题」：
 * 他还有多少血 / 我还能放几星 / 哪张卡好了。
 */
export class Hud {
  private readonly root: HTMLDivElement;
  private readonly timerEl: HTMLDivElement;
  private readonly phaseEl: HTMLDivElement;
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  private readonly lvEl: HTMLSpanElement;
  private readonly intentEl: HTMLSpanElement;
  private readonly starText: HTMLSpanElement;
  private readonly starDots: HTMLDivElement;
  private readonly xpFill: HTMLDivElement;
  private readonly xpText: HTMLSpanElement;
  private readonly heroStats: HTMLDivElement;
  private readonly pStar: HTMLElement;
  private readonly pCd: HTMLElement;
  private readonly pPlaced: HTMLElement;
  private readonly pKills: HTMLElement;
  private readonly handEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly levelupEl: HTMLDivElement;
  private readonly levelupLevelEl: HTMLElement;
  private readonly levelupPassiveEl: HTMLElement;
  private levelupTimer = 0;
  private muteEl!: HTMLButtonElement;
  private pauseEl!: HTMLButtonElement;
  private lastToast: { text: string; at: number; el: HTMLElement } | null = null;
  /** 上一帧写进 DOM 的值：一样就不写，避免软件渲染下整块 HUD 每帧重新合成 */
  private lastTimer = '';
  private lastPhase = '';
  private lastHpPct = '';
  private lastHpText = '';
  private lastLv = '';
  private lastXpPct = '';
  private lastXpText = '';
  private lastHeroStats = '';
  private lastPower = '';
  private lastIntent = '';
  private lastStarText = '';
  private lastStarRatio = '';
  private lastUrgent = false;
  private lastWarn = false;
  private lastLow = false;
  private readonly overlayEl: HTMLDivElement;
  /** 权能预告条（懒创建，见 showPowerupWarning） */
  private warnEl: HTMLDivElement | null = null;
  private readonly nodes: CardNode[] = [];

  constructor(
    parent: HTMLElement,
    private readonly handlers: HudHandlers,
  ) {
    this.root = document.createElement('div');
    this.root.className = 'hud';
    this.root.innerHTML = `
      <div class="hud-top">
        <div class="phase" data-phase>第一幕 · 试探</div>
        <div class="timer" data-timer>5:00</div>
        <div class="hero-panel">
          <div class="hero-row">
            <span class="hero-name">锅巴</span>
            <span class="hero-lv" data-lv>Lv.1</span>
            <span class="hero-intent" data-intent>追击</span>
          </div>
          <div class="hero-hp"><div class="hero-hp-fill" data-hp></div><span class="hero-hp-text" data-hp-text>12000 / 12000</span></div>
          <div class="hero-xp" title="他杀怪升级：经验条满了就 Lv+1，回一点血、天赋更强">
            <div class="hero-xp-fill" data-xp></div>
            <span class="hero-xp-text" data-xp-text>Lv.1 · 0%</span>
          </div>
          <div class="hero-stats" data-hero-stats></div>
        </div>
        <div class="timer-sub">打不死他，5 分钟就到</div>
      </div>
      <div class="hud-bottom">
        <div class="star-budget">
          <span class="star-label">星数</span>
          <span class="star-text" data-star>0 / 10</span>
          <div class="star-dots" data-dots></div>
        </div>
        <div class="power-panel" data-power>
          <span class="power-row"><i>星数上限</i><b data-p-star>10</b></span>
          <span class="power-row"><i>冷却缩减</i><b data-p-cd>0%</b></span>
          <span class="power-row"><i>已召唤</i><b data-p-placed>0</b></span>
          <span class="power-row"><i>击杀</i><b data-p-kills>0</b></span>
        </div>
        <div class="hint-bar" data-hint>点卡 → 点地面召唤 · 他能远程射你摆的怪</div>
        <div class="hand" data-hand></div>
      </div>
      <button class="btn-pause" data-pause title="暂停 (Space)">❚❚</button>
      <button class="btn-mute" data-mute title="静音 (M)">🔊</button>
      <div class="levelup" data-levelup hidden>
        <b data-levelup-level>锅巴 Lv.2</b>
        <span data-levelup-passive>获得：力量 +8%</span>
      </div>
      <div class="toasts" data-toasts></div>
      <div class="overlay" data-overlay></div>
    `;
    parent.appendChild(this.root);

    this.timerEl = this.must('[data-timer]');
    this.phaseEl = this.must('[data-phase]');
    this.hpFill = this.must('[data-hp]');
    this.hpText = this.must('[data-hp-text]');
    this.lvEl = this.must('[data-lv]');
    this.intentEl = this.must('[data-intent]');
    this.starText = this.must('[data-star]');
    this.starDots = this.must('[data-dots]');
    this.xpFill = this.must('[data-xp]');
    this.xpText = this.must('[data-xp-text]');
    this.heroStats = this.must('[data-hero-stats]');
    this.pStar = this.must('[data-p-star]');
    this.pCd = this.must('[data-p-cd]');
    this.pPlaced = this.must('[data-p-placed]');
    this.pKills = this.must('[data-p-kills]');
    this.handEl = this.must('[data-hand]');
    this.toastEl = this.must('[data-toasts]');
    this.levelupEl = this.must('[data-levelup]');
    this.levelupLevelEl = this.must('[data-levelup-level]');
    this.levelupPassiveEl = this.must('[data-levelup-passive]');
    this.overlayEl = this.must('[data-overlay]');

    this.pauseEl = this.must('[data-pause]');
    this.pauseEl.addEventListener('click', () => this.handlers.onPause());
    this.muteEl = this.must('[data-mute]');
    this.muteEl.addEventListener('click', () => this.handlers.onToggleMute());
  }

  /** 静音按钮的图标由这里翻，避免"点了没反应"的观感。 */
  public setMuted(muted: boolean): void {
    this.muteEl.textContent = muted ? '🔇' : '🔊';
    this.muteEl.classList.toggle('is-off', muted);
    this.muteEl.title = muted ? '已静音 (M)' : '静音 (M)';
  }

  private must<T extends HTMLElement>(selector: string): T {
    const el = this.root.querySelector<T>(selector);
    if (!el) throw new Error(`HUD 缺少元素: ${selector}`);
    return el;
  }

  // ---------------------------------------------------------------- 主更新

  public update(game: Game): void {
    const timeLeft = Math.max(0, game.timeLeft);
    const mm = Math.floor(timeLeft / 60);
    const ss = Math.floor(timeLeft % 60);
    const timerText = `${mm}:${ss.toString().padStart(2, '0')}`;
    // 只在"这一帧真的变了"时写 DOM。软件渲染下每帧无条件改样式
    // 会强制整块 HUD 重新合成（实测把帧率从 34 压到 10）。
    if (timerText !== this.lastTimer) {
      this.lastTimer = timerText;
      this.timerEl.textContent = timerText;
    }
    const urgent = timeLeft <= RUN.finalWarnAt;
    const warn = timeLeft <= RUN.warnAt && !urgent;
    if (urgent !== this.lastUrgent) {
      this.lastUrgent = urgent;
      this.timerEl.classList.toggle('urgent', urgent);
    }
    if (warn !== this.lastWarn) {
      this.lastWarn = warn;
      this.timerEl.classList.toggle('warn', warn);
    }

    const elapsed = RUN.duration - timeLeft;
    const phase = elapsed < 100 ? '第一幕 · 试探' : elapsed < 200 ? '第二幕 · 反扑' : '第三幕 · 决战';
    if (phase !== this.lastPhase) {
      this.lastPhase = phase;
      this.phaseEl.textContent = phase;
    }

    const hero = game.hero;
    const ratio = hero.hpRatio;
    const hpPct = (ratio * 100).toFixed(2);
    if (hpPct !== this.lastHpPct) {
      this.lastHpPct = hpPct;
      this.hpFill.style.width = `${hpPct}%`;
    }
    const low = ratio <= 0.25;
    if (low !== this.lastLow) {
      this.lastLow = low;
      this.hpFill.classList.toggle('low', low);
    }
    const hpText = `${Math.ceil(hero.hp)} / ${Math.round(hero.maxHp)}`;
    if (hpText !== this.lastHpText) {
      this.lastHpText = hpText;
      this.hpText.textContent = hpText;
    }
    const lvText = `Lv.${hero.level}`;
    if (lvText !== this.lastLv) {
      this.lastLv = lvText;
      this.lvEl.textContent = lvText;
    }

    // 经验条：血条下面这一条回答"他还要多久变强"。
    // 玩家最需要预判的就是这个 —— 他升级会回血、会多一个天赋。
    const xpRatio = Math.max(0, Math.min(1, hero.xp / Math.max(1, xpNeed(hero.level))));
    const xpPct = (xpRatio * 100).toFixed(1);
    if (xpPct !== this.lastXpPct) {
      this.lastXpPct = xpPct;
      this.xpFill.style.width = `${xpPct}%`;
    }
    const xpText = `Lv.${hero.level} · ${Math.floor(xpRatio * 100)}%`;
    if (xpText !== this.lastXpText) {
      this.lastXpText = xpText;
      this.xpText.textContent = xpText;
    }

    // 基础属性：势均力敌的对抗里，玩家必须能读到"上限"和"减 CD"的变化
    const statsText = `攻速 ${hero.atkPerSecond.toFixed(2)}/s · 移速 ${Math.round(hero.speed)} · 护甲 ${Math.round(hero.armor)}`;
    if (statsText !== this.lastHeroStats) {
      this.lastHeroStats = statsText;
      this.heroStats.textContent = statsText;
    }
    const powerText = `${game.starCap}|${game.cdReductionPercent}|${game.placedTotal}|${game.kills}`;
    if (powerText !== this.lastPower) {
      this.lastPower = powerText;
      const [cap, cd, placed, kills] = powerText.split('|');
      this.pStar.textContent = cap ?? '';
      this.pCd.textContent = `${cd}%`;
      this.pPlaced.textContent = placed ?? '';
      this.pKills.textContent = kills ?? '';
    }
    const intentText = hero.intent === 'retreat' ? '撤退' : hero.intent === 'charge' ? '蓄力' : '追击';
    if (intentText !== this.lastIntent) {
      this.lastIntent = intentText;
      this.intentEl.textContent = intentText;
      this.intentEl.dataset['intent'] = hero.intent;
    }

    const starText = `${game.occupiedStars} / ${game.starCap}`;
    if (starText !== this.lastStarText) {
      this.lastStarText = starText;
      this.starText.textContent = starText;
    }
    const starRatio = String(game.starCap > 0 ? game.occupiedStars / game.starCap : 0);
    if (starRatio !== this.lastStarRatio) {
      this.lastStarRatio = starRatio;
      this.starDots.style.setProperty('--ratio', starRatio);
    }

    this.syncCards(game);
  }

  private syncCards(game: Game): void {
    while (this.nodes.length < game.hand.length) {
      const index = this.nodes.length;
      const root = document.createElement('button');
      root.className = 'card';
      root.dataset['idx'] = String(index);
      root.innerHTML = `
        <img class="card-art" alt="" draggable="false" />
        <div class="card-cd"></div>
        <span class="card-star"></span>
        <span class="card-name"></span>
        <span class="card-stack"></span>
      `;
      root.addEventListener('click', () => this.handlers.onCard(index));
      this.handEl.appendChild(root);
      const art = root.querySelector<HTMLImageElement>('.card-art');
      const cd = root.querySelector<HTMLDivElement>('.card-cd');
      const star = root.querySelector<HTMLSpanElement>('.card-star');
      const name = root.querySelector<HTMLSpanElement>('.card-name');
      const stack = root.querySelector<HTMLSpanElement>('.card-stack');
      if (!art || !cd || !star || !name || !stack) throw new Error('卡牌节点构建失败');
      this.nodes.push({
        root,
        art,
        cd,
        star,
        name,
        stack,
        lastPct: '',
        lastCdText: '',
        lastReady: true,
        lastSelected: false,
        lastName: '',
        lastStar: '',
        lastDisp: false,
        lastStack: '',
      });
    }

    for (let i = 0; i < this.nodes.length; i += 1) {
      const node = this.nodes[i];
      const card = game.hand[i];
      if (!node) continue;
      if (!card) {
        node.root.style.display = 'none';
        continue;
      }
      node.root.style.display = '';
      const def = CARDS[card.defIdx];
      node.name.textContent = def?.name ?? card.id;
      node.star.textContent = `★${card.star}`;
      node.root.classList.toggle('selected', game.selected === i);
      node.root.classList.toggle('ready', card.cd <= 0);
      const total = cardCdSeconds(card.star);
      const pct = total > 0 ? Math.min(1, Math.max(0, card.cd / total)) : 0;
      const pctText = pct.toFixed(2);
      if (node.lastPct !== pctText) {
        node.lastPct = pctText;
        node.cd.style.setProperty('--p', pctText);
      }
      const cdText = card.cd > 0 ? card.cd.toFixed(1) : '';
      if (node.lastCdText !== cdText) {
        node.lastCdText = cdText;
        node.cd.textContent = cdText;
      }
      // 通量：把「这张牌还剩几次」直接印在卡面上 —— 堆叠之后玩家最需要知道的就是这个
      const stackText = `${card.charges}/${card.maxCharges}`;
      if (node.lastStack !== stackText) {
        node.lastStack = stackText;
        node.stack.textContent = stackText;
        node.root.classList.toggle('spent', card.charges <= 0);
      }
      const ready = card.charges > 0;
      if (node.lastReady !== ready) {
        node.lastReady = ready;
        node.root.classList.toggle('ready', ready);
      }
      const selected = game.selected === i;
      if (node.lastSelected !== selected) {
        node.lastSelected = selected;
        node.root.classList.toggle('selected', selected);
      }
      const nameText = def?.name ?? card.id;
      if (node.lastName !== nameText) {
        node.lastName = nameText;
        node.name.textContent = nameText;
      }
      const starLabel = `★${card.star}`;
      if (node.lastStar !== starLabel) {
        node.lastStar = starLabel;
        node.star.textContent = starLabel;
      }
      const shapeCls = def?.shape === 'blob';
      if (node.lastDisp !== shapeCls) {
        node.lastDisp = shapeCls;
        node.root.classList.toggle('disp', shapeCls);
      }
      // 卡面直接用游戏内贴图：玩家在卡上看到的和场上看到的必须是同一只怪
      const wanted = `${import.meta.env.BASE_URL ?? '/'}art/${card.id}.png`;
      if (node.art.getAttribute('src') !== wanted) node.art.src = wanted;
      node.art.style.display = '';
    }
  }

  // ---------------------------------------------------------------- 提示

  public toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    // 同一句话 1.2 秒内重复就只刷新旧的那条：右侧一列"锅巴吃了干粮 ×5"
    // 会把战场糊住（评审明确点了"右侧战斗日志杂乱"）。
    const last = this.lastToast;
    if (last && last.text === text && Date.now() - last.at < 1200 && last.el.isConnected) {
      last.at = Date.now();
      last.el.classList.remove('is-bump');
      void last.el.offsetWidth;
      last.el.classList.add('is-bump');
      return;
    }
    if (last?.el.isConnected) last.el.classList.remove('is-bump');

    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    this.toastEl.appendChild(el);
    this.lastToast = { text, at: Date.now(), el };
    window.setTimeout(() => el.remove(), 1500);
    // 三条就够了：超出的是噪音，不是信息
    if (this.toastEl.childElementCount > 3) this.toastEl.firstElementChild?.remove();
  }

  /**
   * 升级播报（M3）。toast 会被战斗信息淹掉，
   * 而"他刚刚又变强了"是玩家最需要立刻感知的事，所以单独给一块中屏横幅。
   */
  public levelUp(level: number, passive: string): void {
    this.levelupLevelEl.textContent = `锅巴 Lv.${level}`;
    this.levelupPassiveEl.textContent = passive ? `获得被动：${passive}` : '他变强了';
    this.levelupEl.hidden = false;
    this.levelupEl.classList.remove('is-in');
    // 强制重排，让同一次升级连发时动画能重播
    void this.levelupEl.offsetWidth;
    this.levelupEl.classList.add('is-in');
    window.clearTimeout(this.levelupTimer);
    this.levelupTimer = window.setTimeout(() => {
      this.levelupEl.classList.remove('is-in');
      this.levelupEl.hidden = true;
    }, 1900);
  }

  // ---------------------------------------------------------------- 覆盖层

  public showTitle(): void {
    this.overlayEl.className = 'overlay is-open';
    this.overlayEl.innerHTML = `
      <div class="panel title-panel">
        <img class="title-hero" src="${import.meta.env.BASE_URL}art/guoba.png" alt="勇者锅巴" />
        <h1 class="game-title">锅巴必须死</h1>
        <p class="subtitle">反向肉鸽 · 你是魔王，他是勇者锅巴</p>
        <ul class="rules">
          <li>你没有身体，也打不了 —— 只能<b>把魔物放到画面里</b></li>
          <li>勇者<span class="rule-name">锅巴</span>会一路杀穿，每杀一只就变强一级</li>
          <li>每张卡有 <b>1–10 星</b>，星级既是强度，也是占地</li>
          <li><b>5 分钟内把他打死</b>，否则时间到就算你输</li>
        </ul>
        <button class="btn-primary" data-start>开始讨伐</button>
        <p class="hint">点卡 → 点地面召唤 · 空格暂停 · M 静音</p>
      </div>
    `;
    this.overlayEl.querySelector('[data-start]')?.addEventListener('click', () => this.handlers.onStart());
  }

  /**
   * 权能预告（面板弹出前的前摇）。
   * 玩家此刻手还按在场地上点召唤，直接弹三选一会被"顺手"点掉最上面那张，
   * 所以先出 1.1 秒的预告条：世界照常跑，玩家能把手收回来。
   */
  public showPowerupWarning(seconds: number): void {
    if (this.warnEl === null) {
      this.warnEl = document.createElement('div');
      this.warnEl.className = 'powerup-warn';
      this.warnEl.setAttribute('aria-live', 'polite');
      document.body.appendChild(this.warnEl);
    }
    this.warnEl.innerHTML = `
      <span class="powerup-warn-ring"></span>
      <span class="powerup-warn-text">权能降临</span>
      <span class="powerup-warn-sub">${seconds.toFixed(1)}s 后暂停世界</span>
    `;
    this.warnEl.classList.add('is-on');
  }

  private hidePowerupWarning(): void {
    this.warnEl?.classList.remove('is-on');
  }

  public showPowerup(options: readonly PowerupOption[]): void {
    this.hidePowerupWarning();
    this.overlayEl.className = 'overlay is-open powerup';
    const cards = options
      .map(
        (opt) => `
        <button class="powerup-card" data-opt="${opt.id}" disabled>
          <span class="powerup-title">${opt.title}</span>
          <span class="powerup-desc">${opt.desc}</span>
        </button>`,
      )
      .join('');
    this.overlayEl.innerHTML = `
      <div class="panel">
        <h2 class="panel-title">魔王权能</h2>
        <p class="panel-sub">三选一 · 世界已为你暂停</p>
        <div class="powerup-row">${cards}</div>
        <div class="powerup-hold"><span class="powerup-hold-fill"></span></div>
      </div>
    `;
    const buttons = [...this.overlayEl.querySelectorAll<HTMLButtonElement>('[data-opt]')];
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        const id = btn.dataset['opt'];
        if (id && !btn.disabled) this.handlers.onPowerup(id);
      });
    }
    // 防误触第二道闸：面板出现后 0.45 秒内按钮不可点（连点/双击不会穿透）。
    // 这和上面的前摇是两件事：前摇防"突然弹出"，这里防"手已经按下"。
    this.overlayEl.classList.add('is-armed-later');
    window.setTimeout(() => {
      for (const btn of buttons) btn.disabled = false;
      this.overlayEl.classList.remove('is-armed-later');
    }, 450);
  }

  public showResult(won: boolean, game: Game): void {
    const hero = game.hero;
    const elapsed = RUN.duration - game.timeLeft;
    const mm = Math.floor(elapsed / 60);
    const ss = Math.floor(elapsed % 60);
    const title = won ? '他倒下了' : '他还是走到了王座前';
    const desc = won
      ? `用时 ${mm}:${ss.toString().padStart(2, '0')} · 剩余 ${Math.ceil(game.timeLeft)} 秒`
      : '倒计时归零，锅巴还站着 —— 这次是你输了';
    this.overlayEl.className = `overlay is-open ${won ? 'won' : 'lost'}`;
    this.overlayEl.innerHTML = `
      <div class="panel">
        <h2 class="panel-title">${title}</h2>
        <p class="panel-sub">${desc}</p>
        <div class="stats">
          <div><span>得分</span><b>${game.score}</b></div>
          <div><span>锅巴</span><b>Lv.${hero.level}</b></div>
          <div><span>击杀</span><b>${game.kills}</b></div>
          <div><span>峰值星数</span><b>${game.peakStars}</b></div>
          <div><span>召唤</span><b>${game.placedTotal}</b></div>
        </div>
        <button class="btn-primary" data-restart>再来一局</button>
      </div>
    `;
    this.overlayEl.querySelector('[data-restart]')?.addEventListener('click', () => this.handlers.onRestart());
  }

  /**
   * 暂停面板。
   *
   * 之前"暂停"只是把 `game.state` 设成 paused —— 逻辑确实停了，但画面上什么都没变，
   * 玩家点下去只会觉得"按钮坏了"（用户实测反馈原话：暂停按钮貌似无法使用）。
   * 任何一个会停掉游戏的操作，都必须给出可见的反馈。
   */
  public showPause(): void {
    this.overlayEl.className = 'overlay is-open pause';
    this.pauseEl.classList.add('is-paused');
    this.pauseEl.textContent = '▶';
    this.overlayEl.innerHTML = `
      <div class="panel pause-panel" data-resume>
        <div class="pause-icon">❚❚</div>
        <div class="pause-title">已暂停</div>
        <div class="pause-sub">点这里或按空格继续 · 卡牌冷却也跟着停了</div>
      </div>
    `;
    this.overlayEl.querySelector('[data-resume]')?.addEventListener('click', () => this.handlers.onPause());
  }

  public hideOverlay(): void {
    this.pauseEl.classList.remove('is-paused');
    this.pauseEl.textContent = '❚❚';
    this.overlayEl.className = 'overlay';
    this.overlayEl.innerHTML = '';
  }

  public setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /** 设计像素坐标（1280×720） */
  public static designSize = VIEW;
}
