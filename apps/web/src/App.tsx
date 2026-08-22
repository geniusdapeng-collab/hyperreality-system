import { Route, Routes } from "react-router";
import P1 from "./pages/p1/P1";
import P2 from "./pages/p2/P2";
import P9 from "./pages/p9/P9";
import P21 from "./pages/p21/P21";
import P0 from "./pages/p0/P0";
import P3 from "./pages/p3/P3";
import P4 from "./pages/p4/P4";
import P5 from "./pages/p5/P5";
import P6 from "./pages/p6/P6";
import P7 from "./pages/p7/P7";
import P8 from "./pages/p8/P8";
import P10 from "./pages/p10/P10";
import DevMatrix from "./pages/dev/DevMatrix";
import { Bridge } from "./shell/Bridge";

/** 阶段三路由：页面自包 Bridge（注入真实左右栏）；/dev 矩阵保持壳内平铺 */
export default function App() {
  return (
    <Routes>
      <Route path="/" element={<P0 />} />
      <Route path="/p1" element={<P1 />} />
      <Route path="/p2/:threadId" element={<P2 />} />
      <Route path="/p9" element={<P9 />} />
      <Route path="/p21" element={<P21 />} />
      <Route path="/p3" element={<P3 />} />
      <Route path="/p4" element={<P4 />} />
      <Route path="/p5" element={<P5 />} />
      <Route path="/p6" element={<P6 />} />
      <Route path="/p6/create" element={<P6 />} />
      <Route path="/p7" element={<P7 />} />
      <Route path="/p8" element={<P8 />} />
      <Route path="/p8/agent/:agentId" element={<P8 />} />
      <Route path="/p10" element={<P10 />} />
      <Route path="/dev" element={<Bridge><DevMatrix /></Bridge>} />
      <Route path="*" element={<P0 />} />
    </Routes>
  );
}
