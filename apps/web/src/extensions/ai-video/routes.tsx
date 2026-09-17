import Activity from "./pages/Activity";
import Assets from "./pages/Assets";
import ReviewGuide from "./pages/ReviewGuide";
import SkillOperations from "./pages/SkillOperations";
import TeamPerformance from "./pages/TeamPerformance";

export const industryRoutes = [
  { path: "/ai-video/assets", capabilityId: "ai-video.assets", element: <Assets />, legacyPaths: ["/p10"] },
  { path: "/ai-video/skills", capabilityId: "ai-video.skills", element: <SkillOperations /> },
  { path: "/ai-video/team-performance", capabilityId: "ai-video.team-performance", element: <TeamPerformance /> },
  { path: "/ai-video/team-performance/:agentId", capabilityId: "ai-video.team-performance", element: <TeamPerformance /> },
  { path: "/ai-video/activity", capabilityId: "ai-video.activity", element: <Activity /> },
  { path: "/ai-video/review-guide", capabilityId: "ai-video.review-guide", element: <ReviewGuide /> },
] as const;
