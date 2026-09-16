/** 三端 Vite 构建身份桥：只从受保护产品清单注入身份。 */
import { loadProductRuntime } from "./product-runtime.mjs";

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function workloomProductVite(clientLabel) {
  if (typeof clientLabel !== "string" || !clientLabel.trim()) throw new Error("缺少客户端中文名称");
  const product = loadProductRuntime(process.cwd());
  const title = `${product.displayName} · ${clientLabel}`;
  return Object.freeze({
    define: {
      __WORKLOOM_PRODUCT_NAME__: JSON.stringify(product.displayName),
      __WORKLOOM_PRODUCT_ID__: JSON.stringify(product.productId),
      __WORKLOOM_DEMO_WORKSPACE__: JSON.stringify(product.demoWorkspaceSlug),
      __WORKLOOM_DEMO_MEMBER__: JSON.stringify(product.demoMemberNo),
    },
    plugin: {
      name: "workloom-product-identity",
      transformIndexHtml(html) {
        const marker = /<title data-workloom-product-title>[^<]*<\/title>/u;
        if (!marker.test(html)) {
          throw new Error("客户端 index.html 缺少受控产品标题标记");
        }
        return html.replace(marker, `<title data-workloom-product-title>${escapeHtml(title)}</title>`);
      },
    },
  });
}
