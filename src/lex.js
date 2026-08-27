/**
 * The tokenizer, and it is deliberately not a parser.
 *
 * One regex, three alternatives: an identifier, a number, or a single non-space
 * character. No AST, no types, no language server, and therefore no per-language work —
 * the same lexer indexes JavaScript, TypeScript, JSON or anything else made of words and
 * punctuation. Being wrong about syntax costs nothing here, because nothing downstream
 * asks what a token *means*.
 *
 * String literals are split into their words rather than kept whole. That is a choice
 * with evidence behind it: a whole literal is one enormous vocabulary item that will
 * never be seen twice, while its words recur. Measured, indexing comments and strings
 * helps more often than it hurts — on code-only positions the identifier accuracy went
 * DOWN on 4 of 6 corpora.
 */

const TOKEN_RE = /[A-Za-z_]\w*|\d+|[^\w\s]/g;
const WORD_RE = /^[A-Za-z_]\w*$/;

/** Split source text into tokens. Returns a plain array of strings. */
export function lex(text) {
  return text.match(TOKEN_RE) || [];
}

/** Is this token an identifier-shaped word (as opposed to punctuation or a number)? */
export function isWord(token) {
  return WORD_RE.test(token);
}

/**
 * Split the text before a cursor into the completed tokens and the partial identifier
 * being typed, if any.
 *
 * `"const conf"` → { prev: ["const"], prefix: "conf" }
 * `"const conf "` → { prev: ["const", "conf"], prefix: null }
 *
 * The partial word must not go into `prev`: it is what we are predicting, not context.
 */
export function splitAtCursor(textBeforeCursor) {
  const tokens = lex(textBeforeCursor);
  if (tokens.length === 0) return { prev: [], prefix: null };

  const last = tokens[tokens.length - 1];
  // Only an identifier that runs right up to the cursor is a partial word. A trailing
  // space, or punctuation, means the previous token is complete.
  const endsFlush = textBeforeCursor.endsWith(last);
  if (endsFlush && WORD_RE.test(last)) {
    return { prev: tokens.slice(0, -1), prefix: last };
  }
  return { prev: tokens, prefix: null };
}
