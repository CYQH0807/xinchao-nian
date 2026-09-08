/**
 * Define the relationship subject used by generated heart-tide language.
 * Keep this source-level value centralized so labels, signals, and prompts
 * describe the same person instead of drifting across separate modules.
 */
export const RELATION_SUBJECT = '他';

/**
 * Return the speaker labels used by the one-hop interaction exchange.
 * The two labels intentionally keep the current Chinese protocol shape while
 * making the relationship subject explicit at the source level.
 *
 * @returns {{partner: string, self: string}} Exchange speaker labels.
 */
export function relationExchangeLabels() {
  return {
    partner: `${RELATION_SUBJECT}说`,
    self: '他回',
  };
}
