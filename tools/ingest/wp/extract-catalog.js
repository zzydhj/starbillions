/**
 * WooCommerce catalogue: products, their categories, their spec attributes, and
 * the cover image each one references.
 *
 * Attribute values are read through the term tables rather than the
 * `_product_attributes` postmeta. That meta field is PHP serialised, and the
 * taxonomy rows already hold the same fact in a shape a static build can use.
 *
 * The attribute's human label also comes free: WooCommerce keys these taxonomies
 * as `pa_外观尺寸`, so the label is the key minus its prefix. No lookup into the
 * serialised `woocommerce_attribute_taxonomies` option is needed.
 */
import { groupBy, isPublished, metaByPost, toObjects } from './model.js';

export function extractCatalog(dump, attachments) {
  const posts = toObjects(dump, 'wp_posts').filter(isPublished);
  const products = posts.filter((row) => row.post_type === 'product');
  const terms = toObjects(dump, 'wp_terms');
  const taxonomy = toObjects(dump, 'wp_term_taxonomy');
  const relationships = toObjects(dump, 'wp_term_relationships');

  const byTaxonomyId = new Map(taxonomy.map((row) => [row.term_taxonomy_id, row]));
  const termById = new Map(terms.map((row) => [row.term_id, row]));
  const meta = metaByPost(toObjects(dump, 'wp_postmeta'));
  const imageById = new Map(attachments.map((row) => [row.ID, row]));

  const termsFor = groupBy(relationships, 'object_id');

  const catalogue = products.map((product) => {
    const linked = (termsFor.get(product.ID) ?? [])
      .map((rel) => byTaxonomyId.get(rel.term_taxonomy_id))
      .filter(Boolean)
      .map((row) => ({ row, term: termById.get(row.term_id) }))
      .filter((entry) => entry.term);

    const attributes = linked
      .filter(({ row }) => row.taxonomy.startsWith('pa_'))
      .map(({ row, term }) => ({
        label: row.taxonomy.slice(3),
        value: term.name,
        slug: term.slug,
      }));

    const categories = linked
      .filter(({ row }) => row.taxonomy === 'product_cat')
      .map(({ term }) => ({ title: term.name, slug: term.slug }));

    const fields = meta[product.ID] ?? {};
    const cover = fields._thumbnail_id ? imageById.get(Number(fields._thumbnail_id)) : null;

    return {
      slug: product.post_name,
      title: product.post_title,
      sku: fields._sku ?? null,
      summary: product.post_excerpt || null,
      // Kept as stored. This is WordPress-authored HTML and may carry shortcodes
      // and inline styles; the page builder layer decides what to do with it.
      body: product.post_content || null,
      price: numeric(fields._price),
      salePrice: numeric(fields._sale_price),
      categories,
      attributes,
      image: cover ? cover.guid : null,
      // Woodmart orders catalogue cards by this; keeping it means the static
      // listing reproduces the shop's own sequence instead of an alphabetical one.
      order: product.menu_order ?? 0,
    };
  });

  return {
    products: catalogue.sort((a, b) => Number(a.order) - Number(b.order) || a.title.localeCompare(b.title)),
    attributes: summarise(catalogue, 'attributes'),
    categories: summarise(catalogue, 'categories'),
  };
}

/** Count up each distinct attribute/category so listings can render facets. */
function summarise(catalogue, key) {
  if (key === 'categories') {
    const counts = new Map();
    for (const product of catalogue) {
      for (const category of product.categories) {
        counts.set(category.slug, { ...category, count: (counts.get(category.slug)?.count ?? 0) + 1 });
      }
    }
    return [...counts.values()].sort((a, b) => b.count - a.count);
  }

  const byLabel = new Map();
  for (const product of catalogue) {
    for (const attribute of product.attributes) {
      if (!byLabel.has(attribute.label)) byLabel.set(attribute.label, new Map());
      const values = byLabel.get(attribute.label);
      values.set(attribute.value, (values.get(attribute.value) ?? 0) + 1);
    }
  }

  return [...byLabel.entries()].map(([label, values]) => ({
    label,
    values: [...values.entries()].map(([value, count]) => ({ value, count })).sort((a, b) => b.count - a.count),
  }));
}

function numeric(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}
