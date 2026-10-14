/**
 * Scripted cases for the playground `submit_feedback` tool.
 *
 * Each case is one user message after the playground has already done some
 * work (echo a message). `expectedCall` is what an agent should pass.
 * `null` means the agent must not call the tool.
 *
 * These do not run an agent. The playground test applies every `expectedCall`
 * and checks the event. A host eval (see the playground README) is what
 * checks that an agent chooses the call on its own.
 */
import type { FeedbackReason } from '../../src/core/feedback-tool.js';

export interface FeedbackCall {
  helpful: boolean;
  reason?: FeedbackReason;
  /** True when the agent asked; false when the user volunteered the reaction. */
  solicited: boolean;
}

export interface FeedbackCase {
  id: string;
  /** What the user says. */
  utterance: string;
  /**
   * Follow-up the user gives after the agent asks what to record.
   * Only set when {@link askFirst} is true. `expectedCall` is that answer.
   */
  followUp?: string;
  /** The agent asks what to record before calling. */
  askFirst?: boolean;
  /**
   * Applies only after `submit_feedback` has already returned in this
   * conversation. The result text tells the agent not to ask again.
   */
  afterFeedback?: boolean;
  expectedCall: FeedbackCall | null;
}

export const FEEDBACK_CASES: readonly FeedbackCase[] = [
  {
    id: 'thanks-thats-it',
    utterance: "thanks, that's it",
    expectedCall: { helpful: true, solicited: false },
  },
  {
    id: 'perfect',
    utterance: 'perfect',
    expectedCall: { helpful: true, solicited: false },
  },
  {
    id: 'thats-wrong',
    utterance: "that's wrong",
    expectedCall: { helpful: false, reason: 'wrong_result', solicited: false },
  },
  {
    id: 'didnt-work',
    utterance: "this didn't work",
    expectedCall: { helpful: false, reason: 'other', solicited: false },
  },
  {
    id: 'file-feedback',
    utterance: 'file feedback',
    askFirst: true,
    followUp: 'it was wrong',
    expectedCall: { helpful: false, reason: 'wrong_result', solicited: true },
  },
  {
    id: 'neutral-follow-up',
    utterance: 'can you echo that again?',
    expectedCall: null,
  },
  {
    id: 'after-recorded',
    utterance: 'what was the message you echoed?',
    afterFeedback: true,
    expectedCall: null,
  },
];

/** Cases where the agent is expected to call `submit_feedback`. */
export function feedbackCasesThatCall(): readonly FeedbackCase[] {
  return FEEDBACK_CASES.filter((feedbackCase) => feedbackCase.expectedCall != null);
}
