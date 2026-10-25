import { CARDS, cardCdSeconds } from '../content/cards';
import { APP, RUN, VIEW, xpNeed } from '../content/config';
import { PASSIVE_POOL } from '../content/heroSkills';
import type { Game, HandCard, PowerupOption } from '../gameplay/game';

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
  lvEl: HTMLSpanElement;
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
  private readonly hpFill: HTMLDivElement;
  private readonly hpText: HTMLSpanElement;
  /** 详情面板（默认折叠）：属性 / 技能 / 美德。等级、经验、天赋在顶部常驻 */
  private readonly infoEl: HTMLDivElement;
  private readonly infoToggleEl: HTMLButtonElement;
  private readonly heroLvEl: HTMLSpanElement;
  private readonly starText: HTMLSpanElement;
  private readonly starDots: HTMLDivElement;
  /** 顶部血条下方的经验条（v2.9 从详情面板搬回常驻区） */
  private readonly xpFill: HTMLDivElement;
  /** 经验条下方的天赋条：他这局抽到的七美德 */
  private readonly topPerksEl: HTMLDivElement;
  private lastLvText = '';
  private lastXpWidth = '';
  private readonly heroStats: HTMLDivElement;
  private readonly skillsEl: HTMLDivElement;
  private readonly perksEl: HTMLDivElement;
  private readonly handEl: HTMLDivElement;
  private readonly toastEl: HTMLDivElement;
  private readonly levelupEl: HTMLDivElement;
  private readonly levelupLevelEl: HTMLElement;
  private readonly levelupPassiveEl: HTMLElement;
  private levelupTimer = 0;
  private castTimer = 0;
  /** 详情面板是否展开（默认折叠，按 item 9） */
  private infoOpen = false;
  /** 点过「查看锅巴」= 钉住，悬停离开也不收起 */
  private infoPinned = false;
  private infoTimer = 0;
  private tutEl!: HTMLDivElement;
  private tutHoleEl!: HTMLDivElement;
  private tutCardEl!: HTMLDivElement;
  private tutTitleEl!: HTMLElement;
  private tutTextEl!: HTMLElement;
  private tutStepEl!: HTMLElement;
  private tutNextEl!: HTMLButtonElement;
  private tutOn = true;
  private lastSkill = '';
  private readonly perks: string[] = [];
  /** 每条美德叠到几级（重复获得即升级，v2.10） */
  private readonly levels = new Map<string, number>();
  private readonly tooltipEl: HTMLDivElement;
  private tipTarget: HTMLElement | null = null;
  /** 提示需要的数据来自 game，但提示是"用户交互时"才构建的，所以留个引用 */
  private gameRef: Game | null = null;
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
  /** 场景横幅（开局 / 每波 / 结算前的"编排用"字幕） */
  private readonly bannerEl: HTMLDivElement;
  private readonly bannerTitleEl: HTMLElement;
  private readonly bannerSubEl: HTMLElement;
  private bannerTimer = 0;
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
      <button class="hero-info-toggle" data-hero-toggle>查看详情</button>
      <div class="hud-top">
        <div class="timer" data-timer>5:00</div>
        <div class="hero-panel" data-hero-hover>
          <div class="hero-row">
            <span class="hero-name">锅巴</span>
            <span class="hero-lv" data-hero-lv>Lv.1</span>
          </div>
          <div class="hero-hp"><div class="hero-hp-fill" data-hp></div><span class="hero-hp-text" data-hp-text>23800 / 23800</span></div>
          <div class="hero-xp"><div class="hero-xp-fill" data-xp></div></div>
          <div class="hero-perks" data-top-perks></div>
        </div>
      </div>
      <!-- 详情面板：属性与技能。等级、血、经验、天赋都在顶部常驻，这里只补"查得到"的那部分 -->
      <div class="hero-info" data-hero-info hidden>
        <div class="hi-stats" data-hero-stats></div>
        <div class="hi-skills" data-hi-skills></div>
        <div class="hi-perks" data-hero-perks></div>
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
      <button class="btn-mute" data-mute title="静音 (M)">🔊</button>
      <!-- 版本角标：常驻但不抢视线（opacity、pointer-events: none），按用户要求放右下角 -->
      <span class="ver-tag" data-ver-tag>${APP.version}</span>
      <div class="levelup" data-levelup hidden>
        <b data-levelup-level>锅巴 Lv.2</b>
        <span data-levelup-passive>获得：谦逊</span>
      </div>
      <div class="toasts" data-toasts></div>
      <div class="scene-banner" data-banner hidden>
        <b class="banner-title" data-banner-title></b>
        <span class="banner-sub" data-banner-sub></span>
      </div>
      <div class="tutorial" data-tutorial hidden>
        <div class="tut-hole" data-tut-hole></div>
        <div class="tut-card" data-tut-card>
          <b class="tut-title" data-tut-title></b>
          <p class="tut-text" data-tut-text></p>
          <div class="tut-actions">
            <span class="tut-step" data-tut-step></span>
            <button class="tut-skip" data-tut-skip>跳过</button>
            <button class="btn-primary tut-next" data-tut-next>下一步</button>
          </div>
        </div>
      </div>
      <div class="overlay" data-overlay></div>
    `;
    parent.appendChild(this.root);

    this.timerEl = this.must('[data-timer]');
    this.hpFill = this.must('[data-hp]');
    this.hpText = this.must('[data-hp-text]');
    this.heroLvEl = this.must('[data-hero-lv]');
    this.starText = this.must('[data-star]');
    this.starDots = this.must('[data-dots]');
    this.infoEl = this.must('[data-hero-info]');
    this.infoToggleEl = this.must('[data-hero-toggle]');
    this.xpFill = this.must('[data-xp]');
    this.topPerksEl = this.must('[data-top-perks]');
    this.heroStats = this.must('[data-hero-stats]');
    this.skillsEl = this.must('[data-hi-skills]');
    this.perksEl = this.must('[data-hero-perks]');
    this.handEl = this.must('[data-hand]');
    this.toastEl = this.must('[data-toasts]');
    this.levelupEl = this.must('[data-levelup]');
    this.levelupLevelEl = this.must('[data-levelup-level]');
    this.levelupPassiveEl = this.must('[data-levelup-passive]');
    this.overlayEl = this.must('[data-overlay]');
    this.bannerEl = this.must('[data-banner]');
    this.bannerTitleEl = this.must('[data-banner-title]');
    this.bannerSubEl = this.must('[data-banner-sub]');

    this.pauseEl = this.must('[data-pause]');
    this.pauseEl.addEventListener('click', () => this.handlers.onPause());

    // 悬浮提示用独立的一层（挂在 body 上而不是卡片里），
    // 否则会被 .hand 的 overflow 裁掉，也会被卡框贴图盖住。
    this.tooltipEl = document.createElement('div');
    this.tooltipEl.className = 'card-tip';
    this.tooltipEl.hidden = true;
    document.body.appendChild(this.tooltipEl);
    this.muteEl = this.must('[data-mute]');
    this.muteEl.addEventListener('click', () => this.handlers.onToggleMute());

    // 悬停血条看详情，而不是悬停锅巴本体：
    // 本体一直在跑（还会翻滚），鼠标追不上；血条是固定的，玩家想查的时候它一定在原位。
    const hoverZone = this.must('[data-hero-hover]');
    hoverZone.addEventListener('mouseenter', () => {
      if (!this.infoPinned) this.setInfoOpen(true);
    });
    hoverZone.addEventListener('mouseleave', () => {
      if (!this.infoPinned) this.setInfoOpen(false);
    });
    this.infoToggleEl.addEventListener('click', () => {
      this.infoPinned = !this.infoPinned;
      this.setInfoOpen(this.infoPinned);
    });

    // 新手教程：下一步 / 跳过
    this.tutEl = this.must('[data-tutorial]');
    this.tutHoleEl = this.must('[data-tut-hole]');
    this.tutCardEl = this.must('[data-tut-card]');
    this.tutTitleEl = this.must('[data-tut-title]');
    this.tutTextEl = this.must('[data-tut-text]');
    this.tutStepEl = this.must('[data-tut-step]');
    this.tutNextEl = this.must('[data-tut-next]');
    this.tutNextEl.addEventListener('click', () => this.stepTutorial(1));
    this.must('[data-tut-skip]').addEventListener('click', () => this.finishTutorial());

    // 教程开关注在 localStorage：默认开启，关掉就一直是关的
    try {
      const saved = window.localStorage.getItem('guoba.tutorial');
      if (saved !== null) this.tutOn = saved === '1';
    } catch {
      this.tutOn = true;
    }
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
    this.gameRef = game;
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

    // 顶部只留时间（用户："去掉顶部的 XXX 幕, 只显示时间"）——
    // "第几幕"是我自己造的叙事术语，玩家读它得不到任何决策信息，反而占了最贵的一行。
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
    // 详情面板默认折叠（v2.8）：展开时才每 0.25 秒刷一次内容。
    // 不是每帧 —— 这些数字变化很慢，每帧写 DOM 只会白烧软件渲染的预算。
    if (this.infoOpen) {
      this.infoTimer += 1 / 60;
      if (this.infoTimer >= 0.25) {
        this.infoTimer = 0;
        this.renderInfo();
      }
    }

    // 顶部常驻区：等级在名字右侧、经验条在血条下方、天赋在经验条下方（v2.9）
    const lvText = `Lv.${hero.level}`;
    if (lvText !== this.lastLvText) {
      this.lastLvText = lvText;
      this.heroLvEl.textContent = lvText;
    }
    const need = Math.max(1, xpNeed(hero.level));
    const xpPct = need > 0 ? Math.min(100, (hero.xp / need) * 100) : 0;
    const xpWidth = `${xpPct.toFixed(1)}%`;
    if (xpWidth !== this.lastXpWidth) {
      this.lastXpWidth = xpWidth;
      this.xpFill.style.width = xpWidth;
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
        <span class="card-lv"></span>
        <span class="card-name"></span>
        <span class="card-stack"></span>
      `;
      root.addEventListener('click', () => this.handlers.onCard(index));
      // 悬浮提示：玩家根本不知道这些卡是干嘛的（用户反馈），
      // 所以鼠标移上去 / 键盘聚焦 / 移动端点一下都要能看到完整说明。
      const showTip = (): void => {
        const g = this.gameRef;
        const card = g?.hand[index];
        if (g && card) this.showTooltip(root, card, index, g);
      };
      root.addEventListener('pointerenter', (e) => {
        if (e.pointerType === 'mouse') showTip();
      });
      root.addEventListener('pointerleave', (e) => {
        if (e.pointerType === 'mouse') this.hideTooltip();
      });
      // 触屏没有 hover：抬手时顺手把说明弹出来（鼠标用户走上面两条，不受影响）
      root.addEventListener('pointerup', (e) => {
        if (e.pointerType !== 'mouse') showTip();
      });
      root.addEventListener('focus', showTip);
      root.addEventListener('blur', () => this.hideTooltip());
      this.handEl.appendChild(root);
      const art = root.querySelector<HTMLImageElement>('.card-art');
      const cd = root.querySelector<HTMLDivElement>('.card-cd');
      const star = root.querySelector<HTMLSpanElement>('.card-star');
      const lv = root.querySelector<HTMLSpanElement>('.card-lv');
      const name = root.querySelector<HTMLSpanElement>('.card-name');
      const stack = root.querySelector<HTMLSpanElement>('.card-stack');
      if (!art || !cd || !star || !lv || !name || !stack) throw new Error('卡牌节点构建失败');
      this.nodes.push({
        root,
        art,
        cd,
        star,
        lvEl: lv,
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
      // v2.10：还没解锁的卡也摊在手牌里，但整张变暗 + 显示解锁倒计时，点了只会弹提示
      const locked = card.unlockAt > 0;
      node.root.classList.toggle('is-locked', locked);
      if (locked) {
        node.root.classList.remove('ready');
        const left = Math.max(0, Math.ceil(card.unlockAt - (RUN.duration - game.timeLeft)));
        const lockText = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
        if (node.lastCdText !== lockText) {
          node.lastCdText = lockText;
          node.cd.textContent = lockText;
        }
        if (node.lastStack !== 'lock') {
          node.lastStack = 'lock';
          node.stack.textContent = '锁定';
          node.lvEl.textContent = '';
          this.refreshTooltip(node, card, i, game);
        }
        continue;
      }
      // "能不能放"只看充能；cd 只用来画回充进度条（见 cards.ts CARD_STACK）
      node.root.classList.toggle('ready', card.charges > 0);
      const total = cardCdSeconds(card.star);
      const pct = total > 0 ? Math.min(1, Math.max(0, card.cd / total)) : 0;
      const pctText = pct.toFixed(2);
      if (node.lastPct !== pctText) {
        node.lastPct = pctText;
        node.cd.style.setProperty('--p', pctText);
      }
      // 只在"用光正在回充"时才显示秒数：有充能的时候显示倒计时反而像"不能放"
      const cdText = card.charges <= 0 && card.cd > 0 ? card.cd.toFixed(1) : '';
      if (node.lastCdText !== cdText) {
        node.lastCdText = cdText;
        node.cd.textContent = cdText;
      }
      // 充能层数 + 卡牌等级：这两个数字决定"这张牌现在多强、还能放几次"
      const stackText = `${card.charges}/${card.maxCharges}`;
      const lvSuffix = card.level > 1 ? ` ·Lv.${card.level}` : '';
      if (node.lastStack !== stackText + lvSuffix) {
        node.lastStack = stackText + lvSuffix;
        node.stack.textContent = stackText;
        node.lvEl.textContent = card.level > 1 ? `Lv.${card.level}` : '';
        node.root.classList.toggle('spent', card.charges <= 0);
        this.refreshTooltip(node, card, i, game);
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
      const wanted = `${import.meta.env.BASE_URL ?? '/'}art/${def?.art ?? card.id}.png`;
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
   * 「他正在用什么技能」。
   *
   * v2.8 按用户要求把"技能长条"从顶部拿掉了（顶部只留血条），
   * 改成写进左侧详情面板的「最近技能」一行 —— 战场上的技能名飘字仍然是主反馈，
   * 详情面板只在玩家主动展开时才回答"他刚才干了什么"。
   */
  public skillCast(name: string, seconds = 1.2): void {
    this.lastSkill = name;
    this.renderInfo();
    window.clearTimeout(this.castTimer);
    this.castTimer = window.setTimeout(() => {
      this.lastSkill = '';
      this.renderInfo();
    }, seconds * 1000);
  }

  /** 勇者已获得的美德（全部记录，详情面板里逐条列出）。 */
  public pushPerk(name: string, level = 1): void {
    if (!name) return;
    if (!this.perks.includes(name)) this.perks.push(name);
    this.levels.set(name, level);
    this.renderTopPerks();
    this.renderInfo();
  }

  public clearPerks(): void {
    this.perks.length = 0;
    this.levels.clear();
    this.lastSkill = '';
    this.renderTopPerks();
    this.renderInfo();
  }

  /** 详情面板开合（点「查看锅巴」或悬停血条时调用）。 */
  public setInfoOpen(open: boolean): void {
    this.infoOpen = open;
    this.infoEl.hidden = !open;
    this.infoToggleEl.classList.toggle('is-on', open);
    this.infoToggleEl.textContent = open ? '收起' : '查看锅巴';
    if (open) this.renderInfo();
  }

  public toggleInfo(): void {
    this.setInfoOpen(!this.infoOpen);
  }

  /** 教程用的"临时收起详情面板"：教程高亮血条时不该被展开的面板挡住视线 */
  public hideInfo(): void {
    this.infoPinned = false;
    this.setInfoOpen(false);
  }

  public isInfoOpen(): boolean {
    return this.infoOpen;
  }

  /**
   * 详情面板内容：属性 / 最近技能与意图 / 已得美德全称。
   *
   * 用户原话 v2.9："血条显示在中上，名字右侧显示锅巴等级，经验条下方显示锅巴选择的天赋"。
   * 等级、经验、天赋都搬回了常驻 HUD —— 这些是**每一秒都会影响决策**的量；
   * 而"他现在多少攻速、刚才用了什么技能"只在想深挖时才看，所以留在这里按需展开。
   */
  private renderInfo(): void {
    const game = this.gameRef;
    if (!game || !this.infoOpen) return;
    const hero = game.hero;
    this.heroStats.innerHTML = [
      ['生命', `${Math.ceil(hero.hp)} / ${Math.round(hero.maxHp)}`],
      ['攻击', `${Math.round(hero.atk)}`],
      ['攻速', `${hero.atkPerSecond.toFixed(2)}/s`],
      ['护甲', `${Math.round(hero.armor)}`],
      ['移速', `${Math.round(hero.speed)}`],
      ['暴击', `${Math.round(hero.crit * 100)}%`],
    ]
      .map(([k, v]) => `<span class="hi-stat"><i>${k}</i><b>${v}</b></span>`)
      .join('');
    this.skillsEl.innerHTML =
      `<div class="hi-line"><i>最近技能</i><b>${this.lastSkill || '—'}</b></div>` +
      `<div class="hi-line"><i>他的意图</i><b>${hero.intent === 'retreat' ? '撤退' : hero.intent === 'charge' ? '蓄力' : '追击'}</b></div>`;
    this.perksEl.innerHTML =
      this.perks.length === 0
        ? '<div class="hi-empty">还没抽到美德</div>'
        : this.perks
            .map((perk) => {
              const def = PASSIVE_POOL.find((item) => item.name === perk);
              const lv = this.levels.get(perk) ?? 1;
              return `<div class="hi-perk"><b>${perk}${lv > 1 ? ` Lv.${lv}` : ''}</b><span>${def?.desc ?? ''}</span></div>`;
            })
            .join('');
  }

  /**
   * 顶部天赋条：只写美德名字，一句机制留给详情面板。
   * 天赋会越叠越多，全写成句子会把血条挤成三行 —— 名字 + 悬停看全文才是对的密度。
   */
  private renderTopPerks(): void {
    this.topPerksEl.innerHTML =
      this.perks.length === 0
        ? ''
        : this.perks
            .map((perk) => {
              const def = PASSIVE_POOL.find((item) => item.name === perk);
              const lv = this.levels.get(perk) ?? 1;
              const title = def ? `${def.desc}${lv > 1 ? ` ×${lv}` : ''}` : '';
              return `<span class="top-perk${lv > 1 ? ' is-lv' : ''}" title="${title}">${perk}${lv > 1 ? ` ×${lv}` : ''}</span>`;
            })
            .join('');
  }

  /**
   * 升级播报（M3）。toast 会被战斗信息淹掉，
   * 而"他刚刚又变强了"是玩家最需要立刻感知的事，所以单独给一块中屏横幅。
   */
  public levelUp(level: number, passive: string, passiveLevel = 0): void {
    this.levelupLevelEl.textContent = `锅巴 Lv.${level}`;
    this.levelupPassiveEl.textContent = passive
      ? passiveLevel > 1
        ? `获得美德：${passive} Lv.${passiveLevel}`
        : `获得美德：${passive}`
      : '他变强了';
    this.pushPerk(passive);
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

  // ---------------------------------------------------------------- 悬浮提示

  /**
   * 卡牌悬浮说明。
   *
   * 玩家反馈原话：「玩家根本不知道魔物卡的效果」。卡面只有一张图 + 名字 + 星级，
   * 而"远程/肉盾/召唤"这些东西在卡面上看不出来。所以提示里必须回答三件事：
   * 这只怪**怎么打**（标签）、**有多强**（按当前星级算好的实际数值）、
   * 以及**什么时候该拿它**（一句人话）。
   */
  private showTooltip(target: HTMLElement, card: HandCard, index: number, game: Game): void {
    this.tipTarget = target;
    this.tooltipEl.innerHTML = this.tooltipHtml(card, index, game);
    this.tooltipEl.hidden = false;
    this.positionTooltip(target);
  }

  private hideTooltip(): void {
    this.tipTarget = null;
    this.tooltipEl.hidden = true;
  }

  private refreshTooltip(node: CardNode, card: HandCard, index: number, game: Game): void {
    if (this.tipTarget !== node.root) return;
    this.tooltipEl.innerHTML = this.tooltipHtml(card, index, game);
    this.positionTooltip(node.root);
  }

  private tooltipHtml(card: HandCard, index: number, game: Game): string {
    const def = CARDS[card.defIdx];
    if (!def) return '';
    // 数值按"当前星级 × 卡牌等级"算实际值：玩家要看的是这只怪现在到底多少血
    const levelMul = 1 + 0.12 * (card.level - 1);
    const starMul = card.star;
    const hp = Math.round(def.hp * starMul * levelMul);
    const atk = Math.round(def.atk * starMul * levelMul);
    const dps = (atk / def.atkInterval).toFixed(1);
    const units = def.units ?? 1;
    const tags = def.tags.map((tag) => `<i>${tag}</i>`).join('');
    const ready = card.charges > 0
      ? `可放 ${card.charges}/${card.maxCharges} 次`
      : `充能中 ${card.cd.toFixed(1)}s`;
    return `
      <div class="tip-head">
        <b>${def.name}</b>
        <span class="tip-star">★${card.star}</span>
        ${card.level > 1 ? `<span class="tip-lv">Lv.${card.level}</span>` : ''}
      </div>
      <div class="tip-tags">${tags}</div>
      <div class="tip-stats">
        <span>生命 <b>${hp}</b></span>
        <span>攻击 <b>${atk}</b></span>
        <span>攻速 <b>${dps}/s</b></span>
        ${def.armor > 0 ? `<span>护甲 <b>${def.armor}</b></span>` : ''}
        <span>${def.range > 120 ? '射程' : '近战'} <b>${def.range}</b></span>
        <span>占用 <b>${card.star * units}★</b></span>
      </div>
      <div class="tip-note">${def.note}</div>
      <div class="tip-foot">${ready} · 第 ${index + 1} 张 · 放得越多这张卡越强</div>
    `;
  }

  /**
   * v2.9：说明浮在**这张卡的正上方**（用户："魔物卡牌详情悬浮在卡牌上而不是左侧"）。
   *
   * v2.8 曾把它钉在左下角，理由是"鼠标停在手牌上也能看清旁边的卡"；
   * 但那让视线每次都要横跨半个屏幕去核对数字。现在贴着卡走，眼睛不用离开手牌区，
   * 上沿超屏时会翻到卡片下沿，左右超屏时向里收 —— 位置永远可读。
   */
  private positionTooltip(target: HTMLElement): void {
    this.tooltipEl.classList.remove('is-docked');
    this.tooltipEl.style.top = '';
    this.tooltipEl.style.left = '';
    const rect = target.getBoundingClientRect();
    const tip = this.tooltipEl.getBoundingClientRect();
    // v2.9 用户原话："魔物卡牌详情悬浮在卡牌上而不是左侧"。
    // 贴着这张卡的正上方，卡片换了浮层就跟着走 —— 眼睛不用在"卡"和"屏幕左下角"之间来回跳。
    let top = rect.top - tip.height - 12;
    // 上面放不下（窗口很矮）就压到卡片下沿，至少别飞出屏幕
    if (top < 8) top = Math.min(window.innerHeight - tip.height - 8, rect.bottom + 12);
    let left = rect.left + rect.width / 2 - tip.width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tip.width - 8));
    this.tooltipEl.style.top = `${Math.max(8, top)}px`;
    this.tooltipEl.style.left = `${left}px`;
  }

  // ---------------------------------------------------------------- 覆盖层

  public showTitle(): void {
    const base = import.meta.env.BASE_URL;
    this.overlayEl.className = 'overlay is-open title';
    // v2.9 用户原话："去掉主界面面板，改为魔王大厅背景图 + 遮罩 + 标题 + 开始按钮"。
    // 背景直接用仓库里已有的王座与地面贴图：一块面板会把"魔王殿"这件最重要的事盖掉，
    // 而这张大厅图正是玩家第一眼该看到的东西。
    this.overlayEl.innerHTML = `
      <div class="title-stage">
        <div class="title-bg" style="background-image:url('${base}art/throne.png')"></div>
        <div class="title-bg title-bg-floor" style="background-image:url('${base}art/env-floor.png')"></div>
        <div class="title-mask"></div>
        <span class="ver-badge" data-ver>${APP.version}</span>
        <div class="title-inner">
          <h1 class="game-title">${APP.title}</h1>
          <button class="btn-primary title-start" data-start>开始讨伐</button>
          <label class="tut-toggle title-tut">
            <input type="checkbox" data-tut-check${this.tutOn ? ' checked' : ''} />
            <span>新手教程</span>
          </label>
        </div>
      </div>
    `;
    this.overlayEl.querySelector('[data-start]')?.addEventListener('click', () => this.handlers.onStart());
    const check = this.overlayEl.querySelector<HTMLInputElement>('[data-tut-check]');
    check?.addEventListener('change', () => this.setTutorial(check.checked));
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

  // ---------------------------------------------------------------- 新手教程

  /**
   * 新手教程（v2.8，用户原话："当以开启新手教程进入游戏, 会进行显示功能区说明,
   * 然后再正式开始，方便玩家理解，默认开启"）。
   *
   * 做法不是"讲一段话"，而是**指着那块 UI 讲**：每一步都挖一个高亮洞框住真实控件，
   * 世界是暂停的 —— 玩家读完一步，视线已经知道该落在哪儿了。
   * 教程结束回调里才真正开跑，所以"先说明、后开始"的顺序是硬的。
   */
  private readonly tutSteps: readonly { sel: string; title: string; text: string }[] = [
    {
      sel: '[data-hand]',
      title: '① 手牌：这就是你的全部力量',
      text: '点一张卡，再点地面，怪物就出现在那儿。你没有身体，只能靠它们。开局只有史莱姆，之后每多撑一会儿就多一种选择。',
    },
    {
      sel: '.star-budget',
      title: '② 星数：你现在能养多少怪',
      text: '放怪要花星数，这条是已用与上限。上限每 30 秒 +5。0:30 解锁蝙蝠，1:00 哥布林，2:00 石像鬼，3:00 大蜘蛛。',
    },
    {
      sel: '.hero-panel',
      title: '③ 锅巴的血条：你要打空的就是它',
      text: '5 分钟内打到 0 就赢。名字右边是他的等级，血条下面是经验条，经验条下面是他这局抽到的七美德。点左上角「查看详情」看他具体多强。',
    },
    {
      sel: '[data-timer]',
      title: '④ 倒计时：时间到了算你输',
      text: '他杀你的怪会变强，你每 30 秒能三选一「七宗罪权能」变强。比的就是谁长得快。',
    },
  ];
  private tutIdx = 0;
  private tutOnDone: (() => void) | null = null;

  public showTutorial(onDone: () => void): void {
    this.tutIdx = 0;
    this.tutOnDone = onDone;
    this.tutEl.hidden = false;
    this.renderTutorialStep();
  }

  public hideTutorial(): void {
    this.tutEl.hidden = true;
    this.tutOnDone = null;
    this.hideInfo();
  }

  private finishTutorial(): void {
    const done = this.tutOnDone;
    this.tutEl.hidden = true;
    this.tutOnDone = null;
    // 跨模块信号：剧情对白要等教程讲完再开口，否则两段文字会叠在同一块屏幕上
    //（交接板上 GPT 明确要一个"教程完成/占屏结束"的信号，这里就是那个信号）
    document.dispatchEvent(new CustomEvent('guoba:tutorial-done'));
    done?.();
  }

  /** 教程是否正在占屏（剧情/对白接入方可以用它决定要不要等一等）。 */
  public isTutorialOpen(): boolean {
    return this.tutEl.hidden === false;
  }

  private renderTutorialStep(): void {
    const step = this.tutSteps[this.tutIdx];
    if (step === undefined) {
      this.finishTutorial();
      return;
    }
    this.tutTitleEl.textContent = step.title;
    this.tutTextEl.textContent = step.text;
    this.tutNextEl.textContent = this.tutIdx === this.tutSteps.length - 1 ? '开始' : '下一步';
    this.tutStepEl.textContent = `${this.tutIdx + 1} / ${this.tutSteps.length}`;

    const target = this.root.querySelector(step.sel);
    const pad = 10;
    if (target === null) {
      this.tutHoleEl.hidden = true;
      return;
    }
    this.tutHoleEl.hidden = false;
    const r = target.getBoundingClientRect();
    this.tutHoleEl.style.left = `${r.left - pad}px`;
    this.tutHoleEl.style.top = `${r.top - pad}px`;
    this.tutHoleEl.style.width = `${r.width + pad * 2}px`;
    this.tutHoleEl.style.height = `${r.height + pad * 2}px`;

    // 说明卡优先放目标下方；下方没地方就翻到上方，再不行就贴到底部中间
    const cardH = this.tutCardEl.offsetHeight || 170;
    const cardW = this.tutCardEl.offsetWidth || 340;
    const below = r.bottom + pad + 14;
    const above = r.top - pad - 14 - cardH;
    let top = below;
    if (below + cardH > window.innerHeight - 12) top = above > 12 ? above : window.innerHeight - cardH - 12;
    let left = r.left + r.width / 2 - cardW / 2;
    left = Math.max(12, Math.min(window.innerWidth - cardW - 12, left));
    this.tutCardEl.style.left = `${left}px`;
    this.tutCardEl.style.top = `${top}px`;
  }

  private stepTutorial(delta: number): void {
    this.tutIdx += delta;
    if (this.tutIdx < 0) this.tutIdx = 0;
    this.renderTutorialStep();
  }

  /** 标题页的开关：默认开启，选择记在 localStorage（下次进来还是你的选择） */
  public tutorialEnabled(): boolean {
    return this.tutOn;
  }

  private setTutorial(on: boolean): void {
    this.tutOn = on;
    try {
      window.localStorage.setItem('guoba.tutorial', on ? '1' : '0');
    } catch {
      // 隐私模式里 localStorage 会抛异常：设置照样生效，只是记不住
    }
  }

  /**
   * 权能三选一（v2.9 视觉重做）。
   *
   * 用户原话：「权能选择无需面板，只需要遮罩」+「标题为 七宗罪权能」+
   * 「小字 每隔 30 秒，从以下三种权能中选择一种」+「三张全能卡 3:4 比例，
   * 内部为名称和效果描述」+「对于每次星级上限提升和部分节点的新魔物解锁，
   * 以额外效果（紫色文字）追加到描述中，一个效果一行，描述是多行文本」。
   *
   * 去掉面板之后，三张卡直接浮在遮罩上：屏幕只剩"选哪张"这一件事，
   * 不再有一个大框把战场和卡片一起装进去。
   */
  public showPowerup(options: readonly PowerupOption[], extras: readonly string[] = []): void {
    this.hidePowerupWarning();
    this.overlayEl.className = 'overlay is-open powerup';
    // 额外效果是**这一轮全局发生的事**，三张卡都会得到，所以每张卡底部都列一遍：
    // 玩家无论点哪张，这两行都会生效 —— 不写就等于偷偷改了规则。
    const extraLines = extras.map((line) => `<span class="pu-extra">${line}</span>`).join('');
    const cards = options
      .map(
        (opt) => `
        <button class="pu-card" data-opt="${opt.id}" disabled>
          <span class="pu-name">${opt.title}</span>
          <span class="pu-desc">${opt.desc}</span>
          <span class="pu-extras">${extraLines}</span>
        </button>`,
      )
      .join('');
    this.overlayEl.innerHTML = `
      <div class="pu-wrap">
        <h2 class="pu-head">七宗罪权能</h2>
        <p class="pu-sub">每隔 30 秒，从以下三种权能中选择一种</p>
        <div class="pu-row">${cards}</div>
      </div>
    `;
    const buttons = [...this.overlayEl.querySelectorAll<HTMLButtonElement>('[data-opt]')];
    for (const btn of buttons) {
      btn.addEventListener('click', () => {
        const id = btn.dataset['opt'];
        if (id && !btn.disabled) this.handlers.onPowerup(id);
      });
    }
    // 防误触第二道闸：卡片出现后 0.45 秒内不可点（连点/双击不会穿透）。
    // 这和前摇是两件事：前摇防"突然弹出"，这里防"手已经按下"。
    this.overlayEl.classList.add('is-armed-later');
    window.setTimeout(() => {
      for (const btn of buttons) btn.disabled = false;
      this.overlayEl.classList.remove('is-armed-later');
    }, 450);
  }

  /**
   * 场景横幅：一次只显示一件事，到点自己退场。
   *
   * 为什么需要它：一局的节奏是「开局 → 每 30 秒一波 → 结束」，但玩家看到的信息
   * 只有右上角的倒计时在跳。横幅是把"现在发生了什么阶段"**明说出来**的那一层，
   * 也是"更大更强的界面"里最省成本的一环 —— 一句大字比十个数值插件都显眼。
   */
  public sceneBanner(title: string, sub = '', ms = 1700, tone: 'gold' | 'danger' = 'gold'): void {
    this.bannerTimer += 1;
    const stamp = this.bannerTimer;
    this.bannerTitleEl.textContent = title;
    this.bannerSubEl.textContent = sub;
    this.bannerEl.dataset.tone = tone;
    this.bannerEl.hidden = false;
    // 强制重排再加 class，否则连续两次 banner 不会重播动画
    void this.bannerEl.offsetWidth;
    this.bannerEl.classList.add('is-on');
    window.setTimeout(() => {
      if (stamp !== this.bannerTimer) return;
      this.bannerEl.classList.remove('is-on');
      window.setTimeout(() => {
        if (stamp === this.bannerTimer) this.bannerEl.hidden = true;
      }, 260);
    }, ms);
  }

  /** 开局编排：横幅报幕 → 提示怎么玩 → 退场，让第一秒就有"开演了"的感觉。 */
  public playIntro(): void {
    this.sceneBanner('魔王殿', '锅巴还有 5 分钟走到王座', 1500);
    window.setTimeout(() => {
      this.sceneBanner('第 1 波', '点卡 → 点地面 · 把魔物摆在他的路上', 2000);
    }, 1600);
  }

  /**
   * 结算面板。
   *
   * v2.6 把"一行数字 + 一个按钮"改成了三段编排：
   * ① 评级先砸出来（S/A/B/C，纯装饰但玩家会截图）；
   * ② 五条数据错峰数上去（0 → 终值，每行 60ms 间隔），读起来像在结算而不是在读表格；
   * ③ 按钮最后才亮，避免"手还在狂点地面时误触重开"。
   */
  public showResult(won: boolean, game: Game): void {
    const hero = game.hero;
    const elapsed = RUN.duration - game.timeLeft;
    const mm = Math.floor(elapsed / 60);
    const ss = Math.floor(elapsed % 60);
    const hpLeft = hero.maxHp > 0 ? Math.max(0, hero.hp / hero.maxHp) : 0;
    const title = won ? '他倒下了' : '他还是走到了王座前';
    const desc = won
      ? `用时 ${mm}:${ss.toString().padStart(2, '0')} · 剩余 ${Math.ceil(game.timeLeft)} 秒`
      : `倒计时归零，锅巴还剩 ${Math.round(hpLeft * 100)}% 血 —— 这次是你输了`;
    // 评级只看"赢没赢"和"赢得多快"：赢了按用时给 S/A/B，输了固定 C。
    // 不做复杂公式 —— 玩家不需要看懂评分，只需要一个"下一局想拿 S"的念头。
    const grade = !won ? 'C' : elapsed < 120 ? 'S' : elapsed < 200 ? 'A' : 'B';
    const stats: readonly [string, number][] = [
      ['得分', game.score],
      ['锅巴等级', hero.level],
      ['击杀', game.kills],
      ['峰值星数', game.peakStars],
      ['召唤', game.placedTotal],
    ];
    this.overlayEl.className = `overlay is-open ${won ? 'won' : 'lost'}`;
    this.overlayEl.innerHTML = `
      <div class="panel result-panel">
        <div class="grade" data-grade="${grade}">${grade}</div>
        <h2 class="panel-title">${title}</h2>
        <p class="panel-sub">${desc}</p>
        <div class="stats">
          ${stats
            .map(
              ([label, value], i) =>
                `<div style="--i:${i}"><span>${label}</span><b data-count="${value}">0</b></div>`,
            )
            .join('')}
        </div>
        <button class="btn-primary" data-restart disabled>再来一局</button>
      </div>
    `;
    const rows = Array.from(this.overlayEl.querySelectorAll<HTMLElement>('[data-count]'));
    const startAt = performance.now();
    const DURATION = 620;
    const tick = (): void => {
      const k = Math.min(1, (performance.now() - startAt) / DURATION);
      // easeOutCubic：数字先快后慢，最后一格停得住，读得清
      const e = 1 - (1 - k) ** 3;
      for (const row of rows) {
        const target = Number(row.dataset.count ?? 0);
        row.textContent = String(Math.round(target * e));
      }
      if (k < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const btn = this.overlayEl.querySelector<HTMLButtonElement>('[data-restart]');
    window.setTimeout(() => {
      if (btn !== null) btn.disabled = false;
    }, 1100);
    btn?.addEventListener('click', () => this.handlers.onRestart());
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
