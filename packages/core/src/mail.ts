/** Mailbox text rules, shared by server and viewer. Messages are untrusted text from strangers. */

export const MAIL_MAX_LENGTH = 280;

/** A small local list, matched as whole words (and simple leetspeak); no external service. */
const BLOCKED = ['fuck', 'fucking', 'shit', 'cunt', 'bitch', 'bastard', 'asshole', 'dick', 'wanker', 'whore', 'slut', 'nigger', 'faggot', 'retard', 'kys'];

const normalise = (s: string) =>
  s
    .toLowerCase()
    .replace(/[0@]/g, 'o')
    .replace(/[1!|]/g, 'i')
    .replace(/3/g, 'e')
    .replace(/[4]/g, 'a')
    .replace(/[5$]/g, 's')
    .replace(/7/g, 't');

/** Collapse whitespace (so a note can't add lines to a prompt) and trim. */
export function cleanMailText(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Undefined if the text is acceptable, else why not. */
export function mailTextProblem(text: string): string | undefined {
  const t = cleanMailText(text);
  if (!t) return 'the message is empty';
  if (t.length > MAIL_MAX_LENGTH) return `at most ${MAIL_MAX_LENGTH} characters`;
  const words = normalise(t).split(/[^a-z]+/);
  if (words.some((w) => BLOCKED.includes(w))) return 'please keep it friendly (the message was filtered)';
  return undefined;
}

/**
 * How a note reaches a mind or a prompt: always inside quotes, JSON-escaped, labelled as a
 * stranger's words. It is data, never instructions.
 */
export function quoteNote(text: string): string {
  return JSON.stringify(cleanMailText(text).slice(0, MAIL_MAX_LENGTH));
}
