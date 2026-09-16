import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";
import { BannerAlert } from "../../../components/hud";
import { Skeleton } from "@workloom/ui";
import { ensureDemoLogin, trpc } from "../../../lib/trpc";
import { Bridge } from "../../../shell/Bridge";
import { EvolutionZone } from "../components/skills/EvolutionZone";
import { ProductionEntry } from "../components/skills/ProductionEntry";
import { SkillChains } from "../components/skills/SkillChains";
import { StageRecommendBar } from "../components/skills/StageRecommendBar";
import type { SkillRow, SkillUsage } from "../components/skills/skillShared";

interface InstallRow { skill_id: string }

export default function SkillOperations() {
  const navigate = useNavigate();
  const [ready, setReady] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [stage, setStage] = useState<string | null>(null);
  const [skills, setSkills] = useState<SkillRow[]>([]);
  const [installs, setInstalls] = useState<InstallRow[]>([]);
  const [usage, setUsage] = useState<Record<string, SkillUsage>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    await ensureDemoLogin();
    const [member, skillRows, installRows, usageRows, workspace] = await Promise.all([
      trpc.members.me.query() as Promise<{ identity: { role: string } }>,
      trpc.skills.list.query() as Promise<SkillRow[]>,
      trpc.skills.installs.query() as Promise<InstallRow[]>,
      trpc.skills.usage.query() as Promise<Record<string, SkillUsage>>,
      trpc.workspace.profile.query() as Promise<{ stage: string | null }>,
    ]);
    setCanManage(["owner", "manager"].includes(member.identity.role));
    setSkills(skillRows);
    setInstalls(installRows);
    setUsage(usageRows);
    setStage(workspace.stage);
    setReady(true);
  }, []);

  useEffect(() => { void load(); }, [load]);
  const installedSet = useMemo(() => new Set(installs.map((item) => item.skill_id)), [installs]);
  const officials = skills.filter((skill) => skill.level === "official");
  const install = async (skillId: string) => {
    setBusy(skillId);
    try {
      await trpc.skills.install.mutate({ skillId });
      setMessage("技能已装备，绑定围栏已同步生效。");
      await load();
    } finally {
      setBusy(null);
    }
  };

  return (
    <Bridge>
      <div className="mb-4 min-w-0">
        <h2 className="break-words text-h1 font-black text-ink">视频技能运营</h2>
        <p className="mt-1 break-words text-caption text-ink3">按经营阶段发现、组合、校准并生产视频行业技能。</p>
      </div>
      {message ? <div className="mb-3"><BannerAlert level="info" actionLabel="知道了" onAction={() => setMessage(null)}>{message}</BannerAlert></div> : null}
      {!ready ? <Skeleton count={5} /> : (
        <>
          <StageRecommendBar stage={stage} officials={officials} installedSet={installedSet} busy={busy} canManage={canManage} onInstall={(id) => void install(id)} />
          <SkillChains skills={skills} onToast={setMessage} />
          <EvolutionZone skills={skills} usage={usage} onToast={setMessage} />
          <ProductionEntry canManage={canManage} onToast={setMessage} onForge={() => navigate("/skills/create")} />
        </>
      )}
    </Bridge>
  );
}
