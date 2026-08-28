/**
 * A delimited-text reader that honours quoting.
 *
 * ONS CSVs are `;`-delimited, UTF-8, `.` as the decimal separator. Most of
 * their datasets have no free-text column, so splitting on newlines happens to
 * work and it is tempting to stop there.
 *
 * The constrained-off datasets break that. `dsc_restricao` is free text naming
 * the network element or operating instruction, and it contains both quotes and
 * **embedded newlines** — a single logical row can span several physical lines:
 *
 *     ...;CNF;LOC;"Controle de inequação: CONTROLE DE CARREGAMENTO ... APÓS
 *     A PERDA DA LT 500 KV MORRO DO CHAPÉU II / OUROLÂNDIA II – C1(N4) ..."
 *
 * Measured on `RESTRICAO_COFF_EOLICA_2026_08.csv`: 12 physical lines carry an
 * unbalanced quote and 7 have a field count other than 16. A newline-splitting
 * parser silently emits those as short, misaligned rows — plausible-looking
 * data rather than an error, which is the failure mode this codebase treats as
 * worse than a crash.
 */

/** Parsed rows, plus the header the file actually carried. */
export interface DelimitedTable {
  columns: string[];
  /** One entry per logical row; cells are raw, untrimmed strings. */
  rows: string[][];
}

/**
 * Read delimited text into rows, honouring RFC 4180 quoting:
 * a field may be wrapped in `"`, may contain the delimiter, may contain
 * newlines, and escapes a literal quote by doubling it (`""`).
 *
 * Written as an explicit scanner rather than a split-and-patch because the
 * quoting state is what decides whether a newline ends a row, and that cannot
 * be recovered after splitting.
 */
export function parseDelimited(text: string, delimiter = ";"): DelimitedTable {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldWasQuoted = false;
  // Whether anything at all has been seen since the last row boundary — used to
  // drop a trailing newline without dropping a legitimate empty final field.
  let started = false;

  const endField = (): void => {
    row.push(fieldWasQuoted ? field : field.trim());
    field = "";
    fieldWasQuoted = false;
  };

  const endRow = (): void => {
    endField();
    // A blank physical line between rows is not a row.
    if (!(row.length === 1 && row[0] === "")) {
      rows.push(row);
    }
    row = [];
    started = false;
  };

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1; // consume the escape
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field === "") {
      quoted = true;
      fieldWasQuoted = true;
      started = true;
      continue;
    }
    if (char === delimiter) {
      endField();
      started = true;
      continue;
    }
    if (char === "\n") {
      endRow();
      continue;
    }
    if (char === "\r") {
      continue; // CRLF: the \n does the work
    }
    field += char;
    started = true;
  }

  // A final row with no trailing newline.
  if (started || field !== "" || row.length > 0) {
    endRow();
  }

  const header = rows.shift();
  if (!header) {
    return { columns: [], rows: [] };
  }
  return { columns: header, rows };
}

/**
 * Zip a row's cells against the header.
 *
 * A cell absent because the row is short is left *out of the map*, which is a
 * different fact from a cell present and empty: the first means the column was
 * not there, the second means no value was given. Adapters depend on that
 * distinction, so it is preserved here rather than flattened to `""`.
 */
export function toRecord(columns: string[], cells: string[]): Record<string, string> {
  const record: Record<string, string> = {};
  columns.forEach((column, index) => {
    if (index < cells.length) {
      record[column] = cells[index];
    }
  });
  return record;
}
