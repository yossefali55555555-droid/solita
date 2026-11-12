// Customer-service numbers printed on every label.
export const SUPPORT_PHONES = ['01122734281', '01101085087'];

/** Arabic counted noun for parcels: طرد واحد، طردان، 3–10 طرود، 11+ طردًا. */
export function parcelsWord(n) {
  if (n === 1) return 'طرد واحد';
  if (n === 2) return 'طردان';
  if (n >= 3 && n <= 10) return `${n} طرود`;
  return `${n} طردًا`;
}

/** Flatten orders → one label per parcel, four labels per A4 sheet. */
export function labelPages(labels) {
  const all = labels.flatMap((l) => l.parcels.map((p) => ({ label: l, parcel: p })));
  const pages = [];
  for (let i = 0; i < all.length; i += 4) pages.push(all.slice(i, i + 4));
  return pages;
}
