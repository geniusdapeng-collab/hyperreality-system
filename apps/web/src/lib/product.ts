declare const __WORKLOOM_PRODUCT_NAME__: string;
declare const __WORKLOOM_PRODUCT_ID__: string;
declare const __WORKLOOM_DEMO_WORKSPACE__: string;
declare const __WORKLOOM_DEMO_MEMBER__: string;

/** 受保护产品身份由 Vite 从仓库根 product.manifest.json 注入。 */
export const PRODUCT_NAME = __WORKLOOM_PRODUCT_NAME__;
export const DEMO_WORKSPACE = (import.meta.env.VITE_DEMO_WORKSPACE as string | undefined) ?? __WORKLOOM_DEMO_WORKSPACE__;
export const DEMO_MEMBER = (import.meta.env.VITE_DEMO_MEMBER as string | undefined) ?? __WORKLOOM_DEMO_MEMBER__;
export const storageKey = (suffix: string) => `workloom:${__WORKLOOM_PRODUCT_ID__}:b-pc:${suffix}`;
