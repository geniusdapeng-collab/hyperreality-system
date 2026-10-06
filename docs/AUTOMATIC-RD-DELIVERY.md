# 普通研发自动交付

产品所有者于 2026-10-06 现行授权十二仓及账户新增项目安装同一研发交付机制，并于 2026-10-06 撤销平台付费 AI 审核，要求当前 Codex 自带模型在提交/发布前完成 review 和测试。这个补充只调整普通研发的并发、审核与交付规则；它优先于旧开发协议中相应的人工批准和永久 open PR 互斥条款。其他产品、安全、隔离与经营规则继续适用。

1. 开发者每项任务使用独立分支/PR，声明准确路径和验收。普通文件重叠只提示；敏感模块的开发租约有 owner、generation 和默认 15 分钟期限，等待 CI/审查前须用 lease --action release 显式释放准确 owner/generation。任务号或 ready 描述不能自行释放租约。main 接纳执行器自动取得并释放敏感源码的短期 fenced generation；此接纳回执与合并前集成租约均为硬门禁。
2. 每次验证一个修复后及时提交推送。用 queue-runner handoff --review-receipt <实际审查记录.json> 声明 ready 和真实 depends_on；没有准确回执的遗留 PR 保持等待。WIP、risk/block 与真实业务动作不会被研发授权放行。
3. 原仓必需 CI 必须针对准确 source/main 全绿。当前 Codex 精读所有变化文件及直接依赖、运行必要测试并填写完整结构化回执；每个 CI 实现变化须有准确 id 的迁移依据。不可修改候选分支再跑原仓 CI，准确会话回执与完整 CI 共同成立，才能普通 merge；source/main 漂移即重做。
4. main 原生执行器每 5 分钟恢复，仓级原生锁只串行实际集成。敏感候选合并前强制取得并核验 fenced 集成租约。失败任务单独保留；语义冲突、权限不足、未知写入不会伪装成功或重复外部动作。
5. automation/delivery-state 通过普通 fast-forward CAS 保存只增事件、租约、尝试、Codex 审查/测试与集成证明。丢失响应先回读 transaction id。UI/桌面声明的发布使用独立执行器与固定 SHA/版本，核验构建、tag、manifest 与实际字节；没有发布回执不关完成任务。
6. 首装由具备设置权限的安装端创建并回读强保护账本、准备准确安装 source/main，随后运行准确安装资产/账本的 bootstrap 检查和原有门禁。完成 Codex 会话审查实测后普通合入，在当前 main activate 回读会话证明、真实测试和候选/主干保护，并取消额外管理员点击批准要求。源 PR 原生令牌实测只读，原生 main 运行；会话凭据不写进 CI 或文件。
7. 账户安装器只位于来源仓 workloom-ai/workloom-im，不复制到行业仓或隔离副本。先在已激活的基座主干目录执行 node scripts/delivery/install-account.mjs --source-root <该基座主干目录> --directory <本任务专用安装目录> --concurrency 2；本仓日常使用下列 queue-runner 命令。安装器调用 install-config 为目标追加 include，并在完整目标检出中离线刷新目标自身开源清单。平台原生令牌没有设置写权限，初次保护安装使用当前任务授权的短期会话权限，只在进程内注入。安装运行需要凭据仍有效；发现权限/平台不兼容即明确告警并保留可恢复任务，不能声称已启用。未有 main/可验证产品 CI 的仓先保留准备状态，不能把交付机制自测当成产品已验收。未来自动发现需要另行启用账户安装调度；本机制不自行创建 Codex chat 定时任务，用户取消的任务保持取消。

安装清单保存在 .workloom-delivery-install.json，列出来源提交和每个准确资产摘要。安装器不会替换 product.manifest、WORKLOOM_PRODUCT_CONTEXT、冻结同步摘要、行业业务或标签；隔离仓不会加入 children，也不会开启业务 fanout。

命令：node scripts/delivery/queue-runner.mjs status|lease|handoff|verify-review|prepare-install|verify-install|activate|reconcile|releases --repo <org/repo>。本仓执行器 CLI 和原生 CI 是行为事实源；会话审查回执不代表平台 AI 批准，也不调用外部模型；本地测试或安装标记不能替代云端通过、合并及 activation 回执。
