// 社区计算器（hbr-calculator.com，2026-11-08 读取的前端代码）里的规则常数。
// 本目录按它的算法重写：伤害 = Calculator 模块；回合（SP/OD/持续时间/追加回合）= Planner 模块。
// 常数名后的注释写明在原代码中的含义，便于对照；游戏实测校对后在此修改并记入 STATUS。

export const STATS=['str','dex','con','wis','spr','luk'];
export const DEFAULT_STATS=Object.freeze({str:400,dex:400,con:400,wis:400,spr:400,luk:400}); // ha / Di：未指定时的能力

// ---- 伤害
export const OVER_LIMIT_SLOPE=0.0025;      // Xl：攻击技能能力差超过上限后每点 +0.25%×max
export const BUFF_OVER_LIMIT_SLOPE=0.0002; // Ys：增益效果量超过上限每点
export const DEBUFF_OVER_LIMIT_SLOPE=0.001;// zs：减益效果量超过上限每点
export const EX_ATT_START=1e7,EX_ATT_SCALE=4434e5,EX_ATT_K=0.02046; // EX 打分衰减（HBR Toolbox 2026）
export const SOFT_CAP=1e9;                 // Yl/Gr：单 hit 软上限
export const VARIANCE=[0.9,1.1];           // 伤害浮动
export const CRIT_BASE_MULT=1.5;           // 暴击基础倍率
export const CRIT_BORDER_DOWN=50;          // 暴击时基准下修（与厄运取大）
export const CRIT_BASE=1.5,CRIT_LUK=0.04,CRIT_BASE_CAP=10; // 基础暴击率% = min(10, 1.5+(运−有效基准)×0.04)
export const PENETRATION_PHYSICAL=400;     // 贯通暴击的物理弱点%
export const TOKEN_PER=0.16,TOKEN_CAP=2.6;  // 标记攻击：1+0.16×标记，上限 ×2.6
export const MORALE_STAT=5,MORALE_ATTACK=5; // 士气每级：全能力 +5（c0）、技能攻击 +5%（D0）
export const NECKLACE_ATTACK=10,NECKLACE_DESTRUCTION=10; // 古代项链（技能攻击+10%/破坏率上升+10%）：l0/o0
export const RING_BY_LEVEL=[2,4,6,8,10];   // $r：属性戒指等级→属性技能攻击%
// 耳环：按技能 hit 数取值（1hit→首项，≥10hit→末项）；进攻(对HP)/爆破(对DP)用正序，破坏用倒序
export const EARRING_TABLE={15:[15,13.89,12.78,11.67,10.56,9.45,8.33,7.22,6.11,5],12:[12,11.22,10.45,9.67,8.89,8.11,7.33,6.56,5.78,5],10:[10,9.45,8.89,8.33,7.78,7.22,6.67,6.11,5.56,5]};
export const TEAR_STEP=20,TEAR_RATE=0.02;  // u0/m0：泪强化（每级参数上限+20，基础伤害×2%）

// ---- 增益槽（stackingGroup）：这些类型同组最多 2 个；[单独发动](limitType Once) 一个占满
export const DOUBLE_SLOT_BUFFS=['attackUp','elementAttackUp','mindsEye','critRateUp','critDamageUp','elementCritRateUp','elementCritDamageUp','consecutiveHit'];
export const DOUBLE_SLOT_DEBUFFS=['defenseDown','elementDefenseDown','dpDefenseDown','fragile','resistanceDown'];

// ---- 回合（Planner）
export const SP_PER_TURN=2;       // Bt：普通回合全员 SP +2
export const SP_CAP=20;           // wn：回合回复的上限（已 ≥20 不再加；技能回复不受此限）
export const SP_INITIAL=1;        // 开场基础 SP 1（社区 Planner 缺省开场 SP ut=4 = 1 + 古代项链 3；2026-11-09 训练场：前卫三人都比按 0 算的多 1）
export const OD_PER_HIT=2.5;      // yi：每 hit OD +2.5%
export const NORMAL_ATTACK_HITS=3;// Ji：普攻按 3 hit 计 OD
export const OD_EARRING_BONUS=[0,10,12,15]; // bn：DRIVE 耳环等级→加成%
export const OD_COST={1:100,2:200,3:300};   // qe
export const OD_ROUNDS={1:1,2:2,3:3};       // Vn
export const OD_SP={1:5,2:12,3:20};         // Ja：OD 首轮全员 SP
export const OD_MAX=300;                    // Ut
export const MORALE_TOKEN_STACK_MAX=10;     // ys：士气/标记最多 10 层

// ---- 超越ゲージ（ADMIRAL「X の律動」；社区计算器未建模。来源 Game8 752616 / katorasublog 4458，2026-11-09 调研）
export const TRANSCEND_PER_MEMBER=15;  // 初期值 = 部队里该属性卡面数 × 15%
export const TRANSCEND_INITIAL_MAX=90; // 初期值上限 90%
export const TRANSCEND_PER_ACTION=4;   // 该属性卡面每行动一次 +4%
export const TRANSCEND_EFFECT={od:100,attackUp:300,destructionRateUp:10,attackBuffUp:20,debuffUp:20,critDamage:100,destructionLimit:300};
// ---- 属性の印（等级 = 部队里该属性卡面数，效果只给该属性卡面）
export const MARK_EFFECT={damageUp:1,damageTaken:2,destructionRateUp:3,critRate:4,critDamage:5,spPerTurn:6}; // 值 = 需要的等级
export const MARK_VALUES={damageUp:30,destructionRateUp:10,critRate:30,critDamage:30,spPerTurn:1};
// 2026-11-09 训练场核对后的开关（N1 后修订）
// 超越バースト时被动暴伤是否不叠加：false（冰之印 +30% 改为攻击力组后，叠加才吻合）
export const TRANSCEND_CRIT_EXCLUSIVE=false;
// 同名被动多人携带是否只算一次：false（游戏内说明「冰之波動」【同時發動無限制】）
export const DEDUPE_SHARED_PASSIVES=false;
// ---- OD 取整（社区 Planner Cs/xs + @gazou774 实测：每 hit 量先截到 0.01%，再乘 hit 数；耳环加成按“连击前”的 hit 数）
export const OD_DECIMALS=2;

// ---- 普攻（公开数据没有；2026-11-09 训练场拟合）
// 蒼井 敌方能力值 600 / 450 的非暴击读数：基础威力 ≈ 4.06 ×（能力差 + 24.6），能力差到 241 仍线性 → 取 min 100、max 1318、上限 300
export const NORMAL_ATTACK={min:100,max:1318,limit:300};
// 普攻 hit 数：按武器（Game8「通常攻撃回数まとめ」2026-06 版；训练场实测 蒼井 盾 1、東城 枪 3、立華奏 2 吻合）
// 总威力相同，只是分段：影响逐段暴击、DP 边界、破坏率逐段累积；OD 一律按 3 hit（2023-03 起）
export const NORMAL_HITS_BY_WEAPON={Sword:3,Scythe:3,Gun:3,Bike:3,Cannon:3,DoubleSword:2,LargeSword:1,Shield:1,Claw:1};
// 例外角色：立華奏（数据为剑，实际 2）、QUEEN 4、VIOLET 3、MONA 2
export const NORMAL_HITS_BY_CHAR={AliceA:2,EmaC:4,EmaD:3,EmaB:2};
// 追击（后卫在前卫技能攻击后按概率发动，无属性、不吃增减益、不耗 SP；一次技能攻击最多 1 次）。概率无公开数值 → 由选项给出，缺省 0（不计）
export const FOLLOW_UP_RATE_DEFAULT=0;
