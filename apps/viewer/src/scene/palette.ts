/** Scene palette. Mirrors the CSS tokens in styles.css; keep the two in step. */
export const C = {
  sheet: 0x0e2f5a, // deep blueprint blue
  ink: 0xeaf2ff, // near-white line work
  ink2: 0xa9d4f5, // cyan-white secondary lines
  ink3: 0x86b4de, // muted labels (still ≥4.5:1 on sheet)
  grid: 0xa9d4f5,
  red: 0xff8a7e, // red pen: attention only
  focus: 0xfff3c4, // focus / placement preview (the --focus token)
};

/** Drafting lettering: Overpass (OFL 1.1), a Highway Gothic / DIN-lineage monoline close to ISO 3098 type B. */
export const FONT_DRAFT = '"Draft Dot", "Overpass", sans-serif';
