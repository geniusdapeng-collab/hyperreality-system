/** Preserve each product's existing CI and append the shared trusted-main delivery include. */
import { hash } from './queue-model.mjs';
import { parser } from './queue-policy.mjs';

export async function injectDeliveryConfig(text, { bootstrap = false } = {}) {
  const YAML = await parser();
  const doc = YAML.parseDocument(text, { maxAliasCount: 1000 });
  if (doc.errors.length || !YAML.isMap(doc.contents)) throw new Error('CI is not a valid mapping');
  const before = doc.toJS({ maxAliasCount: 1000 });
  const include = before.include === undefined ? [] : Array.isArray(before.include) ? before.include : [before.include];
  const entries = ['scripts/delivery/cnb.yml', ...(bootstrap ? ['scripts/delivery/bootstrap-cnb.yml'] : [])];
  const pathOf = item => typeof item === 'string' ? item : item?.path;
  const missing = entries.filter(path => !include.some(item => pathOf(item) === path));
  if (!missing.length) return { content: text, changed: false };
  doc.set('include', [...include, ...missing]);
  const next = doc.toJS({ maxAliasCount: 1000 });
  const { include: ignoredBefore, ...prior } = before;
  const { include: ignoredAfter, ...after } = next;
  if (hash(prior) !== hash(after)) throw new Error('Delivery installation modified existing CI');
  return { content: doc.toString({ lineWidth: 0 }), changed: true };
}
