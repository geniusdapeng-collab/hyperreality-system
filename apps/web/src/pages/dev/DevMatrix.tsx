/**
 * /dev 状态矩阵页（F2 验收）：HUD 组件库 × 状态变体平铺对账
 * 每组件覆盖「默认/加载/空/错误/权限」适用态（设计规范 §10 交付检查表）；
 * 页面本身即走查工具——对照 PRD 状态规格表逐屏对账时逐格核验。
 */
import type { ReactNode } from "react";
import { Icon } from "@workloom/ui";
import {
  AchievementBadge,
  AgentActionMessage,
  BannerAlert,
  DispatchBar,
  EmptyState,
  EquipCard,
  EquipSlot,
  FenceLight,
  HandoffCard,
  HumanBubble,
  KpiGauge,
  LevelBadge,
  NightStatusPill,
  QuestCard,
  RadarAlertCard,
  RadarAllClear,
  Skeleton,
  SquadRing,
  SubCallMessage,
  SystemDivider,
  TriGestureBar,
  XpBar,
} from "../../components/hud";

function Cell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="rounded-lg border border-line bg-bg900/60 p-3">
      <div className="mb-2 font-mono text-micro tracking-wider text-holo2">{label}</div>
      {children}
    </div>
  );
}

function Section({ name, spec, children }: { name: string; spec: string; children: ReactNode }) {
  return (
    <section className="mb-6">
      <h3 className="mb-2.5 flex items-baseline gap-2.5">
        <span className="text-h2 font-black text-ink">{name}</span>
        <span className="font-mono text-micro text-ink3">{spec}</span>
      </h3>
      <div className="grid grid-cols-2 gap-2.5">{children}</div>
    </section>
  );
}

