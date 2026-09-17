declare const __WORKLOOM_PRODUCT_NAME__: string;
declare const __WORKLOOM_PRODUCT_ID__: string;
declare const __WORKLOOM_DEMO_WORKSPACE__: string;

/** 受保护产品身份由 Vite 从仓库根 product.manifest.json 注入。 */
export const PRODUCT_NAME = __WORKLOOM_PRODUCT_NAME__;
export const DEMO_WORKSPACE = (import.meta.env.VITE_DEFAULT_WORKSPACE as string | undefined) ?? __WORKLOOM_DEMO_WORKSPACE__;
export const storageKey = (suffix: string) => `workloom:${__WORKLOOM_PRODUCT_ID__}:b-mobile:${suffix}`;
