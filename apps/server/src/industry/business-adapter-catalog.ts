/**
 * 随服务端制品一起审核、构建的行业适配器目录。
 *
 * 这里是行业包接入基座的显式 composition seam：通用注册表不 import 任何
 * 具体行业实现；新增行业只能在代码评审时登记 adapterId 对应实现及允许选择
 * 它的 Bundle。Bundle 清单仍须通过摘要/生产签名校验，不能声明任意模块路径。
 */
import type { BusinessAdapterRegistration } from "../service/adapters/business.js";
import { hotelBizAdapter } from "./hotel/service-front-adapter.js";

export const BUNDLED_BUSINESS_ADAPTERS: readonly BusinessAdapterRegistration[] = Object.freeze([
  Object.freeze({
    adapter: hotelBizAdapter,
    bundleIds: Object.freeze(["hotel"]),
  }),
]);
