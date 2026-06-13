// Tiny RFC-4180-ish CSV parser. The analysis snapshots contain quoted fields with
// embedded commas (services like "web,A2A") and base64 agent_uri values with '='
// padding, so a naive split(",") corrupts rows — hence a real quote-aware parser.

export type Row = Record<string, string>;

/** Parse CSV text into a header + array of string cells (quote-aware). */
function parseGrid(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  // Normalize CRLF so '\r' never leaks into a trailing cell.
  const s = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') {
          field += '"';
          i++; // escaped quote ("")
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += c;
    }
  }
  // Flush the final field/row if the file doesn't end in a newline.
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** Parse CSV text into objects keyed by the header row. Blank lines are skipped. */
export function parseCsv(text: string): Row[] {
  const grid = parseGrid(text).filter((r) => !(r.length === 1 && r[0] === ""));
  if (grid.length === 0) return [];
  const header = grid[0];
  return grid.slice(1).map((cells) => {
    const obj: Row = {};
    header.forEach((key, idx) => {
      obj[key] = cells[idx] ?? "";
    });
    return obj;
  });
}

/** Parse a numeric cell; empty / non-numeric / "nan" -> fallback (default 0). */
export function num(v: string | undefined, fallback = 0): number {
  if (v == null || v === "" || v.toLowerCase() === "nan") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** Parse a boolean-ish cell ("True"/"true"/"1" -> true). */
export function bool(v: string | undefined): boolean {
  if (!v) return false;
  const t = v.trim().toLowerCase();
  return t === "true" || t === "1";
}
