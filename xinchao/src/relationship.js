/**
 * Define the relationship subject used by generated heart-tide language.
 * Keep this source-level value centralized so labels, signals, and prompts
 * describe the same person instead of drifting across separate modules.
 */
export const RELATION_SUBJECT = '他';
export const RELATION_SELF = '汐';

/**
 * Return stable protocol roles and the display names used in prompts.
 *
 * @returns {{partner: string, self: string, partnerName: string, selfName: string}}
 */
export function relationExchangeLabels() {
  return {
    partner: 'user',
    self: 'assistant',
    partnerName: RELATION_SUBJECT,
    selfName: RELATION_SELF,
  };
}
