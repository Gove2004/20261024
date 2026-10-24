import { CARDS, cardCdSeconds } from '../content/cards';
import { RUN, VIEW } from '../content/config';
import type { Game, PowerupOption } from '../gameplay/game';

export interface HudHandlers {
  onStart(): void;
  onRestart(): void;
  onCard(index: number): void;
  onPowerup(id: string): void;
  onPause(): void;
}

interface CardNode {
  root: HTMLButtonElement;
  cd: HTMLDivElement;
  star: HTMLSpanElement;
  name: HTMLSpanElement;
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
  private readonly handEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly overlayEl: HTMLDivElement;
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
        </div>
        <div class="timer-sub">打不死他，5 分钟就到</div>
      </div>
      <div class="hud-bottom">
        <div class="star-budget">
          <span class="star-label">星数</span>
          <span class="star-text" data-star>0 / 10</span>
          <div class="star-dots" data-dots></div>
        </div>
        <div class="hand" data-hand></div>
      </div>
      <button class="btn-pause" data-pause title="暂停 (Space)">❚❚</button>
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
    this.handEl = this.must('[data-hand]');
    this.toastEl = this.must('[data-toasts]');
    this.overlayEl = this.must('[data-overlay]');

    this.must('[data-pause]').addEventListener('click', () => this.handlers.onPause());
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
    this.timerEl.textContent = `${mm}:${ss.toString().padStart(2, '0')}`;
    this.timerEl.classList.toggle('urgent', timeLeft <= RUN.finalWarnAt);
    this.timerEl.classList.toggle('warn', timeLeft <= RUN.warnAt && timeLeft > RUN.finalWarnAt);

    const elapsed = RUN.duration - timeLeft;
    this.phaseEl.textContent =
      elapsed < 100 ? '第一幕 · 试探' : elapsed < 200 ? '第二幕 · 反扑' : '第三幕 · 决战';

    const hero = game.hero;
    const ratio = hero.hpRatio;
    this.hpFill.style.width = `${(ratio * 100).toFixed(2)}%`;
    this.hpFill.classList.toggle('low', ratio <= 0.25);
    this.hpText.textContent = `${Math.ceil(hero.hp)} / ${Math.round(hero.maxHp)}`;
    this.lvEl.textContent = `Lv.${hero.level}`;
    this.intentEl.textContent =
      hero.intent === 'retreat' ? '撤退' : hero.intent === 'charge' ? '蓄力' : '追击';
    this.intentEl.dataset['intent'] = hero.intent;

    this.starText.textContent = `${game.occupiedStars} / ${game.starCap}`;
    this.starDots.style.setProperty('--ratio', String(game.starCap > 0 ? game.occupiedStars / game.starCap : 0));

    this.syncCards(game);
  }

  private syncCards(game: Game): void {
    while (this.nodes.length < game.hand.length) {
      const index = this.nodes.length;
      const root = document.createElement('button');
      root.className = 'card';
      root.dataset['idx'] = String(index);
      root.innerHTML = `
        <div class="card-cd"></div>
        <span class="card-star"></span>
        <span class="card-name"></span>
      `;
      root.addEventListener('click', () => this.handlers.onCard(index));
      this.handEl.appendChild(root);
      const cd = root.querySelector<HTMLDivElement>('.card-cd');
      const star = root.querySelector<HTMLSpanElement>('.card-star');
      const name = root.querySelector<HTMLSpanElement>('.card-name');
      if (!cd || !star || !name) throw new Error('卡牌节点构建失败');
      this.nodes.push({ root, cd, star, name });
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
      node.cd.style.setProperty('--p', pct.toFixed(3));
      node.cd.textContent = card.cd > 0 ? card.cd.toFixed(1) : '';
      node.root.classList.toggle('disp', def?.shape === 'blob');
    }
  }

  // ---------------------------------------------------------------- 提示

  public toast(text: string, kind: 'info' | 'good' | 'bad' = 'info'): void {
    const el = document.createElement('div');
    el.className = `toast toast-${kind}`;
    el.textContent = text;
    this.toastEl.appendChild(el);
    window.setTimeout(() => el.remove(), 1700);
    if (this.toastEl.childElementCount > 5) this.toastEl.firstElementChild?.remove();
  }

  // ---------------------------------------------------------------- 覆盖层

  public showTitle(): void {
    this.overlayEl.className = 'overlay is-open';
    this.overlayEl.innerHTML = `
      <div class="panel title-panel">
        <h1 class="game-title">锅巴必须死</h1>
        <p class="subtitle">反向肉鸽 · 你就是魔王</p>
        <ul class="rules">
          <li>你没有身体，也打不了 —— 只能<b>把魔物放到画面里</b></li>
          <li>锅巴会一路杀穿，每杀一只就变强一级</li>
          <li>每张卡有 <b>1–10 星</b>，星级既是强度，也是占地</li>
          <li><b>5 分钟内把他打死</b>，否则时间到就算你输</li>
        </ul>
        <button class="btn-primary" data-start>开始讨伐</button>
        <p class="hint">点卡 → 点地面召唤 · 双击魔物引爆 · 空格暂停</p>
      </div>
    `;
    this.overlayEl.querySelector('[data-start]')?.addEventListener('click', () => this.handlers.onStart());
  }

  public showPowerup(options: readonly PowerupOption[]): void {
    this.overlayEl.className = 'overlay is-open powerup';
    const cards = options
      .map(
        (opt) => `
        <button class="powerup-card" data-opt="${opt.id}">
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
      </div>
    `;
    for (const btn of this.overlayEl.querySelectorAll<HTMLElement>('[data-opt]')) {
      btn.addEventListener('click', () => {
        const id = btn.dataset['opt'];
        if (id) this.handlers.onPowerup(id);
      });
    }
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
          <div><span>引爆</span><b>${game.detonations}</b></div>
        </div>
        <button class="btn-primary" data-restart>再来一局</button>
      </div>
    `;
    this.overlayEl.querySelector('[data-restart]')?.addEventListener('click', () => this.handlers.onRestart());
  }

  public hideOverlay(): void {
    this.overlayEl.className = 'overlay';
    this.overlayEl.innerHTML = '';
  }

  public setVisible(visible: boolean): void {
    this.root.classList.toggle('hidden', !visible);
  }

  /** 设计像素坐标（1280×720） */
  public static designSize = VIEW;
}