export default function DevMatrix() {
  return (
    <div data-wl-authorized-diagnostics="ui-component-matrix" className="space-y-2">
      <p className="rounded border border-line bg-bg800 px-3 py-2 text-body text-ink2">
        仅限本地开发环境并显式开启诊断开关后使用；本页术语仅用于组件验收。
      </p>
      <div className="mb-4 flex items-baseline gap-3">
        <h2 className="text-h1 font-black tracking-wider">HUD 组件状态矩阵</h2>
        <span className="text-caption tracking-[.2em] text-ink3">/dev · DEV MATRIX · F2</span>
      </div>

      <Section name="DispatchBar 航线设定台" spec="§5.1 · 空文本/输入中/路由识别中">
        <Cell label="empty 空文本置灰"><DispatchBar state="empty" /></Cell>
        <Cell label="typing 输入中"><DispatchBar state="typing" value="周五前把大床房价格对标竞对" /></Cell>
        <Cell label="routing 路由识别中（可取消）"><DispatchBar state="routing" /></Cell>
      </Section>

      <Section name="QuestCard 主线任务卡" spec="§5.2 · 六态 + 断线重连">
        <Cell label="running 执行中（青脉冲）">
          <QuestCard eventId="E-8842" title="周五旺季调价" action="竞对采集中" done={2} total={3} status="running" />
        </Cell>
        <Cell label="review 待审查（琥珀呼吸）">
          <QuestCard eventId="E-8843" title="差评应急回复" action="回复草稿待审批" done={2} total={3} status="review" />
        </Cell>
        <Cell label="done 已完成 / queued 排队">
          <div className="space-y-2">
            <QuestCard eventId="E-8844" title="夜间对账" done={3} total={3} status="done" />
          </div>
        </Cell>
        <Cell label="failed 失败（红框）/ reconnecting 重连中">
          <QuestCard eventId="E-8845" title="飞猪首图发布" action="渠道超时" done={1} total={3} status="failed" reconnecting />
        </Cell>
      </Section>

      <Section name="HandoffCard 昨夜日报卡" spec="§5.3 · 默认/空态（禁显 0）">
        <Cell label="默认（三栏大数字强一致 F4.4）">
          <HandoffCard data={{ deliveredAt: "08:30", fenceSnapshot: "hotel-baseline/v1", done: 12, pending: 2, needHuman: 1, credits: 46 }} />
        </Cell>
        <Cell label="空态（夜班未启用 → 整卡空态）">
          <HandoffCard nightEnabled={false} />
        </Cell>
      </Section>

      <Section name="TriGestureBar 审批三操纵杆" spec="§5.4 · 默认/过期禁用/权限隐藏">
        <Cell label="默认三杆"><TriGestureBar /></Cell>
        <Cell label="expired 快照过期（E5.3 整组锁定+刷新）"><TriGestureBar expired /></Cell>
        <Cell label="无审批权（整组隐藏非置灰 L5.1）">
          <div className="text-caption text-ink3">下方渲染为 null（无置灰残影）：<TriGestureBar canApprove={false} />∅</div>
        </Cell>
      </Section>

      <Section name="FenceLight 围栏状态灯" spec="§5.5 · auto/review/block/need + 基线金锁">
        <Cell label="auto 绿（常亮）/ review 琥珀（2s 呼吸）">
          <div className="space-y-2">
            <FenceLight level="auto" name="R1 涨幅 ≤8% 自动" baseline />
            <FenceLight level="review" name="R6 差评 ≤3 分必审" baseline />
          </div>
        </Cell>
        <Cell label="block 红（0.8s 急促）/ need 紫（需介入）">
          <div className="space-y-2">
            <FenceLight level="block" name="R2 保底价熔断" baseline />
            <FenceLight level="need" name="R5 担保异常需介入" />
          </div>
        </Cell>
      </Section>

      <Section name="消息族" spec="§5.6 · 人类/Agent 行动/子调用/系统分隔线">
        <Cell label="HumanBubble + AgentActionMessage（回执三态）">
          <div className="space-y-2.5">
            <HumanBubble time="21:14">把周五的房价策略跑一遍</HumanBubble>
            <AgentActionMessage sender="调价 Agent" version="v2.0" action="price.adjust" eventId="E-8842" receipt="synced" rules={["R1 v1", "R2 v1"]} credits={6} memoryRefs={["mem-occ-friday"]}>
              大床房 ¥480 → ¥499（+4.0%，未超 R1 上限）
            </AgentActionMessage>
            <AgentActionMessage sender="调价 Agent" version="v2.0" action="channel.push" eventId="E-8843" receipt="unverified">
              已推送渠道，回执未到（E3.7：无回执标未核实）
            </AgentActionMessage>
          </div>
        </Cell>
        <Cell label="SubCallMessage + SystemDivider">
          <div className="space-y-2.5">
            <SubCallMessage target="竞对采集" version="v1.3" receipt="synced">同商圈 3 家竞对均价 ¥512</SubCallMessage>
            <SystemDivider time="22:00" summary="夜班中心出征（night.run.start 已落库）" />
          </div>
        </Cell>
      </Section>

      <Section name="KpiGauge KPI 全息仪表" spec="§5.7 · 默认/延迟置灰">
        <Cell label="默认（截至 HH:MM 必显）"><KpiGauge name="REVPAR" value="¥412" delta={1.6} asOf="21:30" /></Cell>
        <Cell label="stale 延迟置灰（禁伪装实时）"><KpiGauge name="OCC 入住率" value="87%" delta={-0.8} asOf="18:00" stale /></Cell>
      </Section>

      <Section name="RadarAlertCard 雷达推送卡" spec="§5.8 · P0/P1/P2 + 无异常态（禁消失）">
        <Cell label="P0 红（雷达扫动 4s/圈）">
          <RadarAlertCard severity="p0" eventId="E-8850" title="渠道「飞猪」状态 offline（非 online）" source="channel_price" />
        </Cell>
        <Cell label="P1 琥珀 / 无异常态">
          <div className="space-y-2">
            <RadarAlertCard severity="p1" eventId="E-8851" title="渠道「美团」价格不一致（parity=false）" source="channel_price" />
            <RadarAllClear />
          </div>
        </Cell>
      </Section>

      <Section name="NightStatusPill 夜班状态胶囊" spec="§5.9 · 巡航/就绪/制动/未配置">
        <Cell label="cruising / ready">
          <div className="flex flex-col items-start gap-2">
            <NightStatusPill state="cruising" window="22:00–08:00" parallel={3} />
            <NightStatusPill state="ready" />
          </div>
        </Cell>
        <Cell label="paused / unconfigured">
          <div className="flex flex-col items-start gap-2">
            <NightStatusPill state="paused" />
            <NightStatusPill state="unconfigured" />
          </div>
        </Cell>
      </Section>

      <Section name="空态 / 骨架屏 / 告警条" spec="§5.10">
        <Cell label="EmptyState + Skeleton（共享基座状态）">
          <div className="space-y-2">
            <EmptyState icon={<Icon name="star" size={24} />} title="一切平静" hint="派遣第一条主线任务，团队即刻开工" actionLabel="开始第一个任务" />
            <Skeleton count={3} label="组件内容正在加载" />
          </div>
        </Cell>
        <Cell label="BannerAlert 三级（红/琥珀/青）">
          <div className="space-y-2">
            <BannerAlert level="alert" actionLabel="去处理">夜班暂停超时，已触发强制隔离（E4.1）</BannerAlert>
            <BannerAlert level="warn">LLM 降级链生效中：旗舰 → 标准（L6.1 已留痕）</BannerAlert>
            <BannerAlert level="info">日报将于 08:30 送达（F4.4）</BannerAlert>
          </div>
        </Cell>
      </Section>

      <Section name="游戏化组件" spec="§6 · 等级/成就/战队环/装配槽/装备稀有度">
        <Cell label="LevelBadge（主理人圆金边 / 船员方形+版本角标）+ AchievementBadge">
          <div className="space-y-3">
            <LevelBadge level={12} rank="黄金" captain name="王店长" />
            <LevelBadge level={7} rank="白银" name="调价 Agent" version="v2.0" />
            <AchievementBadge name="首次夜班闭环" achievedAt="2026-08-15" />
          </div>
        </Cell>
        <Cell label="SquadRing（巡航点亮 / 待命暗灯）+ EquipSlot + EquipCard">
          <div className="space-y-3">
            <SquadRing active members={[{ name: "调", version: "v2.0" }, { name: "评", version: "v1.4" }, { name: "账", version: "v1.1" }, { name: "察", version: "v1.2" }, { name: "文", version: "v1.0" }, { name: "竞", version: "v1.3" }, { name: "桌", version: "v0.9" }]} />
            <div className="flex gap-2">
              <EquipSlot label="收益管理" filled />
              <EquipSlot label="差评危机" filled />
              <EquipSlot label="空槽" />
              <EquipSlot label="装配失败" failed />
            </div>
            <EquipCard name="收益管理专家" rarity="official" desc="调价方法论官方技能（R1/R2 绑定）" installs={3} />
          </div>
        </Cell>
      </Section>

      <Section name="XpBar / EventIdChip 基础件" spec="§6/§10">
        <Cell label="XpBar（金渐变+斜纹流光+Orbitron 数值；禁作普通百分比条）">
          <XpBar done={7} total={10} gain={120} />
        </Cell>
        <Cell label="EmergencyBrake 二次确认（永远可见可用 G5）">
          <div className="text-caption text-ink3">顶栏实例即组件库引用；点击展开「确认制动/撤回」二次确认态（F11 接 pauseAll）。</div>
        </Cell>
      </Section>
    </div>
  );
}
