/**
 * P6 技能广场 · 生产环④ 入口卡
 *  - 「拉片反推」：jenny-loom-research v2 能力说明 + 上传入口（占位 toast）
 *  - forge 自建入口：沿用现有 /p6/create 三要素向导（F8.3）
 */
export function ProductionEntry({
  canManage,
  onToast,
  onForge,
}: {
  canManage: boolean;
  onToast: (text: string) => void;
  onForge: () => void;
}) {
  return (
    <div className="mb-5">
      <div className="mb-2 text-caption font-bold tracking-wider text-ink2">
        生产环 · 新装备从实战里长出来
      </div>
      <div className="grid grid-cols-2 gap-3">
        {/* 拉片反推（jenny-loom-research v2） */}
        <div className="rounded-msg border border-holo/30 bg-card p-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[20px]">🎞</span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-bold text-ink">拉片反推</div>
              <div className="text-micro text-holo">jenny-loom-research v2 · 官方套件</div>
            </div>
          </div>
          <p className="mt-2 text-caption leading-relaxed text-ink2">
            上传一条爆款视频，反推其分镜结构/节奏/钩子设计，自动沉淀为可复用的拉片档案与提示词原料——情报五站方法论从「图文情报」泛化到「视频拉片」。
          </p>
          <div className="mt-2 text-micro text-ink3">
            反推产物：分镜表 · 节奏曲线 · 黄金 3 秒钩子拆解 · 可入库情报档案（无源不入库铁律不变）
          </div>
          <button
            type="button"
            onClick={() => onToast("拉片反推上传入口即将上线（占位）：上线后支持上传视频样本 → 自动拆解分镜并入情报档案（jenny-loom-research v2，G1 确认门后可用）")}
            className="mt-2.5 cursor-pointer rounded-md border border-holo/40 bg-holo/8 px-3 py-1.5 text-caption font-bold text-holo hover:border-holo/70"
          >
            ⬆ 上传拉片样本
          </button>
        </div>

        {/* forge 自建（沿用现有创建流程） */}
        <div className="rounded-msg border border-gline bg-card p-3.5">
          <div className="flex items-center gap-2">
            <span className="text-[20px]">🛠</span>
            <div className="min-w-0 flex-1">
              <div className="text-body font-bold text-ink">自建装备 forge</div>
              <div className="text-micro text-goldhi">零代码三要素向导 · F8.3</div>
            </div>
          </div>
          <p className="mt-2 text-caption leading-relaxed text-ink2">
            「何时触发 / 做什么 / 不能做什么」三要素描述新装备，「不能做什么」自动转围栏声明；生效前 dry-run 回放最近 10 条事件（F2.5），确认后 v1 进版本管理。
          </p>
          <div className="mt-2 text-micro text-ink3">
            安装即绑定围栏（F8.2）· 卸载即撤销（L8.3）· 生产仅签名白名单（L8.2）
          </div>
          {canManage && (
            <button
              type="button"
              onClick={onForge}
              className="mt-2.5 cursor-pointer rounded-md gold-grad px-3 py-1.5 text-caption font-black text-ongold"
            >
              🛠 打造新装备（→ /p6/create）
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
