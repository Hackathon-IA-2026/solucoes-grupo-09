/**
 * The permitted uses of a banned word, enumerated.
 *
 * `docs/domain-model.md` §10 forbids the causal claim, and
 * `test/causality-boundary.test.ts` enforces it over this app's source, the
 * shared UI package and both message catalogues. A handful of strings have to
 * name the word in order to deny the claim — the driver-bars footnote is the
 * canonical one — and those live here, one entry per occurrence.
 *
 * Three properties make this an allowlist rather than a hole:
 *
 *  1. **One entry per occurrence, located.** An entry permits the lemmas inside
 *     one specific string in one specific file. It cannot exempt a file, a
 *     directory or a word.
 *  2. **It cannot rot.** An entry whose string no longer appears in its file
 *     fails the check, so deleting a disclaimer deletes its exemption in the
 *     same commit. An entry whose string contains no banned lemma fails too,
 *     which stops the list being padded with strings that never needed it.
 *  3. **Every entry says why.** The reason is the review; the test is only what
 *     makes the review happen.
 *
 * Adding an entry is a deliberate act. The question it has to answer is not
 * "does this sentence read fine" but "does this sentence deny the causal claim
 * rather than make it". Only the first answer earns a line here.
 */

/** One permitted occurrence: the string, where it is, and why it is allowed. */
export interface CausalityAllowlistEntry {
  /**
   * The exact source string containing the banned lemma, as written in the
   * file. Copied verbatim, so that an edit to the copy invalidates the entry.
   */
  string: string;
  /** Repo-relative path, POSIX separators, of the file the string is in. */
  file: string;
  /** Why this occurrence does not cross the boundary. */
  reason: string;
}

export const CAUSALITY_ALLOWLIST: readonly CausalityAllowlistEntry[] = [
  {
    string: "These are the model's drivers, not a causal claim about the grid.",
    file: "apps/web/src/i18n/copy.en.ts",
    reason:
      "The driver-bars footnote. It uses 'causal' to refuse the causal reading of the bars above it, which is the disclaimer the boundary exists to require.",
  },
  {
    string: "São os drivers do modelo, não uma afirmação causal sobre a rede.",
    file: "apps/web/src/i18n/copy.pt.ts",
    reason:
      "The Portuguese driver-bars footnote — the same refusal, authored in the default locale rather than translated into it.",
  },
  {
    string:
      "Um driver que aumenta o risco não é causa de nenhum MWh cortado em particular.",
    file: "apps/web/src/i18n/copy.pt.ts",
    reason:
      "The Explain screen's share footnote, denying that an attributed share is the cause of any curtailed MWh. The English sibling of this sentence says 'is not a cause of', which trips no lemma; the Portuguese one has to say 'causa' to say the same thing.",
  },
];
