declare const __WORKLOOM_PRODUCT_NAME__: string;
declare const __WORKLOOM_PRODUCT_ID__: string;

/** 受保护产品身份由 Vite 从仓库根 product.manifest.json 注入。 */
export const PRODUCT_NAME = __WORKLOOM_PRODUCT_NAME__;
export const storageKey = (suffix: string) => `workloom:${__WORKLOOM_PRODUCT_ID__}:c-mobile:${suffix}`;
