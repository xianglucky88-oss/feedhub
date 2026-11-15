export function stripHtml(value = '') {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

export function normalizeItem(item) {
  const date = item.published ? new Date(item.published) : null;
  return {
    ...item,
    title: stripHtml(item.title),
    summary: stripHtml(item.summary),
    link: item.link || '',
    published: date && !Number.isNaN(date.valueOf()) ? date.toISOString() : item.published || '',
  };
}
